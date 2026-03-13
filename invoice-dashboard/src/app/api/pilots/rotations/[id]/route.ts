import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, isAuthed } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";

export const dynamic = "force-dynamic";

/** PATCH /api/pilots/rotations/[id] — update a rotation */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAdmin(req);
  if (!isAuthed(auth)) return auth.error;

  const { id } = await params;
  const rotationId = Number(id);
  if (Number.isNaN(rotationId)) {
    return NextResponse.json({ ok: false, error: "Invalid id" }, { status: 400 });
  }

  const body = await req.json();
  const allowedFields = ["crew_member_id", "tail_number", "rotation_start", "rotation_end"];
  const updates: Record<string, any> = {};
  for (const key of allowedFields) {
    if (key in body) updates[key] = body[key];
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ ok: false, error: "No fields to update" }, { status: 400 });
  }

  const supa = createServiceClient();
  const { data, error } = await supa
    .from("crew_rotations")
    .update(updates)
    .eq("id", rotationId)
    .select()
    .single();

  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, rotation: data });
}

/** DELETE /api/pilots/rotations/[id] — remove a rotation */
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAdmin(req);
  if (!isAuthed(auth)) return auth.error;

  const { id } = await params;
  const rotationId = Number(id);
  if (Number.isNaN(rotationId)) {
    return NextResponse.json({ ok: false, error: "Invalid id" }, { status: 400 });
  }

  const supa = createServiceClient();
  const { error } = await supa
    .from("crew_rotations")
    .delete()
    .eq("id", rotationId);

  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
