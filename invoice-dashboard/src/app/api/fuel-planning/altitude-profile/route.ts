import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { requireAuth } from "@/lib/api-auth";

// Phase burn rate constants (validated from fleet data analysis)
const PHASE_RATES: Record<string, { climb: number; cruise: number; descent: number }> = {
  "CE-750": { climb: 3500, cruise: 1850, descent: 2200 },
  "CL-30":  { climb: 3600, cruise: 1860, descent: 2200 },
};

// Approximate lbs/NM penalty per 10 FL below optimal (FL470 for CE-750, FL450 for CL-30)
// Derived from fleet data: higher = thinner air = less drag
const ALT_PENALTY_PER_10FL = 0.04; // lbs/NM per 10 FL below optimal
const OPTIMAL_ALT: Record<string, number> = { "CE-750": 470, "CL-30": 450 };

/**
 * Compute fuel attribution breakdown from three data sources
 */
function computeAttribution(params: {
  aircraftType: string;
  routeNm: number;
  // ForeFlight plan
  ffBurn: number;
  ffClimbMin: number | null;
  ffCruiseMin: number | null;
  ffDescentMin: number | null;
  ffMaxAlt: number | null;
  // ADS-B actual profile
  actualClimbMin: number | null;
  actualCruiseMin: number | null;
  actualDescentMin: number | null;
  actualMaxAlt: number | null;
  // JetInsight
  actualBurn: number;
}) {
  const {
    aircraftType, routeNm, ffBurn, actualBurn,
    ffClimbMin, ffCruiseMin, ffDescentMin, ffMaxAlt,
    actualClimbMin, actualCruiseMin, actualDescentMin, actualMaxAlt,
  } = params;

  const overBurn = actualBurn - ffBurn;
  if (ffBurn <= 0 || actualBurn <= 0) return null;

  const rates = PHASE_RATES[aircraftType] ?? PHASE_RATES["CE-750"];
  const optimal = OPTIMAL_ALT[aircraftType] ?? 470;
  const items: Array<{ label: string; lbs: number; pct: number; detail: string }> = [];

  // 1. CLIMB PENALTY — extra time in climb phase
  let climbPenalty = 0;
  if (actualClimbMin != null && ffClimbMin != null && actualClimbMin > ffClimbMin) {
    const extraMin = actualClimbMin - ffClimbMin;
    // Extra climb time costs the difference between climb and cruise burn rates
    climbPenalty = Math.round(extraMin * (rates.climb - rates.cruise) / 60);
    items.push({
      label: "Climb",
      lbs: climbPenalty,
      pct: ffBurn > 0 ? Math.round((climbPenalty / ffBurn) * 100) : 0,
      detail: `+${extraMin.toFixed(0)} min in climb (${actualClimbMin.toFixed(0)}m vs ${ffClimbMin.toFixed(0)}m planned). Climb burns ${rates.climb} lbs/hr vs ${rates.cruise} cruise.`,
    });
  }

  // 2. ALTITUDE PENALTY — lower cruise altitude than planned
  let altPenalty = 0;
  if (actualMaxAlt != null && ffMaxAlt != null && actualMaxAlt < ffMaxAlt - 5) {
    const altDelta = ffMaxAlt - actualMaxAlt; // positive = actual is lower
    const penaltyPerNm = (altDelta / 10) * ALT_PENALTY_PER_10FL;
    altPenalty = Math.round(penaltyPerNm * routeNm);
    const aboveFL410 = actualMaxAlt >= 410;
    items.push({
      label: "Altitude",
      lbs: altPenalty,
      pct: ffBurn > 0 ? Math.round((altPenalty / ffBurn) * 100) : 0,
      detail: `Cruised at FL${actualMaxAlt} vs FL${ffMaxAlt} planned (-${altDelta} FL).${aboveFL410 ? " Above FL410 — altitude is typically pilot's choice." : ""}`,
    });
  }

  // 3. DESCENT PENALTY — started descent earlier/longer than planned
  let descentPenalty = 0;
  if (actualDescentMin != null && ffDescentMin != null && actualDescentMin > ffDescentMin) {
    const extraMin = actualDescentMin - ffDescentMin;
    descentPenalty = Math.round(extraMin * (rates.descent - rates.cruise) / 60);
    items.push({
      label: "Descent",
      lbs: descentPenalty,
      pct: ffBurn > 0 ? Math.round((descentPenalty / ffBurn) * 100) : 0,
      detail: `+${extraMin.toFixed(0)} min in descent (${actualDescentMin.toFixed(0)}m vs ${ffDescentMin.toFixed(0)}m planned).`,
    });
  }

  // 4. UNEXPLAINED — everything else (speed, weight, weather mismatch, etc.)
  const attributed = climbPenalty + altPenalty + descentPenalty;
  const unexplained = overBurn - attributed;
  if (Math.abs(unexplained) > 10) {
    items.push({
      label: "Other",
      lbs: Math.round(unexplained),
      pct: ffBurn > 0 ? Math.round((unexplained / ffBurn) * 100) : 0,
      detail: "Speed management, weight differences, weather forecast error, ATC routing.",
    });
  }

  return {
    ffBurn: Math.round(ffBurn),
    actualBurn: Math.round(actualBurn),
    overBurn: Math.round(overBurn),
    overBurnPct: Math.round((overBurn / ffBurn) * 100),
    items,
    totalAttributed: Math.round(attributed),
  };
}

