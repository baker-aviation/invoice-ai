import { NextRequest, NextResponse } from "next/server";
import { getFboWaiver, getFboOptionsAtAirport } from "@/lib/fboFeeLookup";

export const dynamic = "force-dynamic";

/**
 * GET /api/fbo-fees/lookup?airport=TEB&aircraft=CE-750&vendor=Atlantic
 * Returns FBO fee waiver info for tankering calculations.
 * If vendor is omitted, returns all FBO options at that airport.
 */
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const airport = searchParams.get("airport");
  const aircraft = searchParams.get("aircraft") ?? "CE-750";
  const vendor = searchParams.get("vendor");

  if (!airport) {
    return NextResponse.json({ error: "airport parameter required" }, { status: 400 });
  }

  if (vendor) {
    const waiver = getFboWaiver(airport, vendor, aircraft);
    return NextResponse.json({ ok: true, airport, aircraft, vendor, waiver });
  }

  // Return all FBO options at this airport
  const options = getFboOptionsAtAirport(airport, aircraft);
  const bestMatch = getFboWaiver(airport, null, aircraft);
  return NextResponse.json({ ok: true, airport, aircraft, options, defaultWaiver: bestMatch });
}
