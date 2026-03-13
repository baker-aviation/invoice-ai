import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, isAuthed } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";

export const dynamic = "force-dynamic";

/** GET /api/pilots/rotations — list rotations with pilot info */
export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (!isAuthed(auth)) return auth.error;

  const supa = createServiceClient();
  const { data, error } = await supa
    .from("crew_rotations")
    .select("*, crew_members(name, role, rotation_group)")
    .order("rotation_start", { ascending: false });

  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, count: (data ?? []).length, rotations: data ?? [] });
}

/** POST /api/pilots/rotations — create a rotation */
export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (!isAuthed(auth)) return auth.error;

  const body = await req.json();
  const { crew_member_id, tail_number, rotation_start, rotation_end } = body;

  if (!crew_member_id || !tail_number || !rotation_start) {
    return NextResponse.json(
      { ok: false, error: "crew_member_id, tail_number, and rotation_start are required" },
      { status: 400 },
    );
  }

  const supa = createServiceClient();
  const { data, error } = await supa
    .from("crew_rotations")
    .insert({
      crew_member_id,
      tail_number,
      rotation_start,
      rotation_end: rotation_end ?? null,
    })
    .select()
    .single();

  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, rotation: data }, { status: 201 });
}
