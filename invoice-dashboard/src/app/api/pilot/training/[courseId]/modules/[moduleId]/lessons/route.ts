import { NextRequest, NextResponse } from "next/server";
import { requireAuth, requireAdmin, isAuthed, isRateLimited } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";

/**
 * GET /api/pilot/training/[courseId]/modules/[moduleId]/lessons — list lessons
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ courseId: string; moduleId: string }> },
) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;

  const { moduleId } = await params;
  const id = Number(moduleId);
  if (!id || isNaN(id)) {
    return NextResponse.json({ error: "Invalid module ID" }, { status: 400 });
  }

  const supa = createServiceClient();
  const { data, error } = await supa
    .from("lms_lessons")
    .select("*")
    .eq("module_id", id)
    .order("sort_order", { ascending: true });

  if (error) {
    return NextResponse.json({ error: "Database operation failed" }, { status: 500 });
  }

  return NextResponse.json({ lessons: data });
}

/**
 * POST /api/pilot/training/[courseId]/modules/[moduleId]/lessons — create lesson (admin only)
 * Supports optional GCS presigned upload URL for video/document.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ courseId: string; moduleId: string }> },
) {
  const auth = await requireAdmin(req);
  if ("error" in auth) return auth.error;

  if (isRateLimited(auth.userId, 10)) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const { moduleId } = await params;
  const modId = Number(moduleId);
  if (!modId || isNaN(modId)) {
    return NextResponse.json({ error: "Invalid module ID" }, { status: 400 });
  }

  let body: {
    title?: string;
    lesson_type?: string;
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

  const title = body.title?.trim();
  if (!title) {
    return NextResponse.json({ error: "Title is required" }, { status: 400 });
  }

  const lessonType = body.lesson_type?.trim();
  if (!lessonType || !["video", "document", "quiz", "text"].includes(lessonType)) {
    return NextResponse.json({ error: "Invalid lesson_type" }, { status: 400 });
  }

  const insert: Record<string, unknown> = {
    module_id: modId,
    title,
    lesson_type: lessonType,
    content_html: body.content_html?.trim() || null,
    sort_order: body.sort_order ?? 0,
  };

  let uploadUrl: string | null = null;

  // Handle video presign
  const videoFilename = body.video_filename?.trim();
  if (videoFilename && lessonType === "video") {
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
      insert.video_gcs_bucket = gcsBucket;
      insert.video_gcs_key = gcsKey;
      insert.video_filename = videoFilename;
    } catch (err) {
      console.error("[lms/lessons] video presign error:", err);
      return NextResponse.json(
        { error: "Failed to prepare video upload" },
        { status: 500 },
      );
    }
  }

  // Handle document presign
  const docFilename = body.doc_filename?.trim();
  if (docFilename && lessonType === "document") {
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
      insert.doc_gcs_bucket = gcsBucket;
      insert.doc_gcs_key = gcsKey;
      insert.doc_filename = docFilename;
    } catch (err) {
      console.error("[lms/lessons] doc presign error:", err);
      return NextResponse.json(
        { error: "Failed to prepare document upload" },
        { status: 500 },
      );
    }
  }

  const supa = createServiceClient();
  const { data, error } = await supa
    .from("lms_lessons")
    .insert(insert)
    .select("*")
    .single();

  if (error) {
    return NextResponse.json({ error: "Database operation failed" }, { status: 500 });
  }

  return NextResponse.json({ lesson: data, upload_url: uploadUrl }, { status: 201 });
}
