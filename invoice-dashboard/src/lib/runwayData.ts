/**
 * US runway length data from OurAirports (FAA source).
 * ~22K airports, ~26K runways. Surface codes: A=asphalt, C=concrete,
 * T=turf, G=gravel, D=dirt, W=water, O=other.
 */
import rawData from "@/data/usRunways.json";

export type SurfaceCode = "A" | "C" | "T" | "G" | "D" | "W" | "O";

export interface RunwayInfo {
  /** Runway designator, e.g. "06/24" */
  id: string;
  /** Length in feet */
  length_ft: number;
  /** Width in feet (may be 0 if unknown) */
  width_ft: number;
  /** Surface type */
  surface: SurfaceCode;
  /** Whether the runway is lighted */
  lighted: boolean;
}

export interface AirportRunways {
  code: string;
  runways: RunwayInfo[];
  /** Longest runway length in feet */
  longestRunway_ft: number;
  /** Longest paved (asphalt/concrete) runway in feet, 0 if none */
  longestPaved_ft: number;
}

type RawRunway = { r: string; l: number; w?: number; s: string; lit?: number };
const data = rawData as Record<string, RawRunway[]>;

function parseRunway(raw: RawRunway): RunwayInfo {
  return {
    id: raw.r,
    length_ft: raw.l,
    width_ft: raw.w ?? 0,
    surface: raw.s as SurfaceCode,
    lighted: raw.lit === 1,
  };
}

/** Get all runways for an airport. Accepts FAA code (TEB) or ICAO (KTEB). */
export function getRunways(code: string): AirportRunways | null {
  // Try as-is first, then strip leading K for ICAO -> FAA lookup
  const raw = data[code] ?? data[code.replace(/^K/, "")] ?? null;
  if (!raw) return null;

  const runways = raw.map(parseRunway);
  const longestRunway_ft = Math.max(...runways.map((r) => r.length_ft), 0);
  const paved = runways.filter((r) => r.surface === "A" || r.surface === "C");
  const longestPaved_ft = paved.length
    ? Math.max(...paved.map((r) => r.length_ft))
    : 0;

  return { code, runways, longestRunway_ft, longestPaved_ft };
}

/** Check if an airport has at least one paved runway >= minLength_ft. */
export function hasPavedRunway(code: string, minLength_ft: number): boolean {
  const info = getRunways(code);
  return info ? info.longestPaved_ft >= minLength_ft : false;
}

/**
 * Given a runway designator from a NOTAM (e.g. "RWY 06/24" or "RWY 06"),
 * find the matching runway and return its length. Returns null if not found.
 */
export function getRunwayLength(
  airportCode: string,
  runwayDesignator: string,
): number | null {
  const info = getRunways(airportCode);
  if (!info) return null;

  // Normalize: strip "RWY", spaces, leading zeros
  const norm = runwayDesignator
    .replace(/^RWY\s*/i, "")
    .trim()
    .toUpperCase();

  for (const rwy of info.runways) {
    const rwyNorm = rwy.id.toUpperCase();
    // Exact match: "06/24" == "06/24"
    if (rwyNorm === norm) return rwy.length_ft;
    // Single-end match: "06" matches "06/24"
    const ends = rwyNorm.split("/");
    if (ends.includes(norm)) return rwy.length_ft;
  }
  return null;
}

/** Get total count of airports in the dataset. */
export function airportCount(): number {
  return Object.keys(data).length;
}

// ---------------------------------------------------------------------------
// NOTAM runway closure filter
// ---------------------------------------------------------------------------

const RWY_DESIGNATOR_RE =
  /\b(?:RWY|RUNWAY)\s+(\d{1,2}[LRC]?(?:\s*\/\s*\d{1,2}[LRC]?)?)/i;

const CLOSURE_RE = /\b(CLSD|CLOSED)\b/i;

/** Extract the runway designator mentioned in a NOTAM body, e.g. "06/24". */
export function parseClosedRunway(body: string): string | null {
  if (!CLOSURE_RE.test(body)) return null;
  const m = body.match(RWY_DESIGNATOR_RE);
  if (!m) return null;
  return m[1].replace(/\s/g, "").toUpperCase();
}

/** Check if a runway designator matches a RunwayInfo entry. */
function runwayMatches(rwy: RunwayInfo, designator: string): boolean {
  const norm = rwy.id.toUpperCase();
  if (norm === designator) return true;
  // Single-end: "06" matches "06/24", "16R" matches "16R/34L"
  const ends = norm.split("/");
  const desigEnds = designator.split("/");
  return desigEnds.some((d) => ends.includes(d));
}

/** Time window for a NOTAM closure */
type TimeWindow = { start: number; end: number };

