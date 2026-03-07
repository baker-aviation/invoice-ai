/**
 * Baker Aviation — AOG Van shared utilities
 *
 * Extracted from VanPositioningClient.tsx for reuse in the van driver view
 * and other van-related components.
 */

import type { Flight } from "@/lib/opsApi";
import { getAirportInfo } from "@/lib/airportCoords";
import { haversineKm, FIXED_VAN_ZONES, isContiguous48 } from "@/lib/maintenanceData";

// Re-exports for convenience
export { getAirportInfo } from "@/lib/airportCoords";
export { haversineKm, FIXED_VAN_ZONES, isContiguous48 } from "@/lib/maintenanceData";
export type { VanZone } from "@/lib/maintenanceData";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DISPLAY_TZ = "America/New_York";

/** Max one-way driving radius for schedule arrivals (~2.2h drive). */
const SCHEDULE_ARRIVAL_RADIUS_KM = 200;

/** Max arrivals per van zone. */
const MAX_ARRIVALS_PER_VAN = 4;

// Flight type keywords matching OpsBoard logic
const FLIGHT_TYPE_KEYWORDS = [
  "Revenue", "Owner", "Positioning", "Maintenance", "Training",
  "Ferry", "Cargo", "Needs pos", "Crew conflict", "Time off",
  "Assignment", "Transient",
];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type VanFlightItem = {
  arrFlight: Flight;
  nextDep:   Flight | null;
  isRepo:    boolean;   // arriving leg is positioning
  nextIsRepo: boolean;  // next departure is positioning
  airport:   string;    // IATA
  airportInfo: ReturnType<typeof getAirportInfo>;
  distKm:    number;
};

export type FlightInfoEntry = {
  tail: string;
  ident: string;
  origin_icao: string | null;
  origin_name: string | null;
  destination_icao: string | null;
  destination_name: string | null;
  status: string | null;
  progress_percent: number | null;
  departure_time: string | null;
  arrival_time: string | null;
  route_distance_nm: number | null;
  diverted: boolean;
  latitude?: number | null;
  longitude?: number | null;
  altitude?: number | null;
  groundspeed?: number | null;
  heading?: number | null;
};

// ---------------------------------------------------------------------------
// Date / time helpers
// ---------------------------------------------------------------------------

function utcToEtDate(utcIso: string): string {
  return new Date(utcIso).toLocaleDateString("en-CA", { timeZone: DISPLAY_TZ });
}

/** Check if a UTC ISO string falls on a given ET date (YYYY-MM-DD). */
export function isOnEtDate(utcIso: string | null | undefined, etDate: string): boolean {
  if (!utcIso) return false;
  return utcToEtDate(utcIso) === etDate;
}

/** Format km to driving time string, assuming 90 km/h average. */
export function fmtDriveTime(distKm: number): string {
  const totalMins = Math.round(distKm / 90 * 60);
  const h = Math.floor(totalMins / 60);
  const m = totalMins % 60;
  if (h === 0) return `${m}m drive`;
  return m === 0 ? `${h}h drive` : `${h}h ${m}m drive`;
}

/** Format a UTC ISO timestamp to "HH:MM ET". */
export function fmtUtcHM(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "\u2014";
  return (
    d.toLocaleTimeString("en-US", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZone: DISPLAY_TZ,
    }) + " ET"
  );
}

/** "in 2h 15m" or "in 45m" until a future ISO timestamp. Returns "" if in the past. */
export function fmtTimeUntil(iso: string): string {
  const diff = new Date(iso).getTime() - Date.now();
  if (diff <= 0) return "";
  const h = Math.floor(diff / 3600000);
  const m = Math.floor((diff % 3600000) / 60000);
  return h === 0 ? `in ${m}m` : `in ${h}h ${m}m`;
}

// ---------------------------------------------------------------------------
// Flight type inference
// ---------------------------------------------------------------------------

/** True if the flight summary indicates a positioning / ferry / repo leg. */
export function isPositioningFlight(f: Flight): boolean {
  return !!(f.summary?.toLowerCase().includes("positioning"));
}

