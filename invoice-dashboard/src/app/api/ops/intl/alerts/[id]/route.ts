import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthed } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";

type Ctx = { params: Promise<{ id: string }> };

export async function PATCH(req: NextRequest, ctx: Ctx) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;

  const { id } = await ctx.params;
  let input: Record<string, unknown>;
  try { input = await req.json(); } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const updates: Record<string, unknown> = {};
  if (input.acknowledged) {
    updates.acknowledged = true;
    updates.acknowledged_by = auth.userId;
    updates.acknowledged_at = new Date().toISOString();
  }

  const supa = createServiceClient();
  const { data, error } = await supa
    .from("intl_leg_alerts")
    .update(updates)
    .eq("id", id)
    .select("*")
    .single();

  if (error) {
    console.error("[intl/alerts] update error:", error);
    return NextResponse.json({ error: "Failed to update alert" }, { status: 500 });
  }
  return NextResponse.json({ alert: data });
}
