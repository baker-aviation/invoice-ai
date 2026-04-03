import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { requireAdmin } from "@/lib/api-auth";

export const maxDuration = 300;

const FF_API = "https://public-api.foreflight.com/public/api";
const BATCH_SIZE = 10;
const DELAY_MS = 500;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Waypoint {
  identifier: string;
  altitude: number;
  timeOverWaypoint: string;
  latitude?: number;
  longitude?: number;
  airway?: { identifier: string; airwayType: string } | null;
}

/** Extract waypoints + compute flight phases from route information */
function extractPhases(routeInfo: Record<string, unknown>, flightId: string) {
  const wps = (routeInfo?.waypoints ?? []) as Waypoint[];
  if (wps.length < 2) return null;

  const parseT = (s: string) => new Date(s).getTime();

  // Build waypoint rows
  const waypointRows = wps.map((wp, i) => ({
    foreflight_id: flightId,
    seq: i,
    identifier: wp.identifier,
    altitude_fl: Math.round(wp.altitude),
    time_over: wp.timeOverWaypoint || null,
    latitude: wp.latitude ?? null,
    longitude: wp.longitude ?? null,
    airway: wp.airway?.identifier ?? null,
    airway_type: wp.airway?.airwayType ?? null,
    is_toc: wp.identifier === "-TOC-",
    is_tod: wp.identifier === "-TOD-",
  }));

  // Compute phase summary
  const depTime = parseT(wps[0].timeOverWaypoint);
  const arrTime = parseT(wps[wps.length - 1].timeOverWaypoint);
  const toc = wps.find((w) => w.identifier === "-TOC-");
  const tod = wps.find((w) => w.identifier === "-TOD-");

  if (!toc || !tod || isNaN(depTime) || isNaN(arrTime)) return { waypointRows, phases: null };

  const tocTime = parseT(toc.timeOverWaypoint);
  const todTime = parseT(tod.timeOverWaypoint);
  const totalMin = (arrTime - depTime) / 60_000;
  const climbMin = (tocTime - depTime) / 60_000;
  const cruiseMin = (todTime - tocTime) / 60_000;
  const descentMin = (arrTime - todTime) / 60_000;

  if (totalMin <= 0) return { waypointRows, phases: null };

  // Find max altitude and count step climbs during cruise
  const cruiseWps = wps.filter((w) => {
    const t = parseT(w.timeOverWaypoint);
    return t >= tocTime && t <= todTime && w.identifier !== "-TOC-" && w.identifier !== "-TOD-";
  });
  const maxAlt = Math.max(toc.altitude, tod.altitude, ...cruiseWps.map((w) => w.altitude));
  let stepClimbs = 0;
  let prevAlt = toc.altitude;
  for (const wp of cruiseWps) {
    if (Math.abs(wp.altitude - prevAlt) >= 10) stepClimbs++;
    prevAlt = wp.altitude;
  }

  return {
    waypointRows,
    phases: {
      foreflight_id: flightId,
      climb_min: Math.round(climbMin * 10) / 10,
      cruise_min: Math.round(cruiseMin * 10) / 10,
      descent_min: Math.round(descentMin * 10) / 10,
      total_min: Math.round(totalMin * 10) / 10,
      climb_pct: Math.round((climbMin / totalMin) * 1000) / 10,
      cruise_pct: Math.round((cruiseMin / totalMin) * 1000) / 10,
      descent_pct: Math.round((descentMin / totalMin) * 1000) / 10,
      initial_alt_fl: Math.round(toc.altitude),
      max_alt_fl: Math.round(maxAlt),
      final_cruise_fl: Math.round(tod.altitude),
      step_climbs: stepClimbs,
      cruise_profile: (routeInfo?.cruiseProfile as string) ?? null,
    },
  };
}

/**
 * POST /api/fuel-planning/sync-predictions
 *
 * Two modes:
 *   1. { months, action: "list" }  — fetch flight list from ForeFlight, return IDs needing sync
 *   2. { flightIds: [...] }        — fetch details + store predictions for specific flights
 */
