import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, isAuthed, isRateLimited } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";
import { Storage } from "@google-cloud/storage";

const ALLOWED_TYPES = new Set([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/msword",
  "image/jpeg",
  "image/png",
  "image/webp",
  "text/plain",
]);

const MAX_SIZE = 10 * 1024 * 1024; // 10 MB

function getStorage(): Storage | null {
  const b64 = process.env.GCP_SERVICE_ACCOUNT_KEY;
  if (b64) {
    try {
      const json = JSON.parse(Buffer.from(b64, "base64").toString("utf-8"));
      return new Storage({ credentials: json, projectId: json.project_id });
    } catch { /* fall through */ }
  }
  try {
    return new Storage();
  } catch {
    return null;
  }
}

export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (!isAuthed(auth)) return auth.error;

  if (isRateLimited(auth.userId)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  const bucketName = process.env.GCS_BUCKET;
  if (!bucketName) {
    return NextResponse.json({ error: "GCS_BUCKET not configured" }, { status: 503 });
  }

  const storage = getStorage();
  if (!storage) {
    return NextResponse.json({ error: "GCS credentials not available" }, { status: 503 });
  }

  const formData = await req.formData();
  const file = formData.get("file") as File | null;
  const applicationIdStr = formData.get("application_id") as string | null;

  if (!file || !applicationIdStr) {
    return NextResponse.json(
      { error: "file and application_id are required" },
      { status: 400 },
    );
  }

  const applicationId = parseInt(applicationIdStr, 10);
  if (isNaN(applicationId) || applicationId <= 0) {
    return NextResponse.json({ error: "Invalid application_id" }, { status: 400 });
  }

  if (!ALLOWED_TYPES.has(file.type)) {
    return NextResponse.json(
      { error: `Unsupported file type: ${file.type}. Allowed: PDF, DOCX, DOC, images, text` },
      { status: 400 },
    );
  }

  if (file.size > MAX_SIZE) {
    return NextResponse.json(
      { error: `File too large (${(file.size / 1024 / 1024).toFixed(1)} MB). Max 10 MB.` },
      { status: 400 },
    );
  }

  try {
    const supa = createServiceClient();

    // Verify application exists
    const { data: app, error: appErr } = await supa
      .from("job_applications")
      .select("id, role_bucket")
      .eq("id", applicationId)
      .single();

    if (appErr || !app) {
      return NextResponse.json({ error: "Application not found" }, { status: 404 });
    }

    // Upload to GCS
    const roleBucket = app.role_bucket ?? "other";
    const timestamp = Date.now();
    const safeFilename = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
    const gcsKey = `job-apps/${roleBucket}/manual-${applicationId}/${timestamp}-${safeFilename}`;

    const bucket = storage.bucket(bucketName);
    const blob = bucket.file(gcsKey);

    const buffer = Buffer.from(await file.arrayBuffer());
    await blob.save(buffer, {
      contentType: file.type,
      metadata: {
        originalFilename: file.name,
        uploadedBy: auth.userId,
      },
    });

    // Create file record in Supabase
    const { data: fileRow, error: fileErr } = await supa
      .from("job_application_files")
      .insert({
        application_id: applicationId,
        message_id: `manual-upload-${timestamp}`,
        filename: file.name,
        content_type: file.type,
        size_bytes: file.size,
        gcs_bucket: bucketName,
        gcs_key: gcsKey,
      })
      .select("id")
      .single();

    if (fileErr) {
      console.error("[upload-resume] Failed to create file record:", fileErr);
      return NextResponse.json({ error: "Failed to save file record" }, { status: 500 });
    }

    return NextResponse.json({
      ok: true,
      file_id: fileRow.id,
      gcs_key: gcsKey,
      filename: file.name,
    });
  } catch (err) {
    console.error("[upload-resume] Error:", err);
    return NextResponse.json({ error: "Upload failed" }, { status: 500 });
  }
}
