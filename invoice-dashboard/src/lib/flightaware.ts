/**
 * FlightAware AeroAPI v4 client
 *
 * Docs: https://www.flightaware.com/aeroapi/portal/documentation
 * Base: https://aeroapi.flightaware.com/aeroapi/
 * Auth: x-apikey header
 *
 * Also used for bulk schedule fetching: instead of 2000+ HasData calls per
 * crew member, we fetch ALL scheduled departures from each unique crew home
 * airport (~60 calls) on the swap date. Route computation then matches
 * flights to destinations locally.
 */

import type { FlightOffer } from "./amadeus";

const BASE = "https://aeroapi.flightaware.com/aeroapi";

function apiKey(): string {
  const key = process.env.FLIGHTAWARE_API_KEY;
  if (!key) throw new Error("FLIGHTAWARE_API_KEY not set");
  return key;
}

function headers() {
  return { "x-apikey": apiKey(), Accept: "application/json; charset=UTF-8" };
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FaAirport = {
  code: string | null;        // ICAO code (e.g. "KTEB")
  code_iata: string | null;   // IATA code (e.g. "TEB")
  code_icao: string | null;
  code_lid: string | null;
  name: string | null;
  city: string | null;
  state: string | null;
};

export type FaPosition = {
  latitude: number;
  longitude: number;
  altitude: number | null;
  groundspeed: number | null;
  heading: number | null;
  timestamp: string | null;
};

export type FaFlight = {
  ident: string;              // e.g. "KOW102"
  fa_flight_id: string;
  operator: string | null;
  registration: string | null; // tail number e.g. "N102VR"
  aircraft_type: string | null;
  origin: FaAirport | null;
  destination: FaAirport | null;
  // OOOI times (ISO 8601)
  scheduled_out: string | null;
  estimated_out: string | null;
  actual_out: string | null;
  scheduled_off: string | null;
  estimated_off: string | null;
  actual_off: string | null;
  scheduled_on: string | null;
  estimated_on: string | null;
  actual_on: string | null;
  scheduled_in: string | null;
  estimated_in: string | null;
  actual_in: string | null;
  // Route
  route: string | null;
  route_distance: number | null; // nautical miles
  filed_ete: number | null;      // filed enroute time (seconds)
  filed_airspeed: number | null;
  filed_altitude: number | null;
  progress_percent: number | null;
  status: string | null;         // e.g. "En Route", "Landed", "Scheduled"
  departure_delay: number | null;
  arrival_delay: number | null;
  diverted: boolean;
  cancelled: boolean;
  // Position (available for en-route flights)
  last_position: FaPosition | null;
};

// Simplified version for the dashboard
export type FlightInfo = {
  tail: string;
  ident: string;
  fa_flight_id: string;
  origin_icao: string | null;
  origin_name: string | null;
  destination_icao: string | null;
  destination_name: string | null;
  status: string | null;
  progress_percent: number | null;
  // Times
  departure_time: string | null;   // actual or estimated gate out
  arrival_time: string | null;     // estimated runway on (ETA)
  scheduled_arrival: string | null;
  actual_departure: string | null; // actual gate out
  actual_arrival: string | null;   // actual gate in
  // Route
  route: string | null;
  route_distance_nm: number | null;
  filed_altitude: number | null;
  // Flags
  diverted: boolean;
  cancelled: boolean;
  // Aircraft
  aircraft_type: string | null; // ICAO type code e.g. "C750", "CL30", "CL35"
  // Position (from FlightAware, for en-route flights)
  latitude: number | null;
  longitude: number | null;
  altitude: number | null;
  groundspeed: number | null;
  heading: number | null;
};

// ---------------------------------------------------------------------------
// API calls
// ---------------------------------------------------------------------------

/**
 * Get recent and upcoming flights for a registration (tail number).
 * If a DB callsign exists, queries by callsign directly (skips N-number).
 * Otherwise queries by N-number with auto-derived KOW fallback.
 *
 * @param callsignMap — optional map of registration → callsign from ics_sources DB table
 */
export async function getFlightsByRegistration(
  registration: string,
  callsignMap?: Map<string, string>,
): Promise<FaFlight[]> {
  const dbCallsign = callsignMap?.get(registration);

  // Query by N-number first — returns last_position with lat/lon for map tracking.
  // Callsign queries return flight data but NOT positions.
  // Use start param to include yesterday's flights (duty tracker needs 3-day window).
  const startDate = new Date(Date.now() - 48 * 3600_000).toISOString();
  const url = `${BASE}/flights/${encodeURIComponent(registration)}?start=${encodeURIComponent(startDate)}`;
  const res = await fetch(url, {
    headers: headers(),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) {
    if (res.status === 401) throw new Error("FlightAware: invalid API key");
    if (res.status === 429) throw new Error("FlightAware: rate limited");
    return [];
  }
  const data = await res.json();
  let flights = (data.flights ?? []) as FaFlight[];
  console.log(`[FA] ${registration}: ${flights.length} flights`);

  // Fallback: if N-number returned nothing (LADD-blocked), try callsign
  if (flights.length === 0) {
    const fallbackIdent = dbCallsign ?? (() => {
      const digits = registration.replace(/\D/g, "");
      return digits ? `KOW${digits}` : null;
    })();
    if (fallbackIdent) {
      console.log(`[FA] ${registration}: trying callsign fallback ${fallbackIdent}`);
      const fbUrl = `${BASE}/flights/${encodeURIComponent(fallbackIdent)}`;
      try {
        const fbRes = await fetch(fbUrl, {
          headers: headers(),
          signal: AbortSignal.timeout(10000),
        });
        if (fbRes.ok) {
          const fbData = await fbRes.json();
          flights = (fbData.flights ?? []) as FaFlight[];
          console.log(`[FA] ${fallbackIdent}: ${flights.length} flights (fallback for ${registration})`);
        }
      } catch { /* ignore fallback errors */ }
    }
  }

  return flights;
}

/**
 * Get the last position for a specific flight by fa_flight_id.
 */
async function getFlightPosition(
  faFlightId: string,
): Promise<FaPosition | null> {
  const url = `${BASE}/flights/${encodeURIComponent(faFlightId)}/position`;
  try {
    const res = await fetch(url, {
      headers: headers(),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    // The position endpoint returns the last position directly
    if (data.last_position) return data.last_position as FaPosition;
    // Or it might return position fields at top level
    if (data.latitude != null && data.longitude != null) return data as FaPosition;
    return null;
  } catch {
    return null;
  }
}

export type FaTrackPoint = {
  latitude: number;
  longitude: number;
  altitude: number | null;
  groundspeed: number | null;
  heading: number | null;
  timestamp: string;
};

/**
 * Get the full flight track (list of positions) for a specific flight by fa_flight_id.
 * Follows FA pagination if the first page is empty but more pages exist.
 */
export async function getFlightTrack(
  faFlightId: string,
): Promise<FaTrackPoint[]> {
  let url: string | null = `${BASE}/flights/${encodeURIComponent(faFlightId)}/track?include_estimated_positions=true`;
  const allPositions: FaTrackPoint[] = [];

  try {
    // Follow up to 3 pages (most flights fit in 1-2)
    for (let page = 0; page < 3 && url; page++) {
      const res = await fetch(url, {
        headers: headers(),
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) {
        console.warn(`[FA Track] ${faFlightId}: HTTP ${res.status} (page ${page})`);
        break;
      }
      const data = await res.json();
      const positions = (data.positions ?? data.track ?? []) as FaTrackPoint[];
      allPositions.push(...positions);

      // Check for next page
      const nextLink = data.links?.next as string | undefined;
      if (nextLink && positions.length > 0) {
        // FA returns relative or absolute URLs
        url = nextLink.startsWith("http") ? nextLink : `${BASE}${nextLink}`;
      } else {
        url = null;
      }
    }

    if (allPositions.length === 0) {
      console.warn(`[FA Track] ${faFlightId}: no positions after pagination`);
    }
    return allPositions;
  } catch (err) {
    console.error(`[FA Track] ${faFlightId}: fetch error`, err);
    return allPositions.length > 0 ? allPositions : [];
  }
}

/**
 * For a list of tail numbers, return all recent flights from FlightAware
 * (within 12 hours past + upcoming). Includes completed, en-route, and scheduled.
 * Only fetches position for the single active en-route flight per tail (to limit API calls).
 */
export async function getActiveFlights(
  tails: string[],
  callsignMap?: Map<string, string>,
): Promise<FlightInfo[]> {
  const results: FlightInfo[] = [];
  const now = Date.now();

  // Query in batches of 3 to stay well under rate limits
  const BATCH = 3;
  for (let i = 0; i < tails.length; i += BATCH) {
    const batch = tails.slice(i, i + BATCH);
    const batchResults = await Promise.all(
      batch.map(async (tail) => {
        try {
          const flights = await getFlightsByRegistration(tail, callsignMap);
          const recent: FlightInfo[] = [];

          for (const f of flights) {
            if (f.cancelled) continue;
            // Include flights from last 48 hours + upcoming (daily baseline needs wider window)
            const dep = f.actual_out ?? f.estimated_out ?? f.scheduled_out;
            if (dep) {
              const depMs = new Date(dep).getTime();
              if (depMs < now - 48 * 3600_000) continue;
            }
            // Filter out completed flights older than 36 hours.
            // The duty tracker needs yesterday's actual times for 10/24 calculations.
            // Map components filter en-route vs ground aircraft separately.
            const landed = f.actual_in ?? f.actual_on;
            if (landed) {
              const landedMs = new Date(landed).getTime();
              if (landedMs < now - 36 * 3600_000) continue;
            }
            // Filter flights whose estimated arrival passed >2h ago with no
            // actual landing recorded — FA lost track, flight is done.
            if (!landed) {
              const estArr = f.estimated_on ?? f.scheduled_on;
              if (estArr) {
                const estArrMs = new Date(estArr).getTime();
                if (estArrMs < now - 2 * 3600_000) continue;
              }
            }
            // Also filter flights that departed >6h ago with no landing recorded.
            // No Baker charter exceeds 6 hours enroute.
            const actualDep = f.actual_out ?? f.actual_off;
            if (actualDep && !landed) {
              const actualDepMs = new Date(actualDep).getTime();
              if (actualDepMs < now - 6 * 3600_000) continue;
            }

            const info = toFlightInfo(tail, f);

            // Fetch position for any en-route flight missing last_position
            // Check actual_off (wheels off) OR actual_out (gate departure) — FA
            // sometimes returns only actual_out without actual_off.
            // Also fetch if estimated departure has passed (FA may still say "Scheduled"
            // but plane is airborne — e.g. N733FL scenario).
            const estDep = f.estimated_off ?? f.estimated_out ?? f.scheduled_off ?? f.scheduled_out;
            const estDepPassed = estDep && new Date(estDep).getTime() < now;
            if (
              info.latitude == null &&
              (f.actual_off != null || f.actual_out != null || estDepPassed) &&
              f.actual_on == null &&
              f.fa_flight_id
            ) {
              console.log(`[FA Pos] ${tail} ${f.fa_flight_id}: last_position missing, fetching...`);
              const pos = await getFlightPosition(f.fa_flight_id);
              if (pos) {
                console.log(`[FA Pos] ${tail}: got position ${pos.latitude},${pos.longitude}`);
                info.latitude = pos.latitude;
                info.longitude = pos.longitude;
                info.altitude = pos.altitude ?? null;
                info.groundspeed = pos.groundspeed ?? null;
                info.heading = pos.heading ?? null;
              } else {
                console.log(`[FA Pos] ${tail} ${f.fa_flight_id}: position fetch returned null`);
              }
            }

            recent.push(info);
          }

          return recent;
        } catch {
          return [];
        }
      }),
    );
    for (const batch of batchResults) {
      results.push(...batch);
    }
    // Rate limit pause between batches
    if (i + BATCH < tails.length) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pickActiveFlight(flights: FaFlight[]): FaFlight | null {
  if (!flights.length) return null;

  // Prefer en-route flights
  const enRoute = flights.find(
    (f) =>
      f.actual_off != null &&
      f.actual_on == null &&
      !f.cancelled,
  );
  if (enRoute) return enRoute;

  // Then flights that departed recently (within 12 hours)
  const now = Date.now();
  const recent = flights.find((f) => {
    const dep = f.actual_out ?? f.estimated_out ?? f.scheduled_out;
    if (!dep) return false;
    const depMs = new Date(dep).getTime();
    return depMs > now - 12 * 3600_000 && !f.cancelled;
  });
  if (recent) return recent;

  // Then upcoming scheduled flights
  const upcoming = flights.find((f) => {
    const dep = f.scheduled_out ?? f.estimated_out;
    if (!dep) return false;
    return new Date(dep).getTime() > now && !f.cancelled;
  });
  return upcoming ?? null;
}

function toFlightInfo(tail: string, f: FaFlight): FlightInfo {
  return {
    tail,
    ident: f.ident,
    fa_flight_id: f.fa_flight_id,
    origin_icao: f.origin?.code_icao ?? f.origin?.code ?? null,
    origin_name: f.origin?.name ?? null,
    destination_icao: f.destination?.code_icao ?? f.destination?.code ?? null,
    destination_name: f.destination?.name ?? null,
    status: f.status,
    progress_percent: f.progress_percent,
    departure_time: f.actual_out ?? f.estimated_out ?? f.estimated_off ?? f.scheduled_out,
    arrival_time: f.estimated_on ?? f.scheduled_on,
    scheduled_arrival: f.scheduled_on,
    actual_departure: f.actual_out ?? f.actual_off ?? null,
    actual_arrival: f.actual_in ?? f.actual_on ?? null,
    route: f.route,
    route_distance_nm: f.route_distance,
    filed_altitude: f.filed_altitude,
    diverted: f.diverted,
    cancelled: f.cancelled,
    aircraft_type: f.aircraft_type ?? null,
    latitude: f.last_position?.latitude ?? null,
    longitude: f.last_position?.longitude ?? null,
    altitude: f.last_position?.altitude ?? null,
    groundspeed: f.last_position?.groundspeed ?? null,
    heading: f.last_position?.heading ?? null,
  };
}

// ---------------------------------------------------------------------------
// Bulk Schedule Fetching (for swap optimizer route computation)
// ---------------------------------------------------------------------------

/** Normalized scheduled flight from FlightAware timetable data */
export type ScheduledFlight = {
  flight_number: string;       // e.g. "AA2345"
  airline_iata: string;        // e.g. "AA"
  origin_icao: string;         // e.g. "KDFW"
  origin_iata: string;         // e.g. "DFW"
  destination_icao: string;    // e.g. "KEWR"
  destination_iata: string;    // e.g. "EWR"
  scheduled_departure: string; // ISO 8601 UTC
  scheduled_arrival: string;   // ISO 8601 UTC
  aircraft_type: string | null;
  duration_minutes: number;
};

/**
 * A single flight from the /schedules/ endpoint.
 * Fields are FLAT (origin is a string "KDFW", not an object),
 * unlike the /flights/ endpoints which use nested FaAirport objects.
 */
type FaScheduleEntry = {
  ident: string;               // e.g. "AAL1489" or codeshare "GFA4220"
  ident_iata?: string;         // e.g. "AA1489"
  actual_ident?: string | null; // operating carrier if this is a codeshare
  fa_flight_id?: string;
  aircraft_type?: string | null;
  origin: string;              // ICAO e.g. "KDFW"
  origin_icao: string;
  origin_iata: string;
  destination: string;
  destination_icao: string;
  destination_iata: string;
  scheduled_out: string;       // ISO 8601
  scheduled_in: string;
};

/**
 * Fetch all scheduled departures from an airport on a specific date.
 * Uses GET /schedules/{start}/{end}?origin={ICAO}
 * This endpoint supports future dates (unlike /airports/.../scheduled_departures
 * which is limited to 2 days ahead).
 */
export async function fetchScheduledDepartures(
  originIcao: string,
  date: string,
): Promise<ScheduledFlight[]> {
  const start = `${date}T00:00:00Z`;
  const end = `${date}T23:59:59Z`;
  const flights: ScheduledFlight[] = [];
  const seenFlightIds = new Set<string>(); // dedupe codeshares
  let cursor: string | null = null;
  let page = 0;

  let url: string = `${BASE}/schedules/${start}/${end}?origin=${originIcao}&max_pages=5`;

  do {
    if (cursor) {
      url = cursor.startsWith("http") ? cursor : `${BASE}${cursor}`;
    }

    const res = await fetch(url, {
      headers: headers(),
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) {
      const text = await res.text();
      console.warn(`[FA Sched] ${res.status} for ${originIcao} on ${date}: ${text.slice(0, 200)}`);
      if (res.status === 401) throw new Error("FlightAware: invalid API key");
      if (res.status === 429) {
        console.warn("[FA Sched] Rate limited — backing off");
        await new Promise((r) => setTimeout(r, 3000));
        continue;
      }
      break;
    }

    const data = await res.json();
    const scheduled: FaScheduleEntry[] = data.scheduled ?? [];

    for (const f of scheduled) {
      if (!f.scheduled_out || !f.scheduled_in) continue;
      if (!f.destination_icao) continue;

      // Skip codeshares — only keep the operating carrier's entry
      // A codeshare has actual_ident set (the real operating flight)
      if (f.actual_ident) continue;

      // Dedupe by fa_flight_id
      if (f.fa_flight_id && seenFlightIds.has(f.fa_flight_id)) continue;
      if (f.fa_flight_id) seenFlightIds.add(f.fa_flight_id);

      const depMs = new Date(f.scheduled_out).getTime();
      const arrMs = new Date(f.scheduled_in).getTime();
      const durationMin = Math.round((arrMs - depMs) / 60_000);
      if (durationMin <= 0 || durationMin > 720) continue;

      // Use ident_iata for a cleaner flight number (e.g. "AA1489" not "AAL1489")
      const flightNum = f.ident_iata ?? f.ident ?? "???";
      const airlineIata = flightNum.replace(/\d+$/, "").slice(0, 2);

      flights.push({
        flight_number: flightNum,
        airline_iata: airlineIata,
        origin_icao: f.origin_icao ?? f.origin,
        origin_iata: f.origin_iata ?? icaoToIata(f.origin_icao ?? f.origin),
        destination_icao: f.destination_icao ?? f.destination,
        destination_iata: f.destination_iata ?? icaoToIata(f.destination_icao ?? f.destination),
        scheduled_departure: f.scheduled_out,
        scheduled_arrival: f.scheduled_in,
        aircraft_type: f.aircraft_type ?? null,
        duration_minutes: durationMin,
      });
    }

    cursor = data.links?.next ?? null;
    page++;
  } while (cursor && page < 5);

  return flights;
}

/**
 * Fetch scheduled departures from ALL unique crew home airports on a swap date.
 * ~60 API calls total (~$3). Returns a map of origin_iata → flights.
 */
export async function fetchAllCrewSchedules(
  homeAirports: string[],
  date: string,
): Promise<{
  flightsByOrigin: Map<string, ScheduledFlight[]>;
  totalFlights: number;
  apiCalls: number;
  errors: string[];
}> {
  const uniqueAirports = [...new Set(homeAirports.map((a) => a.toUpperCase()))];
  const flightsByOrigin = new Map<string, ScheduledFlight[]>();
  const errors: string[] = [];
  let apiCalls = 0;

  console.log(`[FA Sched] Fetching schedules for ${uniqueAirports.length} airports on ${date}`);

  // Process in batches of 5
  for (let i = 0; i < uniqueAirports.length; i += 5) {
    const batch = uniqueAirports.slice(i, i + 5);
    const results = await Promise.all(
      batch.map(async (airport) => {
        const icao = airport.length === 3 ? `K${airport}` : airport;
        try {
          apiCalls++;
          const flights = await fetchScheduledDepartures(icao, date);
          return { airport, flights, error: null };
        } catch (e) {
          return { airport, flights: [] as ScheduledFlight[], error: `${airport}: ${e instanceof Error ? e.message : "unknown"}` };
        }
      }),
    );

    for (const r of results) {
      if (r.error) errors.push(r.error);
      if (r.flights.length > 0) {
        flightsByOrigin.set(r.airport, r.flights);
      }
    }

    if (i + 5 < uniqueAirports.length) {
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  let totalFlights = 0;
  for (const flights of flightsByOrigin.values()) totalFlights += flights.length;

  console.log(`[FA Sched] Done: ${totalFlights} flights from ${flightsByOrigin.size} airports in ${apiCalls} calls`);
  return { flightsByOrigin, totalFlights, apiCalls, errors };
}

/**
 * Convert FlightAware ScheduledFlights to the FlightOffer format the optimizer uses.
 * Groups by origin-destination-date key.
 */
export function scheduledFlightsToOffers(
  flights: ScheduledFlight[],
  date: string,
): Map<string, FlightOffer[]> {
  const offerMap = new Map<string, FlightOffer[]>();

  for (const f of flights) {
    const key = `${f.origin_iata}-${f.destination_iata}-${date}`;
    if (!offerMap.has(key)) offerMap.set(key, []);

    // FlightAware doesn't provide pricing — estimate based on duration
    const estimatedPrice = estimateFlightPrice(f.duration_minutes, f.airline_iata);

    const offer: FlightOffer = {
      id: f.flight_number,
      price: { total: String(estimatedPrice), currency: "USD" },
      itineraries: [{
        duration: `PT${Math.floor(f.duration_minutes / 60)}H${f.duration_minutes % 60}M`,
        segments: [{
          departure: { iataCode: f.origin_iata, at: f.scheduled_departure },
          arrival: { iataCode: f.destination_iata, at: f.scheduled_arrival },
          carrierCode: f.airline_iata,
          number: f.flight_number.replace(/^[A-Z]{1,3}/, ""),
          duration: `PT${Math.floor(f.duration_minutes / 60)}H${f.duration_minutes % 60}M`,
          numberOfStops: 0,
        }],
      }],
      numberOfBookableSeats: 9,
    };

    offerMap.get(key)!.push(offer);
  }

  return offerMap;
}

/** Estimate one-way economy fare from duration + airline (no pricing from FlightAware) */
function estimateFlightPrice(durationMin: number, airline: string): number {
  const budgetCarriers = new Set(["F9", "NK", "G4", "WN", "B6"]);
  const mult = budgetCarriers.has(airline) ? 0.7 : 1.0;
  return Math.min(Math.round((50 + durationMin * 1.5) * mult), 500);
}

function icaoToIata(code: string): string {
  if (code.length === 4 && code.startsWith("K")) return code.slice(1);
  return code;
}
