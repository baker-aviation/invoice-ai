import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";

// ── Types ────────────────────────────────────────────────────────────────────

type FileAttachment = {
  name: string;
  category: string; // "resume" | "drivers_license" | "medical" | "pilot_cert_front" | "pilot_cert_back"
  mimeType: string;
  base64: string;
};

type FormIntakePayload = {
  timestamp: string;
  first_name: string;
  last_name: string;
  email: string;
  phone: string;
  address: string;
  nearest_airport: string;
  second_airport: string;
  certificate_level: string;
  total_time: number | null;
  total_time_airplane: number | null;
  total_time_me_turbine: number | null;
  total_pic_time: number | null;
  has_ce750_type: boolean;
  has_cl30_type: boolean;
  typed_hours_last_12mo: string;
  last_sim_training: string;
  other_type_ratings: string;
  has_first_class_medical: boolean;
  has_special_issuance: boolean;
  medical_issued: string;
  medical_expires: string;
  has_prd_access: string;
  has_accidents: string;
  has_training_agreement: string;
  training_agreement_owe: string;
  available_start: string;
  position_applying_for: string;
  files?: FileAttachment[];
};

// ── Rate limiting (simple in-memory) ─────────────────────────────────────────

const ipHits = new Map<string, number[]>();

function isIpRateLimited(ip: string): boolean {
  const now = Date.now();
  const window = 60_000;
  const max = 20;
  const hits = (ipHits.get(ip) ?? []).filter((t) => now - t < window);
  if (hits.length >= max) {
    ipHits.set(ip, hits);
    return true;
  }
  hits.push(now);
  ipHits.set(ip, hits);
  return false;
}

function getIp(req: NextRequest): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function parseTypeRatings(raw: string): string[] {
  if (!raw || !raw.trim()) return [];
  return raw
    .split(/[,\/]|\band\b/i)
    .map((s) => s.trim())
    .filter(Boolean);
}

function mapCategory(position: string): string {
  const p = (position ?? "").toLowerCase();
  if (p.includes("pic") || p.includes("captain")) return "pilot_pic";
  if (p.includes("sic") || p.includes("first officer") || p.includes("fo"))
    return "pilot_sic";
  return "other";
}

function computeSoftGatePicStatus(
  totalTime: number | null,
  picTime: number | null,
): string {
  const tt = totalTime ?? 0;
  const pt = picTime ?? 0;
  if (tt >= 3000 && pt >= 1500) return "pass";
  if (tt >= 2500 || pt >= 1200) return "close";
  return "fail";
}

function extFromMime(mimeType: string): string {
  const map: Record<string, string> = {
    "application/pdf": "pdf",
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/gif": "gif",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
      "docx",
    "application/msword": "doc",
    "text/plain": "txt",
  };
  return map[mimeType] ?? "bin";
}

// ── GCS upload helper (mirrors /api/jobs/[id]/attach pattern) ────────────────

async function uploadToGcs(
  applicationId: number,
  file: FileAttachment,
): Promise<{ gcsKey: string; bucketName: string; sizeBytes: number }> {
  const { Storage } = await import("@google-cloud/storage");
  let storage: InstanceType<typeof Storage>;

  const b64Key = process.env.GCP_SERVICE_ACCOUNT_KEY;
  if (b64Key) {
    const creds = JSON.parse(Buffer.from(b64Key, "base64").toString("utf-8"));
    storage = new Storage({ credentials: creds, projectId: creds.project_id });
  } else {
    storage = new Storage();
  }

  const bucketName = process.env.GCS_BUCKET || "baker-aviation-invoice-pdfs";
  const bucket = storage.bucket(bucketName);

  const ts = Date.now();
  const ext = extFromMime(file.mimeType);
  const safeCat = file.category.replace(/[^a-z0-9_-]/gi, "_");
  const gcsKey = `job-apps/pilot/form-intake/${applicationId}/${safeCat}-${ts}.${ext}`;

  const buffer = Buffer.from(file.base64, "base64");

  const blob = bucket.file(gcsKey);
  await blob.save(buffer, {
    contentType: file.mimeType || "application/octet-stream",
  });

  return { gcsKey, bucketName, sizeBytes: buffer.length };
}

