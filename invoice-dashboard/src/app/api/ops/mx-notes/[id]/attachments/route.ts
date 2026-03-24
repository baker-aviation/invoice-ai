import { NextRequest, NextResponse } from "next/server";
import { requireAuth, requireAdmin, isAuthed, isRateLimited } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";
import { signGcsUrl } from "@/lib/gcs";
import { presignUpload, contentTypeForExt } from "@/lib/gcs-upload";

type RouteCtx = { params: Promise<{ id: string }> };

/**
 * GET /api/ops/mx-notes/[id]/attachments — list attachments with signed URLs
 */
export async function GET(req: NextRequest, { params }: RouteCtx) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;

  const { id } = await params;

  const supa = createServiceClient();
  const { data, error } = await supa
    .from("mx_note_attachments")
    .select("id, filename, content_type, gcs_bucket, gcs_key, created_at")
    .eq("alert_id", id)
    .order("created_at");

  if (error) {
    console.error("[ops/mx-notes/attachments] list error:", error);
    return NextResponse.json({ error: "Failed to list attachments" }, { status: 500 });
  }

  const attachments = await Promise.all(
    (data ?? []).map(async (a) => {
      const url = await signGcsUrl(a.gcs_bucket, a.gcs_key);
      return {
        id: a.id,
        filename: a.filename,
        content_type: a.content_type,
        url,
      };
    }),
  );

  return NextResponse.json({ attachments });
}

/**
 * POST /api/ops/mx-notes/[id]/attachments — presign upload + insert row
 * JSON body: { filename }
 */
export async function POST(req: NextRequest, { params }: RouteCtx) {
  const auth = await requireAdmin(req);
  if ("error" in auth) return auth.error;

  if (await isRateLimited(auth.userId, 20)) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const { id } = await params;

  let body: { filename?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const filename = body.filename?.trim();
  if (!filename) {
    return NextResponse.json({ error: "filename is required" }, { status: 400 });
  }

  // Verify the alert exists
  const supa = createServiceClient();
  const { data: alert, error: aErr } = await supa
    .from("ops_alerts")
    .select("id")
    .eq("id", id)
    .eq("alert_type", "MX_NOTE")
    .single();

  if (aErr || !alert) {
    return NextResponse.json({ error: "MX note not found" }, { status: 404 });
  }

  let upload: Awaited<ReturnType<typeof presignUpload>>;
  try {
    upload = await presignUpload(filename, `mx-notes/${id}`);
  } catch (err) {
    console.error("[ops/mx-notes/attachments] presign error:", err);
    return NextResponse.json({ error: "Failed to prepare upload" }, { status: 500 });
  }

  const ext = filename.split(".").pop()?.toLowerCase();
  const contentType = contentTypeForExt(ext);

  const { data: attachment, error: dbErr } = await supa
    .from("mx_note_attachments")
    .insert({
      alert_id: id,
      filename,
      content_type: contentType,
      gcs_bucket: upload.bucket,
      gcs_key: upload.key,
    })
    .select("id, filename, content_type, created_at")
    .single();

  if (dbErr) {
    console.error("[ops/mx-notes/attachments] insert error:", dbErr);
    return NextResponse.json({ error: "Failed to create attachment" }, { status: 500 });
  }

  return NextResponse.json({ attachment, upload_url: upload.url }, { status: 201 });
}

/**
 * DELETE /api/ops/mx-notes/[id]/attachments?attachment_id=N — remove attachment
 */
export async function DELETE(req: NextRequest, { params }: RouteCtx) {
  const auth = await requireAdmin(req);
  if ("error" in auth) return auth.error;

  if (await isRateLimited(auth.userId, 20)) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const { id } = await params;
  const attachmentId = Number(req.nextUrl.searchParams.get("attachment_id"));
  if (!attachmentId || isNaN(attachmentId)) {
    return NextResponse.json({ error: "attachment_id query param is required" }, { status: 400 });
  }

  const supa = createServiceClient();
  const { error } = await supa
    .from("mx_note_attachments")
    .delete()
    .eq("id", attachmentId)
    .eq("alert_id", id);

  if (error) {
    console.error("[ops/mx-notes/attachments] delete error:", error);
    return NextResponse.json({ error: "Failed to delete attachment" }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
