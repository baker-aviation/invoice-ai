import { NextRequest, NextResponse } from "next/server";
import { requireAuth, requireAdmin, isAuthed, isRateLimited } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";
import { signGcsUrl } from "@/lib/gcs";
import { presignUpload, contentTypeForExt } from "@/lib/gcs-upload";

type RouteCtx = { params: Promise<{ id: string }> };

function parseBulletinId(id: string): number | null {
  const n = Number(id);
  return n && !isNaN(n) ? n : null;
}

/**
 * GET /api/pilot/bulletins/[id]/attachments — list attachments with signed URLs
 */
export async function GET(req: NextRequest, { params }: RouteCtx) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;

  const { id } = await params;
  const bulletinId = parseBulletinId(id);
  if (!bulletinId) {
    return NextResponse.json({ error: "Invalid bulletin ID" }, { status: 400 });
  }

  const supa = createServiceClient();
  const { data, error } = await supa
    .from("pilot_bulletin_attachments")
    .select("id, filename, content_type, gcs_bucket, gcs_key, sort_order, created_at")
    .eq("bulletin_id", bulletinId)
    .order("sort_order");

  if (error) {
    console.error("[pilot/bulletins/attachments] list error:", error);
    return NextResponse.json({ error: "Failed to list attachments" }, { status: 500 });
  }

  // Sign URLs for each attachment
  const attachments = await Promise.all(
    (data ?? []).map(async (a) => {
      const url = await signGcsUrl(a.gcs_bucket, a.gcs_key);
      return {
        id: a.id,
        filename: a.filename,
        content_type: a.content_type,
        sort_order: a.sort_order,
        url,
      };
    }),
  );

  return NextResponse.json({ attachments });
}

/**
 * POST /api/pilot/bulletins/[id]/attachments — presign upload + insert row
 * JSON body: { filename, sort_order? }
 */
export async function POST(req: NextRequest, { params }: RouteCtx) {
  const auth = await requireAdmin(req);
  if ("error" in auth) return auth.error;

  if (isRateLimited(auth.userId, 20)) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const { id } = await params;
  const bulletinId = parseBulletinId(id);
  if (!bulletinId) {
    return NextResponse.json({ error: "Invalid bulletin ID" }, { status: 400 });
  }

  let body: { filename?: string; sort_order?: number };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const filename = body.filename?.trim();
  if (!filename) {
    return NextResponse.json({ error: "filename is required" }, { status: 400 });
  }

  // Verify the bulletin exists and get its category for the GCS prefix
  const supa = createServiceClient();
  const { data: bulletin, error: bErr } = await supa
    .from("pilot_bulletins")
    .select("id, category")
    .eq("id", bulletinId)
    .single();

  if (bErr || !bulletin) {
    return NextResponse.json({ error: "Bulletin not found" }, { status: 404 });
  }

  // Presign upload
  let upload: Awaited<ReturnType<typeof presignUpload>>;
  try {
    upload = await presignUpload(filename, `pilot-bulletins/${bulletin.category}/docs`);
  } catch (err) {
    console.error("[pilot/bulletins/attachments] presign error:", err);
    return NextResponse.json(
      { error: "Failed to prepare upload" },
      { status: 500 },
    );
  }

  const ext = filename.split(".").pop()?.toLowerCase();
  const contentType = contentTypeForExt(ext);

  // Insert attachment row
  const { data: attachment, error: dbErr } = await supa
    .from("pilot_bulletin_attachments")
    .insert({
      bulletin_id: bulletinId,
      filename,
      content_type: contentType,
      gcs_bucket: upload.bucket,
      gcs_key: upload.key,
      sort_order: body.sort_order ?? 0,
    })
    .select("id, filename, content_type, sort_order, created_at")
    .single();

  if (dbErr) {
    console.error("[pilot/bulletins/attachments] insert error:", dbErr);
    return NextResponse.json({ error: "Failed to create attachment" }, { status: 500 });
  }

  return NextResponse.json({ attachment, upload_url: upload.url }, { status: 201 });
}

/**
 * DELETE /api/pilot/bulletins/[id]/attachments?attachment_id=N — delete an attachment
 */
export async function DELETE(req: NextRequest, { params }: RouteCtx) {
  const auth = await requireAdmin(req);
  if ("error" in auth) return auth.error;

  if (isRateLimited(auth.userId, 20)) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const { id } = await params;
  const bulletinId = parseBulletinId(id);
  if (!bulletinId) {
    return NextResponse.json({ error: "Invalid bulletin ID" }, { status: 400 });
  }

  const attachmentId = Number(req.nextUrl.searchParams.get("attachment_id"));
  if (!attachmentId || isNaN(attachmentId)) {
    return NextResponse.json({ error: "attachment_id query param is required" }, { status: 400 });
  }

  const supa = createServiceClient();
  const { error } = await supa
    .from("pilot_bulletin_attachments")
    .delete()
    .eq("id", attachmentId)
    .eq("bulletin_id", bulletinId);

  if (error) {
    console.error("[pilot/bulletins/attachments] delete error:", error);
    return NextResponse.json({ error: "Failed to delete attachment" }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