/**
 * Extract climb/cruise/descent phases from ADS-B track positions
 */
function extractActualPhases(positions: Array<{ minutesFromDep: number; altitudeFl: number }>) {
  if (positions.length < 5) return { climbMin: null, cruiseMin: null, descentMin: null, maxAlt: null };

  const maxAlt = Math.max(...positions.map((p) => p.altitudeFl));
  const totalMin = positions[positions.length - 1].minutesFromDep;

  // Find TOC: first time reaching within 5 FL of max altitude
  const tocIdx = positions.findIndex((p) => p.altitudeFl >= maxAlt - 5);
  const climbMin = tocIdx >= 0 ? positions[tocIdx].minutesFromDep : null;

  // Find TOD: last time at within 5 FL of max altitude before descent
  let todIdx = positions.length - 1;
  for (let i = positions.length - 1; i >= 0; i--) {
    if (positions[i].altitudeFl >= maxAlt - 5) { todIdx = i; break; }
  }
  const descentMin = todIdx < positions.length - 1
    ? totalMin - positions[todIdx].minutesFromDep
    : null;

  const cruiseMin = climbMin != null && descentMin != null
    ? totalMin - climbMin - descentMin
    : null;

  return { climbMin, cruiseMin, descentMin, maxAlt };
}

/**
 * GET /api/fuel-planning/altitude-profile?tail=N733FL&origin=KGPI&dest=KSGR&date=2026-04-01&type=CE-750&actualBurn=4800
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if ("error" in auth) return auth.error;

  const tail = req.nextUrl.searchParams.get("tail");
  const origin = req.nextUrl.searchParams.get("origin");
  const dest = req.nextUrl.searchParams.get("dest");
  const date = req.nextUrl.searchParams.get("date");
  const aircraftType = req.nextUrl.searchParams.get("type") ?? "CE-750";
  const actualBurn = Number(req.nextUrl.searchParams.get("actualBurn")) || 0;

  if (!tail || !date) {
    return NextResponse.json({ error: "tail and date required" }, { status: 400 });
  }

  const supa = createServiceClient();
  const originNorm = (origin ?? "").replace(/^K/, "");
  const destNorm = (dest ?? "").replace(/^K/, "");

  // Parallel fetch: prediction, phase, and track data
  const [predResult, trackResult] = await Promise.all([
    supa.from("foreflight_predictions")
      .select("foreflight_id, departure_icao, destination_icao, departure_time, fuel_to_dest_lbs, route_nm")
      .eq("tail_number", tail).eq("flight_date", date).limit(10),
    supa.from("flightaware_tracks")
      .select("positions, position_count, max_altitude, origin_icao, destination_icao")
      .eq("tail_number", tail).eq("flight_date", date).limit(10),
  ]);

  // Match prediction
  const matchedPred = (predResult.data ?? []).find((p: Record<string, string>) => {
    const pDep = (p.departure_icao ?? "").replace(/^K/, "");
    const pDest = (p.destination_icao ?? "").replace(/^K/, "");
    return pDep === originNorm && pDest === destNorm;
  }) as Record<string, unknown> | undefined;

  // Fetch waypoints + phases if we have a prediction
  let planned: Array<{ minutesFromDep: number; altitudeFl: number; identifier: string }> = [];
  let ffClimbMin: number | null = null;
  let ffCruiseMin: number | null = null;
  let ffDescentMin: number | null = null;
  let ffMaxAlt: number | null = null;
  let ffBurn = 0;
  let routeNm = 0;

  if (matchedPred) {
    ffBurn = Number(matchedPred.fuel_to_dest_lbs) || 0;
    routeNm = Number(matchedPred.route_nm) || 0;

    const [waypointResult, phaseResult] = await Promise.all([
      supa.from("foreflight_waypoints")
        .select("seq, identifier, altitude_fl, time_over, is_toc, is_tod")
        .eq("foreflight_id", matchedPred.foreflight_id as string)
        .order("seq", { ascending: true }),
      supa.from("foreflight_flight_phases")
        .select("climb_min, cruise_min, descent_min, initial_alt_fl, max_alt_fl")
        .eq("foreflight_id", matchedPred.foreflight_id as string)
        .limit(1)
        .single(),
    ]);

    if (waypointResult.data?.length) {
      const wps = waypointResult.data as Record<string, unknown>[];
      const depTime = new Date(wps[0].time_over as string).getTime();
      planned = wps.map((wp) => ({
        minutesFromDep: Math.round(((new Date(wp.time_over as string).getTime()) - depTime) / 60000 * 10) / 10,
        altitudeFl: wp.altitude_fl as number,
        identifier: wp.identifier as string,
      }));
    }

    if (phaseResult.data) {
      const ph = phaseResult.data as Record<string, unknown>;
      ffClimbMin = ph.climb_min != null ? Number(ph.climb_min) : null;
      ffCruiseMin = ph.cruise_min != null ? Number(ph.cruise_min) : null;
      ffDescentMin = ph.descent_min != null ? Number(ph.descent_min) : null;
      ffMaxAlt = ph.max_alt_fl != null ? Number(ph.max_alt_fl) : null;
    }
  }

  // Match track
  let trackData = null;
  if (trackResult.data?.length) {
    const exact = (trackResult.data as Record<string, unknown>[]).find(
      (t) => t.origin_icao === origin && t.destination_icao === dest,
    );
    trackData = exact ?? (trackResult.data as Record<string, unknown>[])[0];
  }

  let actual: Array<{ minutesFromDep: number; altitudeFl: number; groundspeed: number | null }> = [];
  let actualPhases = { climbMin: null as number | null, cruiseMin: null as number | null, descentMin: null as number | null, maxAlt: null as number | null };

  if (trackData) {
    const positions = (trackData as Record<string, unknown>).positions as Array<{ t: string; alt: number | null; gs: number | null }>;
    if (positions?.length > 1) {
      const depTime = new Date(positions[0].t).getTime();
      actual = positions
        .filter((p) => p.alt != null)
        .map((p) => ({
          minutesFromDep: Math.round((new Date(p.t).getTime() - depTime) / 60000 * 10) / 10,
          altitudeFl: p.alt ?? 0, // FA stores in hundreds of feet already
          groundspeed: p.gs,
        }));

      actualPhases = extractActualPhases(actual);
    }
  }

  // Compute attribution if we have all three data sources
  let attribution = null;
  if (ffBurn > 0 && actualBurn > 0 && (actual.length > 0 || ffClimbMin != null)) {
    attribution = computeAttribution({
      aircraftType,
      routeNm,
      ffBurn,
      ffClimbMin,
      ffCruiseMin,
      ffDescentMin,
      ffMaxAlt,
      actualClimbMin: actualPhases.climbMin,
      actualCruiseMin: actualPhases.cruiseMin,
      actualDescentMin: actualPhases.descentMin,
      actualMaxAlt: actualPhases.maxAlt,
      actualBurn,
    });
  }

  return NextResponse.json({
    planned,
    actual,
    hasPlan: planned.length > 0,
    hasTrack: actual.length > 0,
    maxPlannedAlt: planned.length > 0 ? Math.max(...planned.map((p) => p.altitudeFl)) : null,
    maxActualAlt: actual.length > 0 ? Math.max(...actual.map((p) => p.altitudeFl)) : null,
    attribution,
    phases: {
      planned: { climbMin: ffClimbMin, cruiseMin: ffCruiseMin, descentMin: ffDescentMin, maxAlt: ffMaxAlt },
      actual: actualPhases,
    },
  });
}
