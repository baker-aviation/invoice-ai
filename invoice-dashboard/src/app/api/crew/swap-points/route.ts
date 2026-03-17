import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, isAuthed } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";
import { extractSwapPointsPublic, type FlightLeg, type AirportAlias } from "@/lib/swapOptimizer";
import { DEFAULT_AIRPORT_ALIASES } from "@/lib/airportAliases";

export const dynamic = "force-dynamic";

/**
 * GET /api/crew/swap-points?swap_date=2026-03-18
 *
 * Returns computed swap points for each tail on the given date.
 * Shows where each aircraft will be on Wednesday and where crew
 * swaps can occur.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (!isAuthed(auth)) return auth.error;

  const swapDate = req.nextUrl.searchParams.get("swap_date");
  if (!swapDate || !/^\d{4}-\d{2}-\d{2}$/.test(swapDate)) {
    return NextResponse.json({ error: "swap_date required (YYYY-MM-DD)" }, { status: 400 });
  }

  const supa = createServiceClient();

  // Fetch flights around the swap date (±3 days for context)
  const wedDate = new Date(swapDate);
  const start = new Date(wedDate.getTime() - 3 * 86400_000).toISOString();
  const end = new Date(wedDate.getTime() + 3 * 86400_000).toISOString();

  const [flightsRes, aliasRes] = await Promise.all([
    supa
      .from("flights")
      .select("id, tail_number, departure_icao, arrival_icao, scheduled_departure, scheduled_arrival, flight_type, pic, sic")
      .gte("scheduled_departure", start)
      .lte("scheduled_departure", end)
      .order("scheduled_departure"),
    supa.from("airport_aliases").select("fbo_icao, commercial_icao, preferred"),
  ]);

  if (flightsRes.error) {
    return NextResponse.json({ error: flightsRes.error.message }, { status: 500 });
  }

  const flights: FlightLeg[] = (flightsRes.data ?? []).map((f) => ({
    id: f.id as string,
    tail_number: f.tail_number as string,
    departure_icao: f.departure_icao as string,
    arrival_icao: f.arrival_icao as string,
    scheduled_departure: f.scheduled_departure as string,
    scheduled_arrival: f.scheduled_arrival as string | null,
    flight_type: f.flight_type as string | null,
    pic: f.pic as string | null,
    sic: f.sic as string | null,
  }));

  // Group by tail
  const byTail = new Map<string, FlightLeg[]>();
  for (const f of flights) {
    if (!f.tail_number) continue;
    if (!byTail.has(f.tail_number)) byTail.set(f.tail_number, []);
    byTail.get(f.tail_number)!.push(f);
  }

  // Extract swap points for each tail
  const tailSwapPoints: {
    tail: string;
    swap_points: { icao: string; time: string; position: string; isAdjacentLive: boolean }[];
    overnight_airport: string | null;
    aircraft_type: string;
    wednesday_legs: { dep: string; arr: string; type: string | null; dep_time: string; arr_time: string | null }[];
  }[] = [];

  for (const [tail, legs] of byTail) {
    const result = extractSwapPointsPublic(tail, byTail, swapDate);

    // Get Wednesday legs for display
    const wedLegs = legs
      .filter((f) => f.scheduled_departure.slice(0, 10) === swapDate)
      .map((f) => ({
        dep: f.departure_icao,
        arr: f.arrival_icao,
        type: f.flight_type,
        dep_time: f.scheduled_departure,
        arr_time: f.scheduled_arrival,
      }));

    tailSwapPoints.push({
      tail,
      swap_points: result.swapPoints.map((sp) => ({
        icao: sp.icao,
        time: sp.time.toISOString(),
        position: sp.position,
        isAdjacentLive: sp.isAdjacentLive,
      })),
      overnight_airport: result.overnightAirport,
      aircraft_type: result.aircraftType,
      wednesday_legs: wedLegs,
    });
  }

  // Sort by tail number
  tailSwapPoints.sort((a, b) => a.tail.localeCompare(b.tail));

  return NextResponse.json({
    ok: true,
    swap_date: swapDate,
    tails: tailSwapPoints,
    total_tails: tailSwapPoints.length,
  });
}
