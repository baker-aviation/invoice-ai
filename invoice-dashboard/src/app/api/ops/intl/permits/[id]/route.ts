import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthed, isRateLimited } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";

type Ctx = { params: Promise<{ id: string }> };

export async function PATCH(req: NextRequest, ctx: Ctx) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;
  if (await isRateLimited(auth.userId, 20)) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const { id } = await ctx.params;
  let input: Record<string, unknown>;
  try { input = await req.json(); } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (input.status !== undefined) {
    if (!["not_started", "drafted", "submitted", "approved"].includes(input.status as string)) {
      return NextResponse.json({ error: "Invalid status" }, { status: 400 });
    }
    updates.status = input.status;
    if (input.status === "submitted") updates.submitted_at = new Date().toISOString();
    if (input.status === "approved") updates.approved_at = new Date().toISOString();
  }
  if (input.deadline !== undefined) updates.deadline = input.deadline;
  if (input.reference_number !== undefined) updates.reference_number = input.reference_number;
  if (input.approved_by !== undefined) updates.approved_by = input.approved_by;
  if (input.notes !== undefined) updates.notes = input.notes;

  const supa = createServiceClient();
  const { data, error } = await supa
    .from("intl_leg_permits")
    .update(updates)
    .eq("id", id)
    .select("*, country:countries(*)")
    .single();

  if (error) {
    console.error("[intl/permits] update error:", error);
    return NextResponse.json({ error: "Failed to update permit" }, { status: 500 });
  }
  return NextResponse.json({ permit: data });
}

export async function DELETE(req: NextRequest, ctx: Ctx) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;

  const { id } = await ctx.params;
  const supa = createServiceClient();
  const { error } = await supa.from("intl_leg_permits").delete().eq("id", id);

  if (error) {
    console.error("[intl/permits] delete error:", error);
    return NextResponse.json({ error: "Failed to delete permit" }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
