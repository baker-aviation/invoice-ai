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
  if (input.handler_name !== undefined) updates.handler_name = input.handler_name;
  if (input.handler_contact !== undefined) updates.handler_contact = input.handler_contact;
  if (input.requested !== undefined) {
    updates.requested = input.requested;
    if (input.requested) updates.requested_at = new Date().toISOString();
  }
  if (input.approved !== undefined) {
    updates.approved = input.approved;
    if (input.approved) updates.approved_at = new Date().toISOString();
  }
  if (input.notes !== undefined) updates.notes = input.notes;

  const supa = createServiceClient();
  const { data, error } = await supa
    .from("intl_leg_handlers")
    .update(updates)
    .eq("id", id)
    .select("*")
    .single();

  if (error) {
    console.error("[intl/handlers] update error:", error);
    return NextResponse.json({ error: "Failed to update handler" }, { status: 500 });
  }
  return NextResponse.json({ handler: data });
}

export async function DELETE(req: NextRequest, ctx: Ctx) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;

  const { id } = await ctx.params;
  const supa = createServiceClient();
  const { error } = await supa.from("intl_leg_handlers").delete().eq("id", id);

  if (error) {
    console.error("[intl/handlers] delete error:", error);
    return NextResponse.json({ error: "Failed to delete handler" }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
