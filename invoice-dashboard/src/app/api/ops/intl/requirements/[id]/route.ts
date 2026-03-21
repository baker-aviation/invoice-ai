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
  const fields = ["name", "description", "requirement_type", "required_documents", "sort_order", "is_active", "attachment_url", "attachment_filename"];
  for (const f of fields) {
    if (input[f] !== undefined) updates[f] = input[f];
  }

  const supa = createServiceClient();
  const { data, error } = await supa
    .from("country_requirements")
    .update(updates)
    .eq("id", id)
    .select("*")
    .single();

  if (error) {
    console.error("[intl/requirements] update error:", error);
    return NextResponse.json({ error: "Failed to update requirement" }, { status: 500 });
  }
  return NextResponse.json({ requirement: data });
}

export async function DELETE(req: NextRequest, ctx: Ctx) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;

  const { id } = await ctx.params;
  const supa = createServiceClient();
  const { error } = await supa.from("country_requirements").delete().eq("id", id);

  if (error) {
    console.error("[intl/requirements] delete error:", error);
    return NextResponse.json({ error: "Failed to delete requirement" }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
