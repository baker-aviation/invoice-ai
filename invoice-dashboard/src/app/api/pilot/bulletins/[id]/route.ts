import { NextRequest, NextResponse } from "next/server";
import { requireAuth, requireAdmin, isAuthed, isRateLimited } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";

/**
 * GET /api/pilot/bulletins/[id] — single bulletin
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

  const supa = createServiceClient();
  const { data, error } = await supa
    .from("pilot_bulletins")
    .select("*")
    .eq("id", bulletinId)
    .single();

  if (error || !data) {
    return NextResponse.json({ error: "Bulletin not found" }, { status: 404 });
  }

  return NextResponse.json({ bulletin: data });
}

/**
 * DELETE /api/pilot/bulletins/[id] — delete a bulletin (admin only)
 */
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAdmin(req);
  if ("error" in auth) return auth.error;

  if (isRateLimited(auth.userId, 10)) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const { id } = await params;
  const bulletinId = Number(id);
  if (!bulletinId || isNaN(bulletinId)) {
    return NextResponse.json({ error: "Invalid bulletin ID" }, { status: 400 });
  }

  const supa = createServiceClient();
  const { error } = await supa
    .from("pilot_bulletins")
    .delete()
    .eq("id", bulletinId);

  if (error) {
    console.error("[pilot/bulletins] delete error:", error);
    return NextResponse.json({ error: "Failed to delete bulletin" }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