/** Parse effective start/end from NOTAM date fields into epoch ms. */
function parseTimeWindow(
  dates: { effective_start?: string | null; effective_end?: string | null; start_date_utc?: string | null; end_date_utc?: string | null } | null,
): TimeWindow | null {
  if (!dates) return null;
  const startStr = dates.effective_start ?? dates.start_date_utc;
  const endStr = dates.effective_end ?? dates.end_date_utc;
  if (!startStr || !endStr) return null;
  const start = new Date(startStr).getTime();
  const end = new Date(endStr).getTime();
  if (isNaN(start) || isNaN(end)) return null;
  return { start, end };
}

/** Check if two time windows overlap */
function windowsOverlap(a: TimeWindow, b: TimeWindow): boolean {
  return a.start < b.end && b.start < a.end;
}

type NotamInput = {
  id: string;
  body: string | null;
  effective_start?: string | null;
  effective_end?: string | null;
  start_date_utc?: string | null;
  end_date_utc?: string | null;
};

type ParsedClosure = {
  id: string;
  designator: string;
  window: TimeWindow | null;
};

/**
 * Given NOTAM_RUNWAY alerts for an airport, return the IDs of alerts that
 * can be suppressed because a 5000+ ft paved runway remains open during the
 * closure window.
 *
 * Time-aware: if two closures at the same airport overlap in time and cover
 * ALL 5000+ ft paved runways, neither is suppressed.
 *
 * Conservative: if we can't parse the runway, dates, or airport → show it.
 */
export function getSuppressedRunwayNotamIds(
  airportCode: string,
  notams: NotamInput[],
  minLength_ft = 5000,
): Set<string> {
  const suppress = new Set<string>();
  const info = getRunways(airportCode);
  if (!info) return suppress;

  const pavedLong = info.runways.filter(
    (r) => (r.surface === "A" || r.surface === "C") && r.length_ft >= minLength_ft,
  );
  if (pavedLong.length === 0) return suppress;

  // Parse all closures
  const closures: ParsedClosure[] = [];
  for (const n of notams) {
    if (!n.body) continue;
    const designator = parseClosedRunway(n.body);
    if (!designator) continue;
    closures.push({
      id: n.id,
      designator,
      window: parseTimeWindow(n),
    });
  }

  for (const closure of closures) {
    // Find all other paved runways this NOTAM does NOT close
    const otherRunways = pavedLong.filter((r) => !runwayMatches(r, closure.designator));

    if (otherRunways.length === 0) {
      // This is the only 5000+ ft runway — always show
      continue;
    }

    // Check if every other runway has an overlapping closure during this window
    const allOthersCovered = otherRunways.every((rwy) => {
      // Find closures that close THIS runway and overlap in time
      return closures.some((other) => {
        if (other.id === closure.id) return false;
        if (!runwayMatches(rwy, other.designator)) return false;
        // If either NOTAM has no time window, be conservative (assume overlap)
        if (!closure.window || !other.window) return true;
        return windowsOverlap(closure.window, other.window);
      });
    });

    // Suppress only if at least one other runway is NOT covered by overlapping closures
    if (!allOthersCovered) {
      suppress.add(closure.id);
    }
  }

  return suppress;
}

/**
 * Collect suppressed NOTAM_RUNWAY IDs across all airports in a flat alert list.
 * Accepts OpsAlert-shaped objects (with notam_dates for time-aware filtering).
 */
export function getRunwaySuppressedIds<
  T extends {
    id: string;
    alert_type: string;
    body: string | null;
    airport_icao: string | null;
    notam_dates?: { effective_start?: string | null; effective_end?: string | null; start_date_utc?: string | null; end_date_utc?: string | null } | null;
  },
>(alerts: T[], minLength_ft = 5000): string[] {
  // Group NOTAM_RUNWAY alerts by airport
  const byAirport = new Map<string, NotamInput[]>();
  for (const a of alerts) {
    if (a.alert_type !== "NOTAM_RUNWAY" || !a.airport_icao) continue;
    const key = a.airport_icao.toUpperCase();
    if (!byAirport.has(key)) byAirport.set(key, []);
    byAirport.get(key)!.push({
      id: a.id,
      body: a.body,
      effective_start: a.notam_dates?.effective_start,
      effective_end: a.notam_dates?.effective_end,
      start_date_utc: a.notam_dates?.start_date_utc,
      end_date_utc: a.notam_dates?.end_date_utc,
    });
  }

  const suppressed = new Set<string>();
  for (const [icao, notams] of byAirport) {
    const ids = getSuppressedRunwayNotamIds(icao, notams, minLength_ft);
    for (const id of ids) suppressed.add(id);
  }

  return [...suppressed];
}

/**
 * Filter a flat list of alerts, removing suppressed NOTAM_RUNWAY closures.
 * Convenience wrapper around getRunwaySuppressedIds.
 */
export function filterRunwayClosureNotams<
  T extends {
    id: string;
    alert_type: string;
    body: string | null;
    airport_icao: string | null;
    notam_dates?: { effective_start?: string | null; effective_end?: string | null; start_date_utc?: string | null; end_date_utc?: string | null } | null;
  },
>(alerts: T[], minLength_ft = 5000): T[] {
  const suppressed = new Set(getRunwaySuppressedIds(alerts, minLength_ft));
  return alerts.filter((a) => !suppressed.has(a.id));
}

