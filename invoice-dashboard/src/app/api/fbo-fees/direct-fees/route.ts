import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";

/**
 * GET /api/fbo-fees/direct-fees?airport_code=AUS&fbo_name=Million+Air
 *
 * Returns parsed fee data for a specific FBO (both aircraft types).
 */
export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const airportCode = params.get("airport_code");
  const fboName = params.get("fbo_name");

  if (!airportCode || !fboName) {
    return NextResponse.json({ error: "airport_code and fbo_name required" }, { status: 400 });
  }

  const supa = createServiceClient();
  const { data, error } = await supa
    .from("fbo_direct_fees")
    .select("*")
    .eq("airport_code", airportCode)
    .eq("fbo_name", fboName);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ fees: data ?? [] });
}

/**
 * PATCH /api/fbo-fees/direct-fees
 *
 * Update fee fields for a specific FBO + aircraft type.
 * Body: { airport_code, fbo_name, aircraft_type, fees: { field: value, ... } }
 */
export async function PATCH(req: NextRequest) {
  const body = await req.json();
  const { airport_code, fbo_name, aircraft_type, fees } = body;

  if (!airport_code || !fbo_name || !aircraft_type || !fees) {
    return NextResponse.json({ error: "airport_code, fbo_name, aircraft_type, and fees required" }, { status: 400 });
  }

  const allowedFields = [
    "jet_a_price", "facility_fee", "handling_fee", "gallons_to_waive",
    "infrastructure_fee", "security_fee", "overnight_fee", "hangar_fee",
    "hangar_hourly", "hangar_info", "gpu_fee", "lavatory_fee", "deice_fee",
    "afterhours_fee", "callout_fee", "ramp_fee", "landing_fee", "parking_info",
  ];

  const update: Record<string, unknown> = { confidence: "confirmed" };
  for (const [k, v] of Object.entries(fees)) {
    if (allowedFields.includes(k)) update[k] = v;
  }

  const supa = createServiceClient();
  const { data, error } = await supa
    .from("fbo_direct_fees")
    .update(update)
    .eq("airport_code", airport_code)
    .eq("fbo_name", fbo_name)
    .eq("aircraft_type", aircraft_type)
    .select();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data?.length) return NextResponse.json({ error: "No matching record found" }, { status: 404 });

  return NextResponse.json({ ok: true, updated: data[0] });
}
