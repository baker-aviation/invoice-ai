import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthed, isRateLimited } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;

  const supa = createServiceClient();
  const { data, error } = await supa
    .from("countries")
    .select("*")
    .order("name");

  if (error) {
    console.error("[intl/countries] list error:", error);
    return NextResponse.json({ error: "Failed to list countries" }, { status: 500 });
  }
  return NextResponse.json({ countries: data ?? [] });
}

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;
  if (await isRateLimited(auth.userId, 20)) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  let input: Record<string, unknown>;
  try { input = await req.json(); } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const name = (input.name as string)?.trim();
  const iso_code = (input.iso_code as string)?.trim().toUpperCase();
  if (!name || !iso_code || iso_code.length !== 2) {
    return NextResponse.json({ error: "name and iso_code (2-letter) required" }, { status: 400 });
  }

  const supa = createServiceClient();
  const { data, error } = await supa
    .from("countries")
    .insert({
      name,
      iso_code,
      icao_prefixes: input.icao_prefixes ?? [],
      overflight_permit_required: input.overflight_permit_required ?? false,
      landing_permit_required: input.landing_permit_required ?? false,
      permit_lead_time_days: input.permit_lead_time_days ?? null,
      permit_lead_time_working_days: input.permit_lead_time_working_days ?? false,
      treat_as_international: input.treat_as_international ?? false,
      notes: input.notes ?? null,
    })
    .select("*")
    .single();

  if (error) {
    console.error("[intl/countries] insert error:", error);
    return NextResponse.json({ error: "Failed to create country" }, { status: 500 });
  }
  return NextResponse.json({ country: data }, { status: 201 });
}
