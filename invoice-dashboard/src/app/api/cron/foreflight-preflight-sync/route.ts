import { NextRequest, NextResponse } from "next/server";
import { verifyCronSecret } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const FF_BASE = "https://public-api.foreflight.com/public/api";

function apiKey(): string {
  const key = process.env.FOREFLIGHT_API_KEY;
  if (!key) throw new Error("FOREFLIGHT_API_KEY not set");
  return key;
}

/**
 * GET /api/cron/foreflight-preflight-sync
 *
 * Syncs ForeFlight performance data for upcoming flights (next 2 days).
 * Stores as snapshot_type = 'pre_flight' in foreflight_predictions.
 *
 * Designed to run every 30 minutes. Only fetches flights not already synced
 * (or synced more than 2 hours ago, to catch dispatch updates).
 */
export async function GET(req: NextRequest) {
  if (!verifyCronSecret(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const key = apiKey();
  const supa = createServiceClient();

  // Fetch flights for today + next 2 days
  const today = new Date();
  const endDate = new Date(today);
  endDate.setDate(endDate.getDate() + 2);
  const fromDate = today.toISOString().split("T")[0];
  const toDate = endDate.toISOString().split("T")[0];

  let allFlights: Array<{
    flightId: string;
    departure: string;
    destination: string;
    aircraftRegistration: string;
    departureTime?: string;
    callSign?: string;
  }>;

  try {
    const listRes = await fetch(
      `${FF_BASE}/Flights/flights?fromDate=${fromDate}&toDate=${toDate}`,
      {
        headers: { "x-api-key": key, Accept: "application/json" },
        signal: AbortSignal.timeout(15_000),
      },
    );

    if (!listRes.ok) {
      return NextResponse.json({ error: `ForeFlight ${listRes.status}` }, { status: 502 });
    }

    const data = await listRes.json();
    allFlights = (data.flights ?? []).filter(
      (f: { aircraftRegistration?: string }) => f.aircraftRegistration?.startsWith("N"),
    );
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }

  if (allFlights.length === 0) {
    return NextResponse.json({ ok: true, message: "No flights found", synced: 0 });
  }

  // Check which flights already have recent pre-flight data (synced < 2 hours ago)
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
  const { data: existing } = await supa
    .from("foreflight_predictions")
    .select("foreflight_id, synced_at")
    .eq("snapshot_type", "pre_flight")
    .in(
      "foreflight_id",
      allFlights.map((f) => f.flightId),
    );

  const recentIds = new Set(
    (existing ?? [])
      .filter((e) => e.synced_at > twoHoursAgo)
      .map((e) => e.foreflight_id),
  );

  const needsSync = allFlights.filter((f) => !recentIds.has(f.flightId));

  if (needsSync.length === 0) {
    return NextResponse.json({
      ok: true,
      message: "All flights already synced",
      total: allFlights.length,
      synced: 0,
    });
  }

  console.log(`[ff-preflight] Syncing ${needsSync.length}/${allFlights.length} flights`);

  // Fetch details in parallel (batches of 10 to be polite)
  let synced = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (let batch = 0; batch < needsSync.length; batch += 10) {
    const chunk = needsSync.slice(batch, batch + 10);

    const results = await Promise.allSettled(
      chunk.map((flight) =>
        fetch(`${FF_BASE}/Flights/${encodeURIComponent(flight.flightId)}`, {
          headers: { "x-api-key": key, Accept: "application/json" },
          signal: AbortSignal.timeout(10_000),
        })
          .then((r) => (r.ok ? r.json() : null))
          .then((detail) => (detail ? { detail, flight } : null))
          .catch(() => null),
      ),
    );

    for (const settled of results) {
      if (settled.status !== "fulfilled" || !settled.value) {
        skipped++;
        continue;
      }

      const { detail, flight } = settled.value;
      const perf = detail.performance;
      const fd = detail.flightData ?? {};

      if (!perf?.fuel?.fuelToDestination) {
        skipped++;
        continue;
      }

      const depTime = fd.scheduledTimeOfDeparture ?? flight.departureTime;
      const flightDate = depTime
        ? new Date(depTime).toISOString().split("T")[0]
        : fromDate;

      const { error } = await supa.from("foreflight_predictions").upsert(
        {
          foreflight_id: flight.flightId,
          snapshot_type: "pre_flight",
          tail_number: fd.aircraftRegistration ?? flight.aircraftRegistration ?? null,
          departure_icao: fd.departure ?? flight.departure ?? null,
          destination_icao: fd.destination ?? flight.destination ?? null,
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
          cruise_profile: perf.destinationRouteInformation?.cruiseProfile ?? null,
          callsign: fd.callsign ?? flight.callSign ?? null,
          flight_date: flightDate,
          synced_at: new Date().toISOString(),
        },
        { onConflict: "foreflight_id" },
      );

      if (error) {
        errors.push(`${flight.flightId}: ${error.message}`);
      } else {
        synced++;
      }
    }
  }

  console.log(`[ff-preflight] Done: ${synced} synced, ${skipped} skipped, ${errors.length} errors`);

  return NextResponse.json({
    ok: true,
    total: allFlights.length,
    needsSync: needsSync.length,
    synced,
    skipped,
    errors: errors.length > 0 ? errors : undefined,
  });
}
