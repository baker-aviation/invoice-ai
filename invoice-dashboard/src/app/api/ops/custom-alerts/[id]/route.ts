import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthed } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";

type Ctx = { params: Promise<{ id: string }> };

/** PATCH — update a custom alert */
export async function PATCH(req: NextRequest, ctx: Ctx) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;

  const { id } = await ctx.params;
  let input: Record<string, unknown>;
  try { input = await req.json(); } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (input.subject !== undefined) updates.subject = input.subject;
  if (input.body !== undefined) updates.body = input.body;
  if (input.severity !== undefined) {
    if (!["critical", "warning", "info"].includes(input.severity as string)) {
      return NextResponse.json({ error: "Invalid severity" }, { status: 400 });
    }
    updates.severity = input.severity;
  }
  if (input.airport_icao !== undefined) updates.airport_icao = input.airport_icao;
  if (input.expires_at !== undefined) updates.expires_at = input.expires_at;

  const supa = createServiceClient();
  const { data, error } = await supa
    .from("custom_notam_alerts")
    .update(updates)
    .eq("id", id)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ alert: data });
}

/** DELETE — archive (soft-delete) a custom alert */
export async function DELETE(req: NextRequest, ctx: Ctx) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;

  const { id } = await ctx.params;
  const supa = createServiceClient();
  const { error } = await supa
    .from("custom_notam_alerts")
    .update({ archived_at: new Date().toISOString() })
    .eq("id", id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
