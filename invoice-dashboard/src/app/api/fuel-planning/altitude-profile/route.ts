import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { requireAuth } from "@/lib/api-auth";

/**
 * GET /api/fuel-planning/altitude-profile?tail=N733FL&origin=KGPI&dest=KSGR&date=2026-04-01
 *
 * Returns both ForeFlight planned waypoints and FlightAware actual track
 * for a specific flight, formatted for the altitude overlay chart.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if ("error" in auth) return auth.error;

  const tail = req.nextUrl.searchParams.get("tail");
  const origin = req.nextUrl.searchParams.get("origin");
  const dest = req.nextUrl.searchParams.get("dest");
  const date = req.nextUrl.searchParams.get("date");

  if (!tail || !date) {
    return NextResponse.json({ error: "tail and date required" }, { status: 400 });
  }

  const supa = createServiceClient();

  // Normalize airport codes for matching
  const originNorm = (origin ?? "").replace(/^K/, "");
  const destNorm = (dest ?? "").replace(/^K/, "");

  // Fetch ForeFlight prediction + waypoints
  const { data: prediction } = await supa
    .from("foreflight_predictions")
    .select("foreflight_id, departure_icao, destination_icao, departure_time")
    .eq("tail_number", tail)
    .eq("flight_date", date)
    .limit(10);

  // Find matching prediction (normalize ICAO codes)
  const matchedPred = (prediction ?? []).find((p: Record<string, string>) => {
    const pDep = (p.departure_icao ?? "").replace(/^K/, "");
    const pDest = (p.destination_icao ?? "").replace(/^K/, "");
    return pDep === originNorm && pDest === destNorm;
  });

  let planned: Array<{ minutesFromDep: number; altitudeFl: number; identifier: string }> = [];

  if (matchedPred) {
    const { data: waypoints } = await supa
      .from("foreflight_waypoints")
      .select("seq, identifier, altitude_fl, time_over, is_toc, is_tod")
      .eq("foreflight_id", matchedPred.foreflight_id)
      .order("seq", { ascending: true });

    if (waypoints?.length) {
      const depTime = new Date((waypoints as Record<string, unknown>[])[0].time_over as string).getTime();
      planned = (waypoints as Record<string, unknown>[]).map((wp) => ({
        minutesFromDep: Math.round(((new Date(wp.time_over as string).getTime()) - depTime) / 60000 * 10) / 10,
        altitudeFl: wp.altitude_fl as number,
        identifier: wp.identifier as string,
      }));
    }
  }

  // Fetch FlightAware actual track
  const { data: faTrack } = await supa
    .from("flightaware_tracks")
    .select("positions, position_count, max_altitude")
    .eq("tail_number", tail)
    .eq("flight_date", date)
    .limit(10);

  // Match by origin/dest if multiple flights on same day
  let trackData = null;
  if (faTrack?.length) {
    // Try exact match first
    const exactMatch = await supa
      .from("flightaware_tracks")
      .select("positions, position_count, max_altitude")
      .eq("tail_number", tail)
      .eq("flight_date", date)
      .eq("origin_icao", origin)
      .eq("destination_icao", dest)
      .limit(1)
      .single();

    trackData = exactMatch.data ?? (faTrack as Record<string, unknown>[])[0];
  }

  let actual: Array<{ minutesFromDep: number; altitudeFl: number; groundspeed: number | null }> = [];

  if (trackData) {
    const positions = (trackData as Record<string, unknown>).positions as Array<{ t: string; alt: number | null; gs: number | null }>;
    if (positions?.length > 1) {
      const depTime = new Date(positions[0].t).getTime();
      actual = positions
        .filter((p) => p.alt != null)
        .map((p) => ({
          minutesFromDep: Math.round((new Date(p.t).getTime() - depTime) / 60000 * 10) / 10,
          altitudeFl: Math.round((p.alt ?? 0) / 100), // FA gives hundreds of feet, convert to FL
          groundspeed: p.gs,
        }));
    }
  }

  return NextResponse.json({
    planned,
    actual,
    hasPlan: planned.length > 0,
    hasTrack: actual.length > 0,
    maxPlannedAlt: planned.length > 0 ? Math.max(...planned.map((p) => p.altitudeFl)) : null,
    maxActualAlt: actual.length > 0 ? Math.max(...actual.map((p) => p.altitudeFl)) : null,
  });
}
