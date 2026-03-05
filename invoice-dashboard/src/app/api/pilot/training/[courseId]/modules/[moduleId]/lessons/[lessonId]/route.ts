import { NextRequest, NextResponse } from "next/server";
import { requireAuth, requireAdmin, isAuthed, isRateLimited } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";
import { signGcsUrl } from "@/lib/gcs";

type RouteParams = { courseId: string; moduleId: string; lessonId: string };

/**
 * GET /api/pilot/training/[courseId]/modules/[moduleId]/lessons/[lessonId]
 * Returns lesson with signed GCS URLs for video/document.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<RouteParams> },
) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;

  const { lessonId } = await params;
  const id = Number(lessonId);
  if (!id || isNaN(id)) {
    return NextResponse.json({ error: "Invalid lesson ID" }, { status: 400 });
  }

  const supa = createServiceClient();
  const { data: lesson, error } = await supa
    .from("lms_lessons")
    .select("*")
    .eq("id", id)
    .single();

  if (error || !lesson) {
    return NextResponse.json({ error: "Lesson not found" }, { status: 404 });
  }

  let videoUrl: string | null = null;
  let docUrl: string | null = null;

  if (lesson.video_gcs_bucket && lesson.video_gcs_key) {
    videoUrl = await signGcsUrl(lesson.video_gcs_bucket, lesson.video_gcs_key);
  }
  if (lesson.doc_gcs_bucket && lesson.doc_gcs_key) {
    docUrl = await signGcsUrl(lesson.doc_gcs_bucket, lesson.doc_gcs_key);
  }

  return NextResponse.json({ lesson, video_url: videoUrl, doc_url: docUrl });
}

/**
 * PATCH /api/pilot/training/[courseId]/modules/[moduleId]/lessons/[lessonId]
 * Update lesson (admin only)
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<RouteParams> },
) {
  const auth = await requireAdmin(req);
  if ("error" in auth) return auth.error;

  if (isRateLimited(auth.userId, 10)) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const { lessonId } = await params;
  const id = Number(lessonId);
  if (!id || isNaN(id)) {
    return NextResponse.json({ error: "Invalid lesson ID" }, { status: 400 });
  }

  let body: {
    title?: string;
    content_html?: string;
    sort_order?: number;
    video_filename?: string;
    doc_filename?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const updates: Record<string, unknown> = {};
  if (body.title !== undefined) {
    const title = body.title.trim();
    if (!title) return NextResponse.json({ error: "Title cannot be empty" }, { status: 400 });
    updates.title = title;
  }
  if (body.content_html !== undefined) updates.content_html = body.content_html;
  if (body.sort_order !== undefined) updates.sort_order = body.sort_order;

  let uploadUrl: string | null = null;

  // Handle video presign on PATCH
  const videoFilename = body.video_filename?.trim();
  if (videoFilename) {
    try {
      const { Storage } = await import("@google-cloud/storage");
      let storage: InstanceType<typeof Storage>;
      const b64Key = process.env.GCP_SERVICE_ACCOUNT_KEY;
      if (b64Key) {
        const creds = JSON.parse(Buffer.from(b64Key, "base64").toString("utf-8"));
        storage = new Storage({ credentials: creds, projectId: creds.project_id });
      } else {
        storage = new Storage();
      }

      const gcsBucket = process.env.GCS_BUCKET || "baker-aviation-invoice-pdfs";
      const safeName = videoFilename.replace(/\//g, "_");
      const gcsKey = `lms/videos/${Date.now()}-${safeName}`;

      const ext = videoFilename.split(".").pop()?.toLowerCase();
      const contentType =
        ext === "mp4" ? "video/mp4" : ext === "m4v" ? "video/x-m4v" : "video/quicktime";

      const [url] = await storage.bucket(gcsBucket).file(gcsKey).getSignedUrl({
        version: "v4",
        action: "write",
        expires: Date.now() + 30 * 60 * 1000,
        contentType,
      });
      uploadUrl = url;
      updates.video_gcs_bucket = gcsBucket;
      updates.video_gcs_key = gcsKey;
      updates.video_filename = videoFilename;
    } catch (err) {
      console.error("[lms/lessons] video presign error:", err);
      return NextResponse.json(
        { error: `Failed to prepare video upload: ${err instanceof Error ? err.message : err}` },
        { status: 500 },
      );
    }
  }

  // Handle document presign on PATCH
  const docFilename = body.doc_filename?.trim();
  if (docFilename) {
    try {
      const { Storage } = await import("@google-cloud/storage");
      let storage: InstanceType<typeof Storage>;
      const b64Key = process.env.GCP_SERVICE_ACCOUNT_KEY;
      if (b64Key) {
        const creds = JSON.parse(Buffer.from(b64Key, "base64").toString("utf-8"));
        storage = new Storage({ credentials: creds, projectId: creds.project_id });
      } else {
        storage = new Storage();
      }

      const gcsBucket = process.env.GCS_BUCKET || "baker-aviation-invoice-pdfs";
      const safeName = docFilename.replace(/\//g, "_");
      const gcsKey = `lms/documents/${Date.now()}-${safeName}`;

      const ext = docFilename.split(".").pop()?.toLowerCase();
      const contentType =
        ext === "pdf" ? "application/pdf"
        : ext === "docx" ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        : "application/octet-stream";

      const [url] = await storage.bucket(gcsBucket).file(gcsKey).getSignedUrl({
        version: "v4",
        action: "write",
        expires: Date.now() + 30 * 60 * 1000,
        contentType,
      });
      uploadUrl = url;
      updates.doc_gcs_bucket = gcsBucket;
      updates.doc_gcs_key = gcsKey;
      updates.doc_filename = docFilename;
    } catch (err) {
      console.error("[lms/lessons] doc presign error:", err);
      return NextResponse.json(
        { error: `Failed to prepare document upload: ${err instanceof Error ? err.message : err}` },
        { status: 500 },
      );
    }
  }

  if (Object.keys(updates).length === 0 && !uploadUrl) {
    return NextResponse.json({ error: "No fields to update" }, { status: 400 });
  }

  updates.updated_at = new Date().toISOString();

  const supa = createServiceClient();
  const { data, error } = await supa
    .from("lms_lessons")
    .update(updates)
    .eq("id", id)
    .select("*")
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ lesson: data, upload_url: uploadUrl });
}

/**
 * DELETE /api/pilot/training/[courseId]/modules/[moduleId]/lessons/[lessonId]
 */
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<RouteParams> },
) {
  const auth = await requireAdmin(req);
  if ("error" in auth) return auth.error;

  if (isRateLimited(auth.userId, 10)) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const { lessonId } = await params;
  const id = Number(lessonId);
  if (!id || isNaN(id)) {
    return NextResponse.json({ error: "Invalid lesson ID" }, { status: 400 });
  }

  const supa = createServiceClient();
  const { error } = await supa.from("lms_lessons").delete().eq("id", id);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
