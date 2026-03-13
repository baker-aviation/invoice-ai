import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, isAuthed } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";

/** PATCH /api/pilots/rotation-group — update crew_members.rotation_group */
export async function PATCH(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (!isAuthed(auth)) return auth.error;

  let body: { crew_member_id?: number; rotation_group?: string | null };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON" }, { status: 400 });
  }

  const { crew_member_id, rotation_group } = body;

  if (!crew_member_id) {
    return NextResponse.json({ ok: false, error: "crew_member_id is required" }, { status: 400 });
  }

  if (rotation_group !== null && rotation_group !== "A" && rotation_group !== "B") {
    return NextResponse.json({ ok: false, error: "rotation_group must be A, B, or null" }, { status: 400 });
  }

  const supa = createServiceClient();
  const { error } = await supa
    .from("crew_members")
    .update({ rotation_group })
    .eq("id", crew_member_id);

  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, crew_member_id, rotation_group });
}
