import { NextRequest, NextResponse } from "next/server";
import { requireSuperAdmin, isAuthed } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";
import { getGcsStorage } from "@/lib/gcs-upload";

type RouteCtx = { params: Promise<{ id: string }> };

/**
 * GET /api/admin/meetings/[id]/screenshots
 * Returns screenshot metadata with signed GCS URLs for viewing.
 */
export async function GET(req: NextRequest, ctx: RouteCtx) {
  const auth = await requireSuperAdmin(req);
  if (!isAuthed(auth)) return auth.error;

  const { id } = await ctx.params;

  const sb = createServiceClient();
  const { data, error } = await sb
    .from("meeting_screenshots")
    .select("*")
    .eq("meeting_id", id)
    .order("time_sec", { ascending: true });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Generate signed read URLs for each screenshot
  const storage = await getGcsStorage();
  const bucket = process.env.GCS_BUCKET || "baker-aviation-invoice-pdfs";

  const screenshots = await Promise.all(
    (data || []).map(async (s) => {
      const [url] = await storage.bucket(bucket).file(s.gcs_key).getSignedUrl({
        version: "v4",
        action: "read",
        expires: Date.now() + 60 * 60 * 1000, // 1 hour
      });
      return { ...s, url };
    }),
  );

  return NextResponse.json({ screenshots });
}

/**
 * POST /api/admin/meetings/[id]/screenshots
 * Bulk insert screenshot records after upload.
 * Body: { screenshots: [{ gcs_key, time_sec }] }
 */
export async function POST(req: NextRequest, ctx: RouteCtx) {
  const auth = await requireSuperAdmin(req);
  if (!isAuthed(auth)) return auth.error;

  const { id } = await ctx.params;
  const { screenshots } = await req.json();

  if (!Array.isArray(screenshots) || screenshots.length === 0) {
    return NextResponse.json({ error: "screenshots array is required" }, { status: 400 });
  }

  const rows = screenshots.map((s: { gcs_key: string; time_sec: number }) => ({
    meeting_id: parseInt(id, 10),
    gcs_key: s.gcs_key,
    time_sec: s.time_sec,
  }));

  const sb = createServiceClient();
  const { error } = await sb.from("meeting_screenshots").insert(rows);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Update screenshot count on meeting
  await sb
    .from("meetings")
    .update({ screenshot_count: rows.length, updated_at: new Date().toISOString() })
    .eq("id", id);

  return NextResponse.json({ ok: true, count: rows.length });
}
