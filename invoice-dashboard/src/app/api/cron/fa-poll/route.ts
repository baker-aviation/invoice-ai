import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import {
  getFlightsByRegistration,
  getFlightPosition,
  toFlightInfo,
  type FaFlight,
  type FlightInfo,
} from "@/lib/flightaware";
import { TRIPS } from "@/lib/maintenanceData";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const DISCOVERY_INTERVAL_MS = 18 * 60_000; // 18 minutes
const PAUSE_MS = 500; // pause between sequential tail fetches

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

function authorize(req: NextRequest): boolean {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) return false;
  return req.headers.get("authorization") === `Bearer ${cronSecret}`;
}

// ---------------------------------------------------------------------------
// Callsign map (same as aircraft/flights route)
// ---------------------------------------------------------------------------

async function getCallsignMap(): Promise<Map<string, string>> {
  const supa = createServiceClient();
  const { data } = await supa
    .from("ics_sources")
    .select("label, callsign")
    .not("callsign", "is", null);
  const map = new Map<string, string>();
  for (const row of data ?? []) {
    if (row.label && row.callsign) map.set(row.label, row.callsign);
  }
  return map;
}

// ---------------------------------------------------------------------------
// Filter logic (mirrors getActiveFlights in flightaware.ts)
// ---------------------------------------------------------------------------

function shouldIncludeFlight(f: FaFlight, now: number): boolean {
  // Skip cancelled (unless diverted)
  if (f.cancelled && !f.diverted) return false;

  // Skip flights with departure > 48h ago
  const dep = f.actual_out ?? f.estimated_out ?? f.scheduled_out;
  if (dep) {
    const depMs = new Date(dep).getTime();
    if (depMs < now - 48 * 3600_000) return false;
  }

  // Skip landed > 36h ago
  const landed = f.actual_in ?? f.actual_on;
  if (landed) {
    const landedMs = new Date(landed).getTime();
    if (landedMs < now - 36 * 3600_000) return false;
  }

  // Skip estimated arrival > 2h ago with no landing
  if (!landed) {
    const estArr = f.estimated_on ?? f.scheduled_on;
    if (estArr) {
      const estArrMs = new Date(estArr).getTime();
      if (estArrMs < now - 2 * 3600_000) return false;
    }
  }

  // Skip departed > 6h ago with no landing
  const actualDep = f.actual_out ?? f.actual_off;
  if (actualDep && !landed) {
    const actualDepMs = new Date(actualDep).getTime();
    if (actualDepMs < now - 6 * 3600_000) return false;
  }

  return true;
}

// ---------------------------------------------------------------------------
// Convert FlightInfo → fa_flights row for upsert
// ---------------------------------------------------------------------------

