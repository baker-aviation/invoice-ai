import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthed } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";
import { signGcsUrl } from "@/lib/gcs";

/**
 * GET /api/pilot/bulletins/[id]/download — redirect to signed GCS URL
 * ?type=doc  → document/image attachment
 * (default)  → video attachment
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;

  const { id } = await params;
  const bulletinId = Number(id);
  if (!bulletinId || isNaN(bulletinId)) {
    return NextResponse.json({ error: "Invalid bulletin ID" }, { status: 400 });
  }

  const type = req.nextUrl.searchParams.get("type");
  const isDoc = type === "doc";

  const supa = createServiceClient();
  const { data, error } = await supa
    .from("pilot_bulletins")
    .select("video_gcs_bucket, video_gcs_key, video_filename, doc_gcs_bucket, doc_gcs_key, doc_filename")
    .eq("id", bulletinId)
    .single();

  if (error || !data) {
    return NextResponse.json({ error: "Bulletin not found" }, { status: 404 });
  }

  const bucket = isDoc ? data.doc_gcs_bucket : data.video_gcs_bucket;
  const key = isDoc ? data.doc_gcs_key : data.video_gcs_key;
  const label = isDoc ? "document" : "video";

  if (!bucket || !key) {
    return NextResponse.json({ error: `No ${label} attached to this bulletin` }, { status: 404 });
  }

  const signedUrl = await signGcsUrl(bucket, key);
  if (!signedUrl) {
    return NextResponse.json({ error: "Failed to generate download URL" }, { status: 500 });
  }

  return NextResponse.redirect(signedUrl);
}
