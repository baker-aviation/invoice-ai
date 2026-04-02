import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { requireAdmin } from "@/lib/api-auth";

export const maxDuration = 300;

const FF_API = "https://public-api.foreflight.com/public/api";
const BATCH_SIZE = 10;
const DELAY_MS = 500;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

  let body: { months?: number; offset?: number; action?: string; flightIds?: string[] };
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