function toFaFlightsRow(info: FlightInfo) {
  return {
    fa_flight_id: info.fa_flight_id,
    tail: info.tail,
    ident: info.ident,
    origin_icao: info.origin_icao,
    origin_name: info.origin_name,
    destination_icao: info.destination_icao,
    destination_name: info.destination_name,
    status: info.status,
    progress_percent: info.progress_percent,
    departure_time: info.departure_time,
    arrival_time: info.arrival_time,
    scheduled_arrival: info.scheduled_arrival,
    actual_departure: info.actual_departure,
    actual_arrival: info.actual_arrival,
    route: info.route,
    route_distance_nm: info.route_distance_nm,
    filed_altitude: info.filed_altitude,
    diverted: info.diverted,
    cancelled: info.cancelled,
    aircraft_type: info.aircraft_type,
    latitude: info.latitude,
    longitude: info.longitude,
    altitude: info.altitude,
    groundspeed: info.groundspeed,
    heading: info.heading,
    updated_at: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Fetch + filter + enrich flights for a single tail
// ---------------------------------------------------------------------------

async function fetchAndProcessTail(
  tail: string,
  callsignMap: Map<string, string>,
): Promise<FlightInfo[]> {
  const now = Date.now();
  const rawFlights = await getFlightsByRegistration(tail, callsignMap);
  const results: FlightInfo[] = [];

  for (const f of rawFlights) {
    if (!shouldIncludeFlight(f, now)) continue;

    const info = toFlightInfo(tail, f);

    // Fetch position for en-route flights missing last_position
    const faEnRoute = f.status === "En Route" || f.status === "Diverted";
    if (
      info.latitude == null &&
      (f.actual_off != null || f.actual_out != null || faEnRoute) &&
      f.actual_on == null &&
      f.actual_in == null &&
      f.fa_flight_id
    ) {
      console.log(`[FA Poll] ${tail} ${f.fa_flight_id}: fetching position...`);
      const pos = await getFlightPosition(f.fa_flight_id);
      if (pos) {
        info.latitude = pos.latitude;
        info.longitude = pos.longitude;
        info.altitude = pos.altitude ?? null;
        info.groundspeed = pos.groundspeed ?? null;
        info.heading = pos.heading ?? null;
        console.log(`[FA Poll] ${tail}: position ${pos.latitude},${pos.longitude}`);
      }
    }

    results.push(info);
  }

  return results;
}

// ---------------------------------------------------------------------------
// Upsert flights into fa_flights table
// ---------------------------------------------------------------------------

async function upsertFlights(flights: FlightInfo[]): Promise<number> {
  if (flights.length === 0) return 0;
  const supa = createServiceClient();
  const rows = flights.map(toFaFlightsRow);

  const { error } = await supa
    .from("fa_flights")
    .upsert(rows, { onConflict: "fa_flight_id" });

  if (error) {
    console.error("[FA Poll] Upsert error:", error.message);
    return 0;
  }
  return rows.length;
}

// ---------------------------------------------------------------------------
// Mode 1: En-route polling
// ---------------------------------------------------------------------------

async function pollEnRoute(
  callsignMap: Map<string, string>,
): Promise<{ tails: string[]; flights: number; upserted: number }> {
  const supa = createServiceClient();

  // Find tails with active en-route/diverted flights
  const { data: enRouteRows } = await supa
    .from("fa_flights")
    .select("tail")
    .in("status", ["En Route", "Diverted"]);

  const tails = [...new Set((enRouteRows ?? []).map((r) => r.tail as string))];

  if (tails.length === 0) {
    console.log("[FA Poll] No en-route flights found");
    return { tails: [], flights: 0, upserted: 0 };
  }

  console.log(`[FA Poll] En-route polling: ${tails.length} tails [${tails.join(", ")}]`);

  let totalFlights = 0;
  let totalUpserted = 0;

  for (let i = 0; i < tails.length; i++) {
    try {
      const flights = await fetchAndProcessTail(tails[i], callsignMap);
      totalFlights += flights.length;
      totalUpserted += await upsertFlights(flights);
    } catch (err) {
      console.error(`[FA Poll] Error polling ${tails[i]}:`, err instanceof Error ? err.message : err);
    }
    if (i < tails.length - 1) {
      await new Promise((r) => setTimeout(r, PAUSE_MS));
    }
  }

  return { tails, flights: totalFlights, upserted: totalUpserted };
}

// ---------------------------------------------------------------------------
// Mode 2: Discovery polling
// ---------------------------------------------------------------------------

async function shouldRunDiscovery(): Promise<boolean> {
  const supa = createServiceClient();
  const { data } = await supa
    .from("fa_poll_state")
    .select("value")
    .eq("key", "last_discovery")
    .single();

  if (!data?.value) return true;

  const lastRun = new Date(data.value).getTime();
  return Date.now() - lastRun >= DISCOVERY_INTERVAL_MS;
}

async function pollDiscovery(
  callsignMap: Map<string, string>,
): Promise<{ tails: string[]; flights: number; upserted: number; cleaned: number }> {
  const supa = createServiceClient();
  const now = new Date();
  const past36h = new Date(now.getTime() - 36 * 3600_000).toISOString();
  const future4h = new Date(now.getTime() + 4 * 3600_000).toISOString();

  // Tails with scheduled flights in next 4h or last 36h
  const { data: dbFlights } = await supa
    .from("flights")
    .select("tail_number")
    .gte("scheduled_departure", past36h)
    .lte("scheduled_departure", future4h);

  const scheduledTails = (dbFlights ?? [])
    .map((f) => f.tail_number as string | null)
    .filter((t): t is string => !!t);

  // Fallback tails from maintenance data
  const fallbackTails = [...new Set(TRIPS.map((t) => t.tail))];

  const tails = [...new Set([...scheduledTails, ...fallbackTails])];

  console.log(
    `[FA Poll] Discovery: ${tails.length} tails (${scheduledTails.length} scheduled + ${fallbackTails.length} fallback, deduped)`,
  );

  let totalFlights = 0;
  let totalUpserted = 0;

  for (let i = 0; i < tails.length; i++) {
    try {
      const flights = await fetchAndProcessTail(tails[i], callsignMap);
      totalFlights += flights.length;
      totalUpserted += await upsertFlights(flights);
    } catch (err) {
      console.error(`[FA Poll] Error discovering ${tails[i]}:`, err instanceof Error ? err.message : err);
    }
    if (i < tails.length - 1) {
      await new Promise((r) => setTimeout(r, PAUSE_MS));
    }
  }

  // Cleanup: delete old completed flights (> 36h ago)
  const cutoff = new Date(now.getTime() - 36 * 3600_000).toISOString();
  const { count: cleaned } = await supa
    .from("fa_flights")
    .delete({ count: "exact" })
    .lt("actual_arrival", cutoff)
    .not("actual_arrival", "is", null);

  if (cleaned && cleaned > 0) {
    console.log(`[FA Poll] Cleaned ${cleaned} old completed flights`);
  }

  // Update last discovery timestamp
  await supa
    .from("fa_poll_state")
    .upsert({ key: "last_discovery", value: now.toISOString() }, { onConflict: "key" });

  return { tails, flights: totalFlights, upserted: totalUpserted, cleaned: cleaned ?? 0 };
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

export async function GET(req: NextRequest) {
  if (!authorize(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!process.env.FLIGHTAWARE_API_KEY) {
    return NextResponse.json({ error: "FLIGHTAWARE_API_KEY not configured" }, { status: 503 });
  }

  const startMs = Date.now();
  const callsignMap = await getCallsignMap();

  // Always run en-route polling
  console.log("[FA Poll] Starting en-route poll...");
  const enRouteResult = await pollEnRoute(callsignMap);
  console.log(
    `[FA Poll] En-route done: ${enRouteResult.upserted} upserted from ${enRouteResult.tails.length} tails`,
  );

  // Run discovery if interval elapsed OR no en-route flights (need to find new ones)
  let discoveryResult: Awaited<ReturnType<typeof pollDiscovery>> | null = null;
  const needsDiscovery = enRouteResult.tails.length === 0 || (await shouldRunDiscovery());

  if (needsDiscovery) {
    console.log("[FA Poll] Starting discovery poll...");
    discoveryResult = await pollDiscovery(callsignMap);
    console.log(
      `[FA Poll] Discovery done: ${discoveryResult.upserted} upserted from ${discoveryResult.tails.length} tails, ${discoveryResult.cleaned} cleaned`,
    );
  } else {
    console.log("[FA Poll] Skipping discovery (interval not elapsed)");
  }

  const elapsed = Date.now() - startMs;
  console.log(`[FA Poll] Complete in ${(elapsed / 1000).toFixed(1)}s`);

  return NextResponse.json({
    ok: true,
    elapsed_ms: elapsed,
    en_route: {
      tails: enRouteResult.tails,
      flights: enRouteResult.flights,
      upserted: enRouteResult.upserted,
    },
    discovery: discoveryResult
      ? {
          tails_count: discoveryResult.tails.length,
          flights: discoveryResult.flights,
          upserted: discoveryResult.upserted,
          cleaned: discoveryResult.cleaned,
        }
      : "skipped",
  });
}
