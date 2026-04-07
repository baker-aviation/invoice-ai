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
  const fields = ["name", "icao_prefixes", "overflight_permit_required", "landing_permit_required",
    "permit_lead_time_days", "permit_lead_time_working_days", "treat_as_international", "notes",
    "baker_confirmed", "confirmed_at", "confirmed_by",
    "default_handler_name", "default_handler_contact", "default_handler_email", "default_handler_notes",
    "crew_restrictions", "eapis_required", "eapis_provider"];
  for (const f of fields) {
    if (input[f] !== undefined) updates[f] = input[f];
  }

  const supa = createServiceClient();
  const { data, error } = await supa
    .from("countries")
    .update(updates)
    .eq("id", id)
    .select("*")
    .single();

  if (error) {
    console.error("[intl/countries] update error:", error);
    return NextResponse.json({ error: "Failed to update country" }, { status: 500 });
  }
  return NextResponse.json({ country: data });
}