// ---------------------------------------------------------------------------
// ALL RUNWAYS CLOSED detection (flight-level)
// ---------------------------------------------------------------------------

export type AllRwysClosedAlert = {
  flightId: string;
  airportIcao: string;
  phase: "departure" | "arrival";
  closureWindow: string; // human-readable, e.g. "10:30Z–13:30Z"
};

/**
 * Check if ALL 5000+ ft paved runways at an airport are closed during a
 * time window (flight time ± buffer). Returns the closure description if so.
 */
function allRunwaysClosed(
  airportCode: string,
  flightTimeMs: number,
  closures: ParsedClosure[],
  bufferMs: number,
  minLength_ft: number,
): string | null {
  const info = getRunways(airportCode);
  if (!info) return null;

  const pavedLong = info.runways.filter(
    (r) => (r.surface === "A" || r.surface === "C") && r.length_ft >= minLength_ft,
  );
  if (pavedLong.length === 0) return null; // no usable runways in dataset

  const flightWindow: TimeWindow = {
    start: flightTimeMs - bufferMs,
    end: flightTimeMs + bufferMs,
  };

  // For each paved runway, check if there's a closure that covers the flight window
  const uncoveredRunway = pavedLong.find((rwy) => {
    // Is there a closure for this runway that overlaps the flight window?
    const covered = closures.some((c) => {
      if (!runwayMatches(rwy, c.designator)) return false;
      if (!c.window) return false;
      return windowsOverlap(c.window, flightWindow);
    });
    return !covered;
  });

  // If every runway is covered by a closure, all are closed
  if (uncoveredRunway) return null;

  // Build human-readable closure window (earliest start to latest end among overlapping closures)
  const overlapping = closures.filter((c) => c.window && windowsOverlap(c.window, flightWindow));
  if (overlapping.length === 0) return null;
  const earliest = Math.min(...overlapping.map((c) => c.window!.start));
  const latest = Math.max(...overlapping.map((c) => c.window!.end));
  const fmt = (ms: number) => {
    const d = new Date(ms);
    return `${String(d.getUTCMonth() + 1).padStart(2, "0")}/${String(d.getUTCDate()).padStart(2, "0")} ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}Z`;
  };
  return `${fmt(earliest)}–${fmt(latest)}`;
}

/**
 * For each flight, check if ALL 5000+ ft paved runways at the departure or
 * arrival airport are closed within ±bufferHours of the scheduled time.
 * Returns alerts to display prominently on the flight card.
 */
export function detectAllRunwaysClosed(
  flights: Array<{
    id: string;
    departure_icao: string | null;
    arrival_icao: string | null;
    scheduled_departure: string;
    scheduled_arrival: string | null;
    alerts: Array<{
      alert_type: string;
      body: string | null;
      airport_icao: string | null;
      notam_dates: { effective_start?: string | null; effective_end?: string | null; start_date_utc?: string | null; end_date_utc?: string | null } | null;
    }>;
  }>,
  bufferHours = 2,
  minLength_ft = 5000,
): AllRwysClosedAlert[] {
  const bufferMs = bufferHours * 3600000;
  const results: AllRwysClosedAlert[] = [];

  for (const f of flights) {
    // Collect all runway closure NOTAMs across flight alerts, grouped by airport
    const closuresByAirport = new Map<string, ParsedClosure[]>();
    for (const a of f.alerts ?? []) {
      if (a.alert_type !== "NOTAM_RUNWAY" || !a.body || !a.airport_icao) continue;
      const desig = parseClosedRunway(a.body);
      if (!desig) continue;
      const key = a.airport_icao.toUpperCase();
      if (!closuresByAirport.has(key)) closuresByAirport.set(key, []);
      closuresByAirport.get(key)!.push({
        id: "", // not needed here
        designator: desig,
        window: parseTimeWindow(a.notam_dates),
      });
    }

    // Check departure airport
    if (f.departure_icao) {
      const icao = f.departure_icao.toUpperCase();
      const closures = closuresByAirport.get(icao) ?? [];
      if (closures.length > 0) {
        const depMs = new Date(f.scheduled_departure).getTime();
        const window = allRunwaysClosed(icao, depMs, closures, bufferMs, minLength_ft);
        if (window) {
          results.push({ flightId: f.id, airportIcao: icao, phase: "departure", closureWindow: window });
        }
      }
    }

    // Check arrival airport
    if (f.arrival_icao && f.scheduled_arrival) {
      const icao = f.arrival_icao.toUpperCase();
      const closures = closuresByAirport.get(icao) ?? [];
      if (closures.length > 0) {
        const arrMs = new Date(f.scheduled_arrival).getTime();
        const window = allRunwaysClosed(icao, arrMs, closures, bufferMs, minLength_ft);
        if (window) {
          results.push({ flightId: f.id, airportIcao: icao, phase: "arrival", closureWindow: window });
        }
      }
    }
  }

  return results;
}