export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if ("error" in auth) return auth.error;

  const apiKey = process.env.FOREFLIGHT_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "FOREFLIGHT_API_KEY not configured" },
      { status: 500 },
    );
  }

  let body: { months?: number; offset?: number; action?: string; flightIds?: string[]; backfillOffset?: number };
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  const supa = createServiceClient();

  try {
    // ─── Mode 1: List flights needing sync ───
    if (body.action === "list" || (!body.flightIds && !body.offset)) {
      const months = body.months ?? 3;
      const toDate = new Date();
      const fromDate = new Date();
      fromDate.setMonth(fromDate.getMonth() - months);

      const listRes = await fetch(
        `${FF_API}/Flights/flights?fromDate=${fromDate.toISOString().split("T")[0]}&toDate=${toDate.toISOString().split("T")[0]}`,
        {
          headers: { "x-api-key": apiKey, Accept: "application/json" },
          signal: AbortSignal.timeout(90_000),
        },
      );

      if (!listRes.ok) {
        throw new Error(`ForeFlight API: ${listRes.status} ${listRes.statusText}`);
      }

      const listData = await listRes.json();
      const allFlights = (listData.flights ?? []) as Array<{
        flightId: string;
        departure: string;
        destination: string;
        aircraftRegistration: string;
        departureTime: string;
        callSign: string;
      }>;

      const bakerFlights = allFlights.filter(
        (f) => f.aircraftRegistration?.startsWith("N"),
      );

      const { data: existing } = await supa
        .from("foreflight_predictions")
        .select("foreflight_id");

      const existingIds = new Set(
        (existing ?? []).map((e) => e.foreflight_id),
      );

      const newFlights = bakerFlights.filter(
        (f) => !existingIds.has(f.flightId),
      );

      return NextResponse.json({
        ok: true,
        total: bakerFlights.length,
        alreadySynced: existingIds.size,
        needsSync: newFlights.length,
        // Send flight metadata so frontend can batch them back
        flights: newFlights.map((f) => ({
          id: f.flightId,
          dep: f.departure,
          dest: f.destination,
          tail: f.aircraftRegistration,
          time: f.departureTime,
          callsign: f.callSign,
        })),
      });
    }

    // ─── Mode 3: Backfill waypoints for existing predictions ───
    if (body.action === "backfill-waypoints") {
      const bfOffset = body.backfillOffset ?? 0;

      // Get predictions that don't have phase data yet (fetch ALL, not just 1000)
      const { data: allPreds } = await supa
        .from("foreflight_predictions")
        .select("foreflight_id")
        .order("foreflight_id")
        .limit(10000);

      const { data: existingPhases } = await supa
        .from("foreflight_flight_phases")
        .select("foreflight_id")
        .limit(10000);

      const phaseIds = new Set((existingPhases ?? []).map((p) => p.foreflight_id));
      const needsBackfill = (allPreds ?? []).filter((p) => !phaseIds.has(p.foreflight_id));

      if (needsBackfill.length === 0) {
        return NextResponse.json({ ok: true, done: true, backfilled: 0, total: (allPreds ?? []).length });
      }

      // Always process from the front (not offset-based) since completed ones drop out
      const batch = needsBackfill.slice(0, BATCH_SIZE);
      let backfilled = 0;
      const errors: string[] = [];

      for (const { foreflight_id: fid } of batch) {
        await sleep(DELAY_MS);
        try {
          const res = await fetch(`${FF_API}/Flights/${fid}`, {
            headers: { "x-api-key": apiKey, Accept: "application/json" },
            signal: AbortSignal.timeout(15_000),
          });

          if (!res.ok) {
            // Write tombstone so we don't retry this flight
            await supa.from("foreflight_flight_phases").upsert(
              { foreflight_id: fid, climb_min: null, cruise_min: null, descent_min: null, total_min: null },
              { onConflict: "foreflight_id" },
            );
            continue;
          }

          const detail = await res.json();
          const routeInfo = detail.performance?.destinationRouteInformation;
          if (!routeInfo) {
            await supa.from("foreflight_flight_phases").upsert(
              { foreflight_id: fid, climb_min: null, cruise_min: null, descent_min: null, total_min: null },
              { onConflict: "foreflight_id" },
            );
            continue;
          }

          const result = extractPhases(routeInfo, fid);
          if (result?.waypointRows?.length) {
            await supa.from("foreflight_waypoints").delete().eq("foreflight_id", fid);
            await supa.from("foreflight_waypoints").insert(result.waypointRows);
          }
          if (result?.phases) {
            await supa.from("foreflight_flight_phases").upsert(result.phases, { onConflict: "foreflight_id" });
          } else {
            // No TOC/TOD found — write tombstone
            await supa.from("foreflight_flight_phases").upsert(
              { foreflight_id: fid, climb_min: null, cruise_min: null, descent_min: null, total_min: null },
              { onConflict: "foreflight_id" },
            );
          }
          backfilled++;
        } catch (err) {
          errors.push(`${fid}: ${err instanceof Error ? err.message : String(err)}`);
          // Write tombstone on error too
          await supa.from("foreflight_flight_phases").upsert(
            { foreflight_id: fid, climb_min: null, cruise_min: null, descent_min: null, total_min: null },
            { onConflict: "foreflight_id" },
          );
        }
      }

      return NextResponse.json({
        ok: true,
        done: needsBackfill.length <= BATCH_SIZE,
        backfilled,
        remaining: needsBackfill.length - batch.length,
        total: (allPreds ?? []).length,
        errors: errors.length > 0 ? errors : undefined,
      });
    }

    // ─── Mode 2: Process specific flight IDs ───
    const flightIds = body.flightIds ?? [];
    if (flightIds.length === 0) {
      return NextResponse.json({ ok: true, done: true, stored: 0 });
    }

    const batch = flightIds.slice(0, BATCH_SIZE);
    let stored = 0;
    let skipped = 0;
    const errors: string[] = [];

    for (const flightId of batch) {
      await sleep(DELAY_MS);

      try {
        const detailRes = await fetch(
          `${FF_API}/Flights/${flightId}`,
          {
            headers: { "x-api-key": apiKey, Accept: "application/json" },
            signal: AbortSignal.timeout(15_000),
          },
        );

        if (!detailRes.ok) {
          skipped++;
          continue;
        }

        const detail = await detailRes.json();
        const perf = detail.performance;
        const flightData = detail.flightData ?? detail.flight ?? detail;

        if (!perf?.fuel?.fuelToDestination) {
          skipped++;
          continue;
        }

        const depTime = flightData.scheduledTimeOfDeparture ?? flightData.departureTime;
        const flightDate = depTime
          ? new Date(depTime).toISOString().split("T")[0]
          : new Date().toISOString().split("T")[0];

        const routeInfo = perf.destinationRouteInformation;

        await supa.from("foreflight_predictions").upsert(
          {
            foreflight_id: flightId,
            tail_number: flightData.aircraftRegistration ?? null,
            departure_icao: flightData.departure ?? null,
            destination_icao: flightData.destination ?? null,
            departure_time: depTime ?? null,
            arrival_time: perf.times?.estimatedArrivalTime ?? null,
            fuel_to_dest_lbs: perf.fuel.fuelToDestination,
            total_fuel_lbs: perf.fuel.totalFuel,
            flight_fuel_lbs: perf.fuel.flightFuel,
            taxi_fuel_lbs: perf.fuel.taxiFuel,
            reserve_fuel_lbs: perf.fuel.reserveFuel,
            ramp_weight: perf.weights?.rampWeight ?? null,
            takeoff_weight: perf.weights?.takeOffWeight ?? null,
            landing_weight: perf.weights?.landingWeight ?? null,
            zero_fuel_weight: perf.weights?.zeroFuelWeight ?? null,
            time_to_dest_min: perf.times?.timeToDestinationMinutes ?? null,
            route_nm: perf.distances?.destination ?? null,
            gc_nm: perf.distances?.gcdDestination ?? null,
            wind_component: perf.weather?.averageWindComponent ?? null,
            isa_deviation: perf.weather?.averageISADeviation ?? null,
            cruise_profile: routeInfo?.cruiseProfile ?? null,
            callsign: flightData.callsign ?? flightData.callSign ?? null,
            flight_date: flightDate,
          },
          { onConflict: "foreflight_id" },
        );

        // Store waypoints + flight phases
        if (routeInfo) {
          const result = extractPhases(routeInfo as Record<string, unknown>, flightId);
          if (result?.waypointRows?.length) {
            // Delete existing waypoints for this flight (in case of re-sync)
            await supa.from("foreflight_waypoints").delete().eq("foreflight_id", flightId);
            await supa.from("foreflight_waypoints").insert(result.waypointRows);
          }
          if (result?.phases) {
            await supa.from("foreflight_flight_phases").upsert(result.phases, { onConflict: "foreflight_id" });
          }
        }

        stored++;
      } catch (err) {
        errors.push(
          `${flightId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    return NextResponse.json({
      ok: true,
      stored,
      skipped,
      errors: errors.length > 0 ? errors : undefined,
      processed: batch.length,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