/** Infer flight type from flight_type field or summary text. */
export function inferFlightType(flight: Flight): string | null {
  // Same-airport flights are maintenance reminders from JetInsight
  if (
    flight.departure_icao &&
    flight.arrival_icao &&
    flight.departure_icao === flight.arrival_icao
  ) {
    return "Maintenance";
  }
  if (flight.flight_type) return flight.flight_type;
  const text = flight.summary ?? "";
  const afterPair = text.match(/\([A-Z]{3,4}\s*[-\u2013]\s*[A-Z]{3,4}\)\s*[-\u2013]\s*(.+)$/);
  if (afterPair) {
    const raw = afterPair[1].replace(/\s+flights?\s*$/i, "").trim();
    if (raw) return raw;
  }
  const preBracket = text.match(/^([A-Za-z][A-Za-z /]+?)\s*[-\u2013]?\s*\[/);
  if (preBracket) {
    const raw = preBracket[1].replace(/[-\u2013]\s*$/, "").replace(/\s+flights?\s*$/i, "").trim();
    if (raw) return raw;
  }
  for (const kw of FLIGHT_TYPE_KEYWORDS) {
    if (new RegExp(`\\b${kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(text)) {
      return kw;
    }
  }
  return null;
}

/** Map flight types to user-facing filter categories. */
export function getFilterCategory(ft: string | null): string {
  if (!ft) return "other";
  const lower = ft.toLowerCase();
  if (lower === "revenue" || lower === "owner" || lower === "charter") return "charter";
  if (lower === "positioning" || lower === "ferry" || lower.includes("ferry") || lower === "transient") return "positioning";
  if (lower === "maintenance") return "maintenance";
  return "other";
}

// ---------------------------------------------------------------------------
// Zone item computation
// ---------------------------------------------------------------------------

/**
 * Compute schedule items for a single zone.
 * Returns flights arriving within this zone's coverage radius on the given date.
 */
export function computeZoneItems(
  zone: (typeof FIXED_VAN_ZONES)[number],
  allFlights: Flight[],
  date: string,
  baseLat: number,
  baseLon: number,
): VanFlightItem[] {
  const arrivalsToday = allFlights.filter((f) => {
    if (!f.arrival_icao || !f.scheduled_arrival) return false;
    if (!isOnEtDate(f.scheduled_arrival, date)) return false;
    const ft = inferFlightType(f);
    const cat = getFilterCategory(ft);
    if (cat === "other") return false;
    const iata = f.arrival_icao.replace(/^K/, "");
    const info = getAirportInfo(iata);
    if (!info || !isContiguous48(info.state)) return false;
    return haversineKm(zone.lat, zone.lon, info.lat, info.lon) <= SCHEDULE_ARRIVAL_RADIUS_KM;
  });

  const rawItems = arrivalsToday
    .map((arr) => {
      const iata = arr.arrival_icao!.replace(/^K/, "");
      const info = getAirportInfo(iata);
      const distKm = info ? Math.round(haversineKm(baseLat, baseLon, info.lat, info.lon)) : 0;

      const nextDep =
        allFlights
          .filter(
            (f) =>
              f.tail_number === arr.tail_number &&
              f.departure_icao === arr.arrival_icao &&
              f.scheduled_departure > (arr.scheduled_arrival ?? ""),
          )
          .sort((a, b) => a.scheduled_departure.localeCompare(b.scheduled_departure))[0] ?? null;

      return {
        arrFlight: arr,
        nextDep,
        isRepo: isPositioningFlight(arr),
        nextIsRepo: nextDep ? isPositioningFlight(nextDep) : false,
        airport: iata,
        airportInfo: info,
        distKm,
      };
    })
    .filter(({ arrFlight, nextDep }) => {
      if (!nextDep) return true;
      if (nextDep.scheduled_departure.startsWith(date)) {
        const arrMs = new Date(arrFlight.scheduled_arrival ?? "").getTime();
        const depMs = new Date(nextDep.scheduled_departure).getTime();
        const groundHours = (depMs - arrMs) / 3_600_000;
        if (groundHours < 2 && !isPositioningFlight(nextDep)) return false;
      }
      if (isPositioningFlight(nextDep)) return true;
      return !isOnEtDate(nextDep.scheduled_departure, date);
    });

  // Deduplicate by tail
  const byTail = new Map<string, VanFlightItem>();
  for (const item of rawItems) {
    const key = item.arrFlight.tail_number || `_no_tail_${item.arrFlight.id}`;
    const existing = byTail.get(key);
    if (!existing || item.distKm < existing.distKm) {
      byTail.set(key, item);
    }
  }

  return Array.from(byTail.values())
    .sort((a, b) =>
      (a.arrFlight.scheduled_arrival ?? "").localeCompare(b.arrFlight.scheduled_arrival ?? ""),
    )
    .slice(0, MAX_ARRIVALS_PER_VAN);
}

// ---------------------------------------------------------------------------
// Route optimization
// ---------------------------------------------------------------------------

/**
 * Greedy nearest-neighbor sort: reorders items so the van visits the closest
 * airport first, then the closest remaining, etc.
 */
export function greedySort(items: VanFlightItem[], startLat: number, startLon: number): VanFlightItem[] {
  if (items.length <= 1) return items;
  const remaining = [...items];
  const result: VanFlightItem[] = [];
  let curLat = startLat, curLon = startLon;
  while (remaining.length > 0) {
    let bestIdx = 0, bestDist = Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const info = remaining[i].airportInfo;
      if (!info) { bestIdx = i; break; }
      const d = haversineKm(curLat, curLon, info.lat, info.lon);
      if (d < bestDist) { bestDist = d; bestIdx = i; }
    }
    const chosen = remaining.splice(bestIdx, 1)[0];
    result.push(chosen);
    curLat = chosen.airportInfo?.lat ?? curLat;
    curLon = chosen.airportInfo?.lon ?? curLon;
  }
  return result;
}

/** Recalculate distKm for items relative to a van's base position. */
export function recalcDist(items: VanFlightItem[], baseLat: number, baseLon: number): VanFlightItem[] {
  return items.map((item) => ({
    ...item,
    distKm: item.airportInfo
      ? Math.round(haversineKm(baseLat, baseLon, item.airportInfo.lat, item.airportInfo.lon))
      : 0,
  }));
}

/** Compute sequential route distance (base -> stop1 -> stop2 -> ...). */
export function routeDistKm(items: VanFlightItem[]): number {
  return items.reduce((sum, item, idx) => {
    if (idx === 0) return item.distKm;
    const prev = items[idx - 1];
    if (!prev.airportInfo || !item.airportInfo) return sum + item.distKm;
    return sum + Math.round(haversineKm(prev.airportInfo.lat, prev.airportInfo.lon, item.airportInfo.lat, item.airportInfo.lon));
  }, 0);
}

/** Get the effective arrival time for a flight item, preferring FA ETA over scheduled. */
export function getEffectiveArrival(item: VanFlightItem, flightInfoMap: Map<string, FlightInfoEntry>): string {
  const tail = item.arrFlight.tail_number;
  if (!tail) return item.arrFlight.scheduled_arrival ?? "";
  const fi = flightInfoMap.get(tail);
  if (fi?.arrival_time) return fi.arrival_time;
  return item.arrFlight.scheduled_arrival ?? "";
}
