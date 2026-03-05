import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { requireAdmin, isRateLimited } from "@/lib/api-auth";

/**
 * POST /api/jobs/[id]/attach — attach a file to an existing candidate profile
 *
 * [id] = application_id (from job_applications table)
 *
 * Accepts multipart form data:
 *   - file: the document (PDF/DOCX/DOC/TXT)
 *   - file_category: resume | lor | cover_letter | other
 *   - parse_id: the parse row id (needed for LOR linking)
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAdmin(req);
  if ("error" in auth) return auth.error;
  if (isRateLimited(auth.userId, 10)) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const { id } = await params;
  const applicationId = Number(id);
  if (!applicationId || isNaN(applicationId)) {
    return NextResponse.json({ error: "Invalid application ID" }, { status: 400 });
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

  const allowedTypes = [
    "application/pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/msword",
    "text/plain",
  ];
  if (!allowedTypes.includes(file.type) && !file.name.match(/\.(pdf|docx|doc|txt)$/i)) {
    return NextResponse.json({ error: "Only PDF, DOCX, DOC, and TXT files are allowed" }, { status: 400 });
  }

  if (file.size > 20 * 1024 * 1024) {
    return NextResponse.json({ error: "File too large (max 20MB)" }, { status: 400 });
  }

  const fileCategory = (formData.get("file_category") as string)?.trim() || "resume";
  const parseId = formData.get("parse_id") ? Number(formData.get("parse_id")) : null;

  try {
    const supa = createServiceClient();

    // Verify the application exists
    const { data: app } = await supa
      .from("job_applications")
      .select("id, role_bucket")
      .eq("id", applicationId)
      .single();

    if (!app) {
      return NextResponse.json({ error: "Application not found" }, { status: 404 });
    }

    // Upload to GCS
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
    const ts = Date.now();
    const gcsKey = `job-apps/${app.role_bucket}/attach/${applicationId}/${ts}-${safeName}`;

    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    const blob = bucket.file(gcsKey);
    await blob.save(buffer, {
      contentType: file.type || "application/octet-stream",
    });

    // Create file row linked to existing application
    const insertData: Record<string, unknown> = {
      application_id: applicationId,
      message_id: `attach-${ts}`,
      filename: file.name,
      content_type: file.type || "application/octet-stream",
      gcs_bucket: bucketName,
      gcs_key: gcsKey,
      size_bytes: buffer.length,
      file_category: fileCategory,
    };

    // Link LORs to the candidate's parse row
    if (fileCategory === "lor" && parseId) {
      insertData.linked_parse_id = parseId;
    }

    const { error: fileErr } = await supa
      .from("job_application_files")
      .insert(insertData);

    if (fileErr) {
      console.error("[jobs/attach] Failed to create file row:", fileErr);
      return NextResponse.json({ error: "Failed to save file record" }, { status: 500 });
    }

    return NextResponse.json({ ok: true, gcs_key: gcsKey });
  } catch (err) {
    console.error("[jobs/attach] Error:", err);
    return NextResponse.json({ error: "Upload failed" }, { status: 500 });
  }
}
