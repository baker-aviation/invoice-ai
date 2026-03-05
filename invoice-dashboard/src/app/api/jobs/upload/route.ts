import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { requireAdmin, isRateLimited } from "@/lib/api-auth";

/**
 * POST /api/jobs/upload — upload a resume file for parsing
 *
 * Accepts multipart form data:
 *   - file: the resume file (PDF/DOCX)
 *   - candidate_name: optional candidate name
 *   - role_bucket: optional role bucket (default: "other")
 *   - file_category: optional file category (default: "resume")
 *
 * Flow:
 *   1. Upload file to GCS
 *   2. Create job_applications row
 *   3. Create job_application_files row
 *   4. Trigger parse via job-parse service
 */
export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if ("error" in auth) return auth.error;
  if (isRateLimited(auth.userId, 10)) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return NextResponse.json({ error: "Invalid form data" }, { status: 400 });
  }

  const file = formData.get("file") as File | null;
  if (!file) {
    return NextResponse.json({ error: "file is required" }, { status: 400 });
  }

  // Validate file type
  const allowedTypes = [
    "application/pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/msword",
    "text/plain",
  ];
  if (!allowedTypes.includes(file.type) && !file.name.match(/\.(pdf|docx|doc|txt)$/i)) {
    return NextResponse.json({ error: "Only PDF, DOCX, DOC, and TXT files are allowed" }, { status: 400 });
  }

  // Max 20MB
  if (file.size > 20 * 1024 * 1024) {
    return NextResponse.json({ error: "File too large (max 20MB)" }, { status: 400 });
  }

  const candidateName = (formData.get("candidate_name") as string)?.trim() || null;
  const roleBucket = (formData.get("role_bucket") as string)?.trim() || "other";
  const fileCategory = (formData.get("file_category") as string)?.trim() || "resume";

  try {
    const supa = createServiceClient();

    // 1. Create job_applications row
    const sourceId = `manual-upload-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const { data: appRow, error: appErr } = await supa
      .from("job_applications")
      .insert({
        mailbox: "manual-upload",
        role_bucket: roleBucket,
        subject: candidateName ? `Manual upload: ${candidateName}` : `Manual upload: ${file.name}`,
        received_at: new Date().toISOString(),
        source_message_id: sourceId,
      })
      .select("id")
      .single();

    if (appErr || !appRow) {
      console.error("[jobs/upload] Failed to create application:", appErr);
      return NextResponse.json({ error: "Failed to create application" }, { status: 500 });
    }

    const applicationId = appRow.id;

    // 2. Upload to GCS
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

    const safeName = file.name.replace(/\//g, "_");
    const gcsKey = `job-apps/${roleBucket}/manual/${sourceId}/${safeName}`;

    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    const blob = bucket.file(gcsKey);
    await blob.save(buffer, {
      contentType: file.type || "application/octet-stream",
    });

    // 3. Create file row
    const { error: fileErr } = await supa
      .from("job_application_files")
      .insert({
        application_id: applicationId,
        message_id: sourceId,
        filename: file.name,
        content_type: file.type || "application/octet-stream",
        gcs_bucket: bucketName,
        gcs_key: gcsKey,
        size_bytes: buffer.length,
        file_category: fileCategory,
      });

    if (fileErr) {
      console.error("[jobs/upload] Failed to create file row:", fileErr);
      return NextResponse.json({ error: "Failed to save file record" }, { status: 500 });
    }

    // 4. Trigger parse (best-effort — don't fail the upload if parse fails)
    let parseResult = null;
    if (fileCategory === "resume") {
      try {
        const jobApiBase = process.env.JOB_API_BASE_URL;
        if (jobApiBase) {
          const parseUrl = `${jobApiBase}/jobs/parse_application?application_id=${applicationId}`;
          const parseRes = await fetch(parseUrl, { method: "POST", signal: AbortSignal.timeout(60000) });
          if (parseRes.ok) {
            parseResult = await parseRes.json();
          } else {
            console.warn("[jobs/upload] Parse failed:", parseRes.status, await parseRes.text().catch(() => ""));
          }
        }
      } catch (e) {
        console.warn("[jobs/upload] Parse request failed:", e);
      }
    }

    return NextResponse.json({
      ok: true,
      application_id: applicationId,
      gcs_key: gcsKey,
      parsed: parseResult != null,
    });
  } catch (err) {
    console.error("[jobs/upload] Error:", err);
    return NextResponse.json({ error: "Upload failed" }, { status: 500 });
  }
}