// ── POST handler ─────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  // Rate limit by IP
  if (isIpRateLimited(getIp(req))) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  // Shared secret check
  const secret = req.headers.get("x-intake-secret");
  if (!secret || secret !== process.env.FORM_INTAKE_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: FormIntakePayload;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // Basic validation
  const firstName = String(body.first_name ?? "").trim();
  const lastName = String(body.last_name ?? "").trim();
  const email = String(body.email ?? "").trim().toLowerCase();

  if (!firstName || !lastName) {
    return NextResponse.json(
      { error: "first_name and last_name are required" },
      { status: 400 },
    );
  }
  if (!email) {
    return NextResponse.json({ error: "email is required" }, { status: 400 });
  }

  const candidateName = `${firstName} ${lastName}`;
  const category = mapCategory(body.position_applying_for ?? "");
  const totalTime = body.total_time ?? null;
  const picTime = body.total_pic_time ?? null;
  const turbineTime = body.total_time_me_turbine ?? null;
  const typeRatings = parseTypeRatings(body.other_type_ratings ?? "");
  const softGatePicStatus = computeSoftGatePicStatus(totalTime, picTime);

  const infoSessionData: Record<string, unknown> = {
    nearest_airport: body.nearest_airport ?? "",
    second_airport: body.second_airport ?? "",
    certificate_level: body.certificate_level ?? "",
    total_time_airplane: body.total_time_airplane ?? null,
    has_first_class_medical: body.has_first_class_medical ?? false,
    has_special_issuance: body.has_special_issuance ?? false,
    medical_issued: body.medical_issued ?? "",
    medical_expires: body.medical_expires ?? "",
    has_prd_access: body.has_prd_access ?? "",
    has_accidents: body.has_accidents ?? "",
    has_training_agreement: body.has_training_agreement ?? "",
    training_agreement_owe: body.training_agreement_owe ?? "",
    available_start: body.available_start ?? "",
    typed_hours_last_12mo: body.typed_hours_last_12mo ?? "",
    last_sim_training: body.last_sim_training ?? "",
    form_timestamp: body.timestamp ?? new Date().toISOString(),
  };

  try {
    const supa = createServiceClient();

    // Check for existing candidate by email
    const { data: existing } = await supa
      .from("job_application_parse")
      .select("id, application_id")
      .ilike("email", email)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    let applicationId: number;
    let parseId: number;

    if (existing) {
      // ── Update existing candidate ──────────────────────────────────────
      applicationId = existing.application_id;
      parseId = existing.id;

      const { error: updateErr } = await supa
        .from("job_application_parse")
        .update({
          candidate_name: candidateName,
          phone: body.phone ?? null,
          location: body.address ?? null,
          total_time_hours: totalTime,
          pic_time_hours: picTime,
          turbine_time_hours: turbineTime,
          has_citation_x: body.has_ce750_type ?? false,
          has_challenger_300_type_rating: body.has_cl30_type ?? false,
          type_ratings: typeRatings.length > 0 ? typeRatings : null,
          category,
          soft_gate_pic_status: softGatePicStatus,
          info_session_data: infoSessionData,
          updated_at: new Date().toISOString(),
        })
        .eq("id", existing.id);

      if (updateErr) {
        console.error("[form-intake] Update failed:", updateErr);
        return NextResponse.json(
          { error: `Update failed: ${updateErr.message}` },
          { status: 500 },
        );
      }
    } else {
      // ── Create new candidate ───────────────────────────────────────────
      const { data: appRow, error: appErr } = await supa
        .from("job_applications")
        .insert({
          mailbox: "google-form-intake",
          role_bucket: category,
          subject: `Google Form: ${candidateName}`,
          received_at: new Date().toISOString(),
          source_message_id: `form-intake-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
        })
        .select("id")
        .single();

      if (appErr || !appRow) {
        console.error("[form-intake] Failed to create application:", appErr);
        return NextResponse.json(
          { error: `Failed to create application: ${appErr?.message ?? "unknown"}` },
          { status: 500 },
        );
      }

      applicationId = appRow.id;

      const { data: parseRow, error: parseErr } = await supa
        .from("job_application_parse")
        .insert({
          application_id: appRow.id,
          candidate_name: candidateName,
          email,
          phone: body.phone ?? null,
          location: body.address ?? null,
          total_time_hours: totalTime,
          pic_time_hours: picTime,
          turbine_time_hours: turbineTime,
          has_citation_x: body.has_ce750_type ?? false,
          has_challenger_300_type_rating: body.has_cl30_type ?? false,
          type_ratings: typeRatings.length > 0 ? typeRatings : null,
          category,
          pipeline_stage: "prd_faa_review",
          soft_gate_pic_status: softGatePicStatus,
          info_session_data: infoSessionData,
          model: "google-form-intake",
        })
        .select("id")
        .single();

      if (parseErr || !parseRow) {
        console.error("[form-intake] Failed to create parse row:", parseErr);
        return NextResponse.json(
          { error: `Failed to create candidate: ${parseErr?.message ?? "unknown"}` },
          { status: 500 },
        );
      }

      parseId = parseRow.id;
    }

    // ── Handle file attachments ────────────────────────────────────────────
    const uploadedFiles: string[] = [];

    if (body.files && Array.isArray(body.files) && body.files.length > 0) {
      for (const file of body.files) {
        if (!file.base64 || !file.name) continue;

        try {
          const { gcsKey, bucketName, sizeBytes } = await uploadToGcs(
            applicationId,
            file,
          );

          const { error: fileErr } = await supa
            .from("job_application_files")
            .insert({
              application_id: applicationId,
              message_id: `form-intake-${Date.now()}`,
              filename: file.name,
              content_type: file.mimeType || "application/octet-stream",
              gcs_bucket: bucketName,
              gcs_key: gcsKey,
              size_bytes: sizeBytes,
              file_category: file.category || "resume",
            });

          if (fileErr) {
            console.error(
              `[form-intake] Failed to save file record for ${file.name}:`,
              fileErr,
            );
          } else {
            uploadedFiles.push(gcsKey);
          }
        } catch (uploadErr) {
          console.error(
            `[form-intake] GCS upload failed for ${file.name}:`,
            uploadErr,
          );
          // Continue with other files — don't fail the whole request
        }
      }
    }

    return NextResponse.json({
      ok: true,
      matched: !!existing,
      application_id: applicationId,
      parse_id: parseId,
      files_uploaded: uploadedFiles.length,
    });
  } catch (err) {
    console.error("[form-intake] Error:", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
