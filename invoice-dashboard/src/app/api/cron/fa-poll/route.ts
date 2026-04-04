import { NextRequest, NextResponse } from "next/server";
import { verifyCronSecret } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";
import {
  getFlightsByRegistration,
  getFlightPosition,
  getFleetViaOperator,
  toFlightInfo,
  type FaFlight,
  type FlightInfo,
} from "@/lib/flightaware";
import { TRIPS } from "@/lib/maintenanceData";
import { findNearestAirport } from "@/lib/airportCoords";
import { sendIntlAlertSlack } from "@/lib/intlAlertSlack";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const DISCOVERY_INTERVAL_MS = 30 * 60_000; // run discovery every 30 min (webhook catches real-time events)
const PAUSE_MS = 500; // pause between sequential tail fetches

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

function authorize(req: NextRequest): boolean {
  return verifyCronSecret(req);
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

  // Skip diverted flights with scheduled departure > 24h ago (stale diversions)
  if (f.diverted) {
    const divDep = f.actual_out ?? f.scheduled_out;
    if (divDep && new Date(divDep).getTime() < now - 24 * 3600_000) return false;
  }

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
    const estArr = f.predicted_on ?? f.estimated_on ?? f.scheduled_on;
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

    // Fetch position ONLY for flights that are actively en-route and missing position.
    // Skip if: already landed, or FA returned a last_position with the flight data.
    const faEnRoute = f.status === "En Route" || f.status === "Diverted";
    const isLanded = f.actual_on != null || f.actual_in != null;
    if (
      !isLanded &&
      faEnRoute &&
      info.latitude == null &&
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
// Link FA flights → ICS flights by fa_flight_id
// ---------------------------------------------------------------------------

/**
 * Normalize an airport code to a canonical form for matching.
 * Handles: ICAO K-prefix stripping (KFOK → FOK), TJ/MM/MY/MK prefix territories
 * (TJSJ = SJU, MMUN = CUN), and trims whitespace.
 *
 * The goal is to produce a 3-letter code that both FA and ICS data can agree on.
 */
function normIcao(code: string | null | undefined): string {
  if (!code) return "";
  const c = code.trim().toUpperCase();
  // US airports: strip K prefix (KFOK → FOK, KSJU → SJU)
  if (c.length === 4 && c.startsWith("K")) return c.slice(1);
  // Caribbean/Mexico/Canada territories: TJ, MM, MY, MK, MB prefixes → strip 1 char
  // e.g. TJSJ → JSJ? No — these use real ICAO. Let's just strip to last 3 for matching.
  // TJSJ → SJU won't work this way. We need an explicit map for known mismatches.
  return c;
}

/** Map of ICAO codes that FA uses → the FAA/ICS equivalent */
const ICAO_ALIASES: Record<string, string> = {
  // Caribbean / Territories — FA uses real ICAO, ICS often uses K-prefix or IATA
  TJSJ: "KSJU",  // San Juan, PR
  TJBQ: "KBQN",  // Aguadilla, PR
  TJIG: "KSIG",  // San Juan Isla Grande, PR
  TIST: "KSTT",  // St. Thomas, USVI
  TISX: "KSTX",  // St. Croix, USVI
  // Mexico
  MMUN: "MCUN",  // Cancun — may appear as CUN in ICS
  MMMX: "MMEX",  // Mexico City
  MMSD: "MSSD",  // San Jose del Cabo
  // Bahamas
  MYNN: "MYNN",  // Nassau — usually matches
  // Add more as discovered
};

/** Check if two airport codes match after normalization + alias expansion */
function airportsMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const na = normIcao(a);
  const nb = normIcao(b);
  if (na === nb) return true;

  // Check alias map in both directions
  const au = a.trim().toUpperCase();
  const bu = b.trim().toUpperCase();
  const aliasA = ICAO_ALIASES[au];
  const aliasB = ICAO_ALIASES[bu];
  if (aliasA && normIcao(aliasA) === nb) return true;
  if (aliasB && normIcao(aliasB) === na) return true;

  // Last resort: compare 3-letter IATA core (strip any prefix to get last 3 chars)
  if (na.length >= 3 && nb.length >= 3) {
    const iataA = na.length > 3 ? na.slice(-3) : na;
    const iataB = nb.length > 3 ? nb.slice(-3) : nb;
    if (iataA === iataB) return true;
  }

  return false;
}

async function linkFaToIcs(flights: FlightInfo[]): Promise<number> {
  if (flights.length === 0) return 0;
  const supa = createServiceClient();
  let linked = 0;

  for (const fa of flights) {
    if (!fa.fa_flight_id || !fa.tail || !fa.origin_icao || !fa.destination_icao) continue;

    const faDep = fa.departure_time ?? fa.actual_departure;
    if (!faDep) continue;

    const faDepMs = new Date(faDep).getTime();
    const windowStart = new Date(faDepMs - 3 * 3600_000).toISOString();
    const windowEnd = new Date(faDepMs + 3 * 3600_000).toISOString();

    // Query by tail + time window only (NOT route) — we'll filter routes in memory
    // to handle ICAO code mismatches (e.g. TJSJ vs KSJU)
    const { data: candidates } = await supa
      .from("flights")
      .select("id, scheduled_departure, fa_flight_id, departure_icao, arrival_icao")
      .eq("tail_number", fa.tail)
      .gte("scheduled_departure", windowStart)
      .lte("scheduled_departure", windowEnd);

    if (!candidates || candidates.length === 0) continue;

    // Filter by route using normalized airport code matching
    // For diverted flights, only require origin match — destination will differ
    const routeMatches = candidates.filter(
      (c) =>
        airportsMatch(c.departure_icao, fa.origin_icao) &&
        (fa.diverted || airportsMatch(c.arrival_icao, fa.destination_icao)),
    );

    if (routeMatches.length === 0) continue;

    // Pick closest by departure time, but protect existing valid links.
    // An "actually departed" FA flight (has actual_departure) should take priority
    // over a "Scheduled" FA duplicate that may have linked first.
    let bestId: string | null = null;
    let bestDiff = Infinity;
    for (const c of routeMatches) {
      // Skip if already correctly linked to THIS FA flight
      if (c.fa_flight_id === fa.fa_flight_id) {
        bestId = null;
        break;
      }
      if (c.fa_flight_id) {
        // Allow re-linking if THIS FA flight has actually departed but the
        // currently-linked FA flight is still "Scheduled" (FA duplicate).
        // This handles the case where FA creates two entries for the same
        // route — one stays "Scheduled", the other becomes "En Route".
        if (fa.actual_departure) {
          // Check if the currently-linked FA flight is still "Scheduled"
          const { data: linkedFa } = await supa
            .from("fa_flights")
            .select("status")
            .eq("fa_flight_id", c.fa_flight_id)
            .single();
          if (linkedFa?.status !== "Scheduled") continue; // don't steal from active flights
        } else {
          continue; // don't steal if we haven't actually departed
        }
      }
      const diff = Math.abs(new Date(c.scheduled_departure).getTime() - faDepMs);
      if (diff < bestDiff) {
        bestDiff = diff;
        bestId = c.id;
      }
    }

    if (bestId) {
      const { error } = await supa
        .from("flights")
        .update({ fa_flight_id: fa.fa_flight_id })
        .eq("id", bestId);

      if (!error) {
        linked++;
      } else {
        console.error(`[FA Poll] linkFaToIcs error for ${fa.fa_flight_id}:`, error.message);
      }
    }
  }

  if (linked > 0) {
    console.log(`[FA Poll] Linked ${linked} FA flights to ICS flights`);
  }
  return linked;
}

// ---------------------------------------------------------------------------
// Update ICS schedule when a flight diverts to a different airport
// ---------------------------------------------------------------------------

async function updateDivertedArrivals(flights: FlightInfo[]): Promise<number> {
  // For diverted flights, FA keeps destination as the ORIGINAL filed destination.
  // The actual diversion airport must be inferred from position data (lat/lon).
  // Only update when the flight has landed (actual_arrival set) to avoid premature overwrites.
  const diverted = flights.filter((f) =>
    f.diverted && f.fa_flight_id && f.actual_arrival != null
  );
  if (diverted.length === 0) return 0;

  const supa = createServiceClient();
  let updated = 0;

  for (const fa of diverted) {
    // Find the linked ICS flight
    const { data: icsFlights } = await supa
      .from("flights")
      .select("id, arrival_icao")
      .eq("fa_flight_id", fa.fa_flight_id)
      .limit(1);

    if (!icsFlights || icsFlights.length === 0) continue;
    const ics = icsFlights[0];

    // Determine actual diversion airport from last known position
    let diversionIcao: string | null = null;
    if (fa.latitude != null && fa.longitude != null) {
      const nearest = findNearestAirport(fa.latitude, fa.longitude);
      if (nearest) diversionIcao = nearest.code;
    }

    // Fallback: if no position data, use FA's destination (might be correct for some diversions)
    if (!diversionIcao) diversionIcao = fa.destination_icao;
    if (!diversionIcao) continue;

    // Normalize ICAO for comparison (3-letter US → K-prefix)
    const norm = (c: string | null) => c ? (c.length === 3 && /^[A-Z]/.test(c) ? `K${c}` : c) : null;
    const actualDest = norm(diversionIcao);
    const icsDest = norm(ics.arrival_icao);

    if (actualDest && icsDest && actualDest !== icsDest) {
      const { error } = await supa
        .from("flights")
        .update({ arrival_icao: actualDest, diverted: true })
        .eq("id", ics.id);

      if (!error) {
        console.log(`[FA Poll] Diversion: updated ${fa.tail} arrival ${icsDest} → ${actualDest}`);
        updated++;

        // Update the next leg's departure to the diversion airport with ? marker
        const { data: nextLegs } = await supa
          .from("flights")
          .select("id, departure_icao")
          .eq("tail_number", fa.tail)
          .eq("departure_icao", icsDest)
          .gt("scheduled_departure", fa.actual_arrival!)
          .order("scheduled_departure")
          .limit(1);

        if (nextLegs && nextLegs.length > 0) {
          await supa.from("flights")
            .update({ departure_icao: `${actualDest}?` })
            .eq("id", nextLegs[0].id);
          console.log(`[FA Poll] Diversion: updated next leg ${nextLegs[0].id} departure ${icsDest} → ${actualDest}?`);
        }
      }
    }
  }

  return updated;
}

// ---------------------------------------------------------------------------
// Confirm uncertain departures (clear ? suffix when FA shows actual departure)
// ---------------------------------------------------------------------------

async function confirmUncertainDepartures(flights: FlightInfo[]): Promise<number> {
  const departed = flights.filter((f) => f.fa_flight_id && f.actual_departure && f.origin_icao);
  if (departed.length === 0) return 0;

  const supa = createServiceClient();
  let confirmed = 0;

  for (const fa of departed) {
    // Find ICS flights with ? in departure_icao for this tail
    const { data: uncertain } = await supa
      .from("flights")
      .select("id, departure_icao")
      .eq("fa_flight_id", fa.fa_flight_id)
      .like("departure_icao", "%?")
      .limit(1);

    if (!uncertain || uncertain.length === 0) continue;

    const norm = (c: string | null) => c ? (c.length === 3 && /^[A-Z]/.test(c) ? `K${c}` : c) : null;
    const confirmedIcao = norm(fa.origin_icao);
    if (!confirmedIcao) continue;

    const { error } = await supa.from("flights")
      .update({ departure_icao: confirmedIcao })
      .eq("id", uncertain[0].id);

    if (!error) {
      console.log(`[FA Poll] Confirmed departure: ${fa.tail} ${uncertain[0].departure_icao} → ${confirmedIcao}`);
      confirmed++;
    }
  }

  return confirmed;
}

// ---------------------------------------------------------------------------
// Mode 1: En-route polling
// ---------------------------------------------------------------------------

async function pollEnRoute(
  callsignMap: Map<string, string>,
): Promise<{ tails: string[]; flights: number; upserted: number; skippedLanded: number }> {
  const supa = createServiceClient();

  // Find tails with active en-route/diverted flights
  const { data: enRouteRows } = await supa
    .from("fa_flights")
    .select("tail")
    .in("status", ["En Route", "Diverted"]);

  const enRouteTails = new Set((enRouteRows ?? []).map((r) => r.tail as string));

  // Only add tails from ICS that DON'T already have a landed status in fa_flights.
  // Previously this added ALL tails with a departure in the last 8h — even landed ones.
  // The webhook handles arrival events, so we only need to catch the gap where
  // a flight departed but FA hasn't sent the webhook yet.
  // Narrow to 2h window (was 8h) — if no webhook after 2h, the discovery poll catches it.
  const recentDepCutoff = new Date(Date.now() - 2 * 3600_000).toISOString();
  const { data: recentDepRows } = await supa
    .from("flights")
    .select("tail_number")
    .lt("scheduled_departure", new Date().toISOString())
    .gt("scheduled_departure", recentDepCutoff);

  // Check which of these tails already have a landed flight in fa_flights
  const { data: landedRows } = await supa
    .from("fa_flights")
    .select("tail")
    .in("status", ["Landed", "Arrived"]);
  const landedTails = new Set((landedRows ?? []).map((r) => r.tail as string));

  let skippedLanded = 0;
  for (const row of recentDepRows ?? []) {
    if (row.tail_number && !landedTails.has(row.tail_number)) {
      enRouteTails.add(row.tail_number);
    } else {
      skippedLanded++;
    }
  }

  const tails = [...enRouteTails];

  if (tails.length === 0) {
    console.log("[FA Poll] No en-route or recently-departed flights found");
    return { tails: [], flights: 0, upserted: 0, skippedLanded: 0 };
  }

  console.log(`[FA Poll] En-route polling: ${tails.length} tails [${tails.join(", ")}]`);

  let totalFlights = 0;
  let totalUpserted = 0;
  const allFlights: FlightInfo[] = [];

  for (let i = 0; i < tails.length; i++) {
    try {
      const flights = await fetchAndProcessTail(tails[i], callsignMap);
      totalFlights += flights.length;
      totalUpserted += await upsertFlights(flights);
      allFlights.push(...flights);
    } catch (err) {
      console.error(`[FA Poll] Error polling ${tails[i]}:`, err instanceof Error ? err.message : err);
    }
    if (i < tails.length - 1) {
      await new Promise((r) => setTimeout(r, PAUSE_MS));
    }
  }

  // Link FA flights to ICS flights by fa_flight_id
  await linkFaToIcs(allFlights);

  // Update ICS arrival airport for diverted flights
  await updateDivertedArrivals(allFlights);

  // Confirm uncertain departures (clear ? suffix)
  await confirmUncertainDepartures(allFlights);

  return { tails, flights: totalFlights, upserted: totalUpserted, skippedLanded };
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
  _callsignMap: Map<string, string>,
): Promise<{ tails: string[]; flights: number; upserted: number; cleaned: number }> {
  const supa = createServiceClient();
  const now = new Date();
  const nowMs = now.getTime();

  // Use operator endpoint — fetches all fleet flights in ~5 paginated calls
  // instead of 20+ per-tail calls (~75-80% cost savings)
  const { flights: rawFlights, apiCalls } = await getFleetViaOperator("KOW");

  console.log(`[FA Poll] Discovery via /operators/KOW: ${rawFlights.length} flights in ${apiCalls} API calls`);

  // Group by registration (tail), filter, convert to FlightInfo
  const allFlights: FlightInfo[] = [];
  const tailSet = new Set<string>();

  for (const f of rawFlights) {
    const tail = f.registration ?? f.ident?.replace(/^KOW/, "N") ?? null;
    if (!tail) continue;
    tailSet.add(tail);

    if (!shouldIncludeFlight(f, nowMs)) continue;

    const info = toFlightInfo(tail, f);

    // Fetch position ONLY for actively en-route flights missing position
    const faEnRoute = f.status === "En Route" || f.status === "Diverted";
    const isLanded = f.actual_on != null || f.actual_in != null;
    if (
      !isLanded &&
      faEnRoute &&
      info.latitude == null &&
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
      }
    }

    allFlights.push(info);
  }

  const tails = [...tailSet];
  const totalFlights = allFlights.length;
  const totalUpserted = await upsertFlights(allFlights);

  console.log(`[FA Poll] Discovery: ${totalFlights} flights from ${tails.length} tails (${apiCalls} API calls vs ~${tails.length} old per-tail calls)`);

  // Link FA flights to ICS flights by fa_flight_id
  await linkFaToIcs(allFlights);

  // Update ICS arrival airport for diverted flights
  await updateDivertedArrivals(allFlights);

  // Confirm uncertain departures (clear ? suffix)
  await confirmUncertainDepartures(allFlights);

  // Cleanup: delete old completed flights (> 36h ago)
  const cutoff = new Date(now.getTime() - 36 * 3600_000).toISOString();
  const { count: cleaned1 } = await supa
    .from("fa_flights")
    .delete({ count: "exact" })
    .lt("actual_arrival", cutoff)
    .not("actual_arrival", "is", null);

  // Also clean any flight that never recorded a landing and hasn't been updated in 36h.
  // This catches En Route / Scheduled flights where FA lost track and never sent actual_arrival.
  // Without this, ghost tracks persist on the map indefinitely.
  const { count: cleaned2 } = await supa
    .from("fa_flights")
    .delete({ count: "exact" })
    .is("actual_arrival", null)
    .lt("updated_at", cutoff);

  const cleaned = (cleaned1 ?? 0) + (cleaned2 ?? 0);

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
// Verify pending diversions (delayed alert verification)
// ---------------------------------------------------------------------------

/**
 * Check pending diversion records that are at least 5 minutes old.
 * Re-verify against the freshly-updated fa_flights table:
 * - If FA still shows diverted → confirm and fire the alert + Slack
 * - If FA no longer shows diverted → suppress (false positive)
 * - Auto-confirm anything older than 30 min (safety net)
 */
async function verifyPendingDiversions(): Promise<{ confirmed: number; suppressed: number }> {
  const supa = createServiceClient();
  const fiveMinAgo = new Date(Date.now() - 5 * 60_000).toISOString();
  const thirtyMinAgo = new Date(Date.now() - 30 * 60_000).toISOString();

  const { data: pending } = await supa
    .from("pending_diversions")
    .select("id, fa_flight_id, registration, origin_icao, destination_icao, original_destination, flight_id, diversion_message, distance_suspect, created_at")
    .eq("status", "pending")
    .lte("created_at", fiveMinAgo);

  if (!pending || pending.length === 0) return { confirmed: 0, suppressed: 0 };

  console.log(`[FA Poll] Verifying ${pending.length} pending diversion(s)`);

  let confirmed = 0;
  let suppressed = 0;

  for (const p of pending) {
    const isStale = new Date(p.created_at).getTime() < new Date(thirtyMinAgo).getTime();

    // Look up the flight in fa_flights (freshly updated by pollEnRoute/pollDiscovery)
    const { data: faRows } = await supa
      .from("fa_flights")
      .select("fa_flight_id, status, diverted, cancelled")
      .eq("fa_flight_id", p.fa_flight_id)
      .limit(1);

    const faFlight = faRows?.[0];
    const stillDiverted = faFlight?.diverted === true;

    // Check for an alert that was already created (e.g. by another path)
    const { count: existingAlert } = await supa
      .from("intl_leg_alerts")
      .select("id", { count: "exact", head: true })
      .eq("flight_id", p.flight_id)
      .eq("alert_type", "diversion")
      .eq("acknowledged", false);

    if ((existingAlert ?? 0) > 0) {
      // Alert already exists — mark as confirmed and move on
      await supa.from("pending_diversions")
        .update({ status: "confirmed", verified_at: new Date().toISOString() })
        .eq("id", p.id);
      confirmed++;
      continue;
    }

    if (stillDiverted || isStale) {
      // Confirmed: FA still shows diverted (or record is >30min old — safety net)
      const reason = isStale && !stillDiverted ? "auto-confirmed (>30min)" : "FA confirms diverted";
      console.log(`[FA Poll] Diversion CONFIRMED for ${p.registration}: ${reason}`);

      // Insert the alert
      await supa.from("intl_leg_alerts").insert({
        flight_id: p.flight_id,
        alert_type: "diversion",
        severity: "critical",
        message: p.diversion_message,
      });

      // Fire Slack
      await sendIntlAlertSlack([{
        flight_id: p.flight_id,
        alert_type: "diversion",
        severity: "critical",
        message: p.diversion_message,
      }]);

      await supa.from("pending_diversions")
        .update({ status: "confirmed", verified_at: new Date().toISOString() })
        .eq("id", p.id);
      confirmed++;
    } else {
      // Suppressed: FA no longer shows flight as diverted
      console.log(`[FA Poll] Diversion SUPPRESSED for ${p.registration}: FA status=${faFlight?.status ?? "not found"}`);

      await supa.from("pending_diversions")
        .update({ status: "suppressed", verified_at: new Date().toISOString() })
        .eq("id", p.id);
      suppressed++;
    }
  }

  // Cleanup: delete records older than 24h to prevent table bloat
  const oneDayAgo = new Date(Date.now() - 24 * 3600_000).toISOString();
  await supa.from("pending_diversions")
    .delete()
    .neq("status", "pending")
    .lt("created_at", oneDayAgo);

  return { confirmed, suppressed };
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

  // Verify pending diversions (delayed alert verification)
  const diversionResult = await verifyPendingDiversions();
  if (diversionResult.confirmed > 0 || diversionResult.suppressed > 0) {
    console.log(
      `[FA Poll] Diversions: ${diversionResult.confirmed} confirmed, ${diversionResult.suppressed} suppressed`,
    );
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
    diversions: diversionResult,
  });
}
