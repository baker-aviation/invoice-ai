import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthed } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";

/**
 * GET /api/ops/mx-van-override
 * Returns all MX note → van overrides.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;

  const supa = createServiceClient();
  const { data, error } = await supa
    .from("mx_van_overrides")
    .select("mx_note_id, van_id, created_at");

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ overrides: data ?? [] });
}

/**
 * POST /api/ops/mx-van-override
 * Assign an MX note to a specific van (or remove override).
 * Body: { mxNoteId: string, vanId: number | null }
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;

  let body: { mxNoteId?: string; vanId?: number | null };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { mxNoteId, vanId } = body;
  if (!mxNoteId) {
    return NextResponse.json({ error: "mxNoteId required" }, { status: 400 });
  }

  const supa = createServiceClient();

  // vanId = null means remove the override
  if (vanId == null) {
    const { error } = await supa
      .from("mx_van_overrides")
      .delete()
      .eq("mx_note_id", mxNoteId);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true, removed: true });
  }

  // Upsert the override
  const { error } = await supa
    .from("mx_van_overrides")
    .upsert(
      { mx_note_id: mxNoteId, van_id: vanId, created_by: auth.userId },
      { onConflict: "mx_note_id" },
    );

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, vanId });
}
