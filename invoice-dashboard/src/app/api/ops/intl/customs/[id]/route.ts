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
  const fields = ["airport_name", "customs_type", "hours_open", "hours_close", "timezone",
    "advance_notice_hours", "overtime_available", "restrictions", "notes", "difficulty",
    "baker_confirmed", "confirmed_at", "confirmed_by"];
  for (const f of fields) {
    if (input[f] !== undefined) updates[f] = input[f];
  }

  const supa = createServiceClient();
  const { data, error } = await supa
    .from("us_customs_airports")
    .update(updates)
    .eq("id", id)
    .select("*")
    .single();

  if (error) {
    console.error("[intl/customs] update error:", error);
    return NextResponse.json({ error: "Failed to update customs airport" }, { status: 500 });
  }
  return NextResponse.json({ airport: data });
}

export async function DELETE(req: NextRequest, ctx: Ctx) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;

  const { id } = await ctx.params;
  const supa = createServiceClient();
  const { error } = await supa.from("us_customs_airports").delete().eq("id", id);

  if (error) {
    console.error("[intl/customs] delete error:", error);
    return NextResponse.json({ error: "Failed to delete customs airport" }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
