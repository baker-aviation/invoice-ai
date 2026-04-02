import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { requireAdmin } from "@/lib/api-auth";

export const maxDuration = 300;

const FF_API = "https://public-api.foreflight.com/public/api";
const BATCH_SIZE = 10; // Fetch 10 flight details per API call
const DELAY_MS = 500; // 0.5s between ForeFlight API calls

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * POST /api/fuel-planning/sync-predictions
 * Pull ForeFlight flight plans and store predicted fuel data.
 * Body: { months?: number, offset?: number }
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

  let body: { months?: number; offset?: number };
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  const months = body.months ?? 3;
  const offset = body.offset ?? 0;
  const supa = createServiceClient();

  // Calculate date range
  const toDate = new Date();
  const fromDate = new Date();
  fromDate.setMonth(fromDate.getMonth() - months);

  try {
    // Step 1: Get flight list from ForeFlight
    const listRes = await fetch(
      `${FF_API}/Flights/flights?fromDate=${fromDate.toISOString().split("T")[0]}&toDate=${toDate.toISOString().split("T")[0]}`,
      {
        headers: {
          "x-api-key": apiKey,
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(30_000),
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

    // Filter to Baker Aviation aircraft (N-numbers we know)
    const bakerFlights = allFlights.filter(
      (f) => f.aircraftRegistration?.startsWith("N"),
    );

    // Check which ones we already have
    const { data: existing } = await supa
      .from("foreflight_predictions")
      .select("foreflight_id");

    const existingIds = new Set(
      (existing ?? []).map((e) => e.foreflight_id),
    );

    const newFlights = bakerFlights.filter(
      (f) => !existingIds.has(f.flightId),
    );

    // Process batch starting at offset
    const batch = newFlights.slice(offset, offset + BATCH_SIZE);

    if (batch.length === 0) {
      return NextResponse.json({
        ok: true,
        done: true,
        total: bakerFlights.length,
        alreadySynced: existingIds.size,
        remaining: 0,
      });
    }

    let stored = 0;
    let skipped = 0;
    const errors: string[] = [];

    // Step 2: Fetch performance for each flight
    for (const flight of batch) {
      await sleep(DELAY_MS);

      try {
        const detailRes = await fetch(
          `${FF_API}/Flights/${flight.flightId}`,
          {
            headers: {
              "x-api-key": apiKey,
              Accept: "application/json",
            },
            signal: AbortSignal.timeout(15_000),
          },
        );

        if (!detailRes.ok) {
          skipped++;
          continue;
        }

        const detail = await detailRes.json();
        const perf = detail.performance;

        if (!perf?.fuel?.fuelToDestination) {
          skipped++;
          continue;
        }

        const depTime = flight.departureTime
          ? new Date(flight.departureTime)
          : null;
        const flightDate = depTime
          ? depTime.toISOString().split("T")[0]
          : new Date().toISOString().split("T")[0];

        const routeInfo = perf.destinationRouteInformation;

        await supa.from("foreflight_predictions").upsert(
          {
            foreflight_id: flight.flightId,
            tail_number: flight.aircraftRegistration,
            departure_icao: flight.departure,
            destination_icao: flight.destination,
            departure_time: flight.departureTime,
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
            callsign: flight.callSign,
            flight_date: flightDate,
          },
          { onConflict: "foreflight_id" },
        );

        stored++;
      } catch (err) {
        errors.push(
          `${flight.flightId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    return NextResponse.json({
      ok: true,
      done: false,
      stored,
      skipped,
      errors,
      nextOffset: offset + batch.length,
      total: bakerFlights.length,
      remaining: newFlights.length - offset - batch.length,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
