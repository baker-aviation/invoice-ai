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

// ---------------------------------------------------------------------------
// Recurring schedule parsing (e.g. "MON-FRI 0400-0930", "DLY 0600-1400")
// ---------------------------------------------------------------------------

const DAY_NAMES = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"] as const;
const DAY_INDEX: Record<string, number> = { SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6 };

type RecurringSchedule = {
  /** Which UTC days of week the closure applies (0=Sun..6=Sat) */
  days: Set<number>;
  /** Daily start time in minutes from midnight UTC */
  startMinUTC: number;
  /** Daily end time in minutes from midnight UTC */
  endMinUTC: number;
  /** Overall NOTAM validity period */
  validFrom: number;
  validTo: number;
};

/** Parse day-of-week pattern from NOTAM body. */
function parseDays(text: string): Set<number> | null {
  const upper = text.toUpperCase();

  // "DLY" = daily
  if (/\bDLY\b/.test(upper)) return new Set([0, 1, 2, 3, 4, 5, 6]);

  // Range: "MON-FRI", "MON-SAT", "TUE-THU"
  const rangeMatch = upper.match(/\b(SUN|MON|TUE|WED|THU|FRI|SAT)\s*-\s*(SUN|MON|TUE|WED|THU|FRI|SAT)\b/);
  if (rangeMatch) {
    const start = DAY_INDEX[rangeMatch[1]];
    const end = DAY_INDEX[rangeMatch[2]];
    const days = new Set<number>();
    if (start <= end) {
      for (let i = start; i <= end; i++) days.add(i);
    } else {
      // Wrap around: e.g. FRI-MON = FRI, SAT, SUN, MON
      for (let i = start; i < 7; i++) days.add(i);
      for (let i = 0; i <= end; i++) days.add(i);
    }
    return days;
  }

  // List: "SAT SUN", "MON WED FRI"
  const listMatch = upper.match(/\b((?:(?:SUN|MON|TUE|WED|THU|FRI|SAT)\s*){2,})\b/);
  if (listMatch) {
    const days = new Set<number>();
    for (const d of DAY_NAMES) {
      if (listMatch[1].includes(d)) days.add(DAY_INDEX[d]);
    }
    if (days.size > 0) return days;
  }

  return null;
}

/** Parse recurring schedule from NOTAM body + effective dates. */
function parseRecurringSchedule(
  body: string | null,
  dates: { effective_start?: string | null; effective_end?: string | null; start_date_utc?: string | null; end_date_utc?: string | null } | null,
): RecurringSchedule | null {
  if (!body || !dates) return null;

  const days = parseDays(body);
  if (!days) return null;

  // Parse daily time window: "0400-0930", "0600-1400"
  // Must appear near the day pattern (within same NOTAM line)
  const timeMatch = body.match(/\b(\d{4})\s*-\s*(\d{4})\b/);
  if (!timeMatch) return null;

  const startHHMM = timeMatch[1];
  const endHHMM = timeMatch[2];
  const sh = parseInt(startHHMM.slice(0, 2)), sm = parseInt(startHHMM.slice(2));
  const eh = parseInt(endHHMM.slice(0, 2)), em = parseInt(endHHMM.slice(2));
  // Validate hours/minutes are within range
  if (sh > 23 || sm > 59 || eh > 23 || em > 59) return null;
  const startMinUTC = sh * 60 + sm;
  const endMinUTC = eh * 60 + em;

  // Need overall validity dates
  const startStr = dates.effective_start ?? dates.start_date_utc;
  const endStr = dates.effective_end ?? dates.end_date_utc;
  if (!startStr || !endStr) return null;
  const validFrom = new Date(startStr).getTime();
  const validTo = new Date(endStr).getTime();
  if (isNaN(validFrom) || isNaN(validTo)) return null;

  return { days, startMinUTC, endMinUTC, validFrom, validTo };
}

/** Check if a specific timestamp falls within a recurring schedule. */
function isActiveAt(schedule: RecurringSchedule, timeMs: number): boolean {
  if (timeMs < schedule.validFrom || timeMs > schedule.validTo) return false;

  const d = new Date(timeMs);
  const dayOfWeek = d.getUTCDay(); // 0=Sun
  if (!schedule.days.has(dayOfWeek)) return false;

  const minuteOfDay = d.getUTCHours() * 60 + d.getUTCMinutes();

  if (schedule.startMinUTC <= schedule.endMinUTC) {
    // Normal: e.g. 0400-0930
    return minuteOfDay >= schedule.startMinUTC && minuteOfDay < schedule.endMinUTC;
  } else {
    // Overnight: e.g. 2200-0600 → active if >= 2200 OR < 0600
    return minuteOfDay >= schedule.startMinUTC || minuteOfDay < schedule.endMinUTC;
  }
}

/** Check if a recurring schedule overlaps with a time window. */
function recurringOverlapsWindow(schedule: RecurringSchedule, window: TimeWindow): boolean {
  // Check each day within the window
  const dayMs = 86400000;
  const startDay = Math.floor(window.start / dayMs) * dayMs;
  const endDay = Math.ceil(window.end / dayMs) * dayMs;

  for (let day = startDay; day <= endDay; day += dayMs) {
    const d = new Date(day);
    const dayOfWeek = d.getUTCDay();
    if (!schedule.days.has(dayOfWeek)) continue;
    if (day < schedule.validFrom - dayMs || day > schedule.validTo) continue;

    // Build the actual closure window for this specific day
    let closureStart = day + schedule.startMinUTC * 60000;
    let closureEnd: number;
    if (schedule.startMinUTC <= schedule.endMinUTC) {
      closureEnd = day + schedule.endMinUTC * 60000;
    } else {
      closureEnd = day + dayMs + schedule.endMinUTC * 60000;
    }

    // Clamp to overall validity
    closureStart = Math.max(closureStart, schedule.validFrom);
    closureEnd = Math.min(closureEnd, schedule.validTo);

    if (closureStart < window.end && window.start < closureEnd) return true;
  }
  return false;
}

/** Parse effective start/end from NOTAM date fields into epoch ms. */
function parseTimeWindow(
  dates: { effective_start?: string | null; effective_end?: string | null; start_date_utc?: string | null; end_date_utc?: string | null } | null,
  body?: string | null,
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

/** Check if two time windows overlap. */
function windowsOverlap(a: TimeWindow, b: TimeWindow): boolean {
  return a.start < b.end && b.start < a.end;
}

/** Check if a parsed closure is active during a given time window, respecting recurring schedules. */
function closureActiveInWindow(closure: ParsedClosure, window: TimeWindow): boolean {
  if (closure.recurring) {
    return recurringOverlapsWindow(closure.recurring, window);
  }
  if (!closure.window) return false;
  return windowsOverlap(closure.window, window);
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
  recurring: RecurringSchedule | null;
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
      recurring: parseRecurringSchedule(n.body, n),
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
      return closures.some((other) => {
        if (other.id === closure.id) return false;
        if (!runwayMatches(rwy, other.designator)) return false;
        // If either has no window and no recurring schedule, be conservative
        if (!closure.window || (!other.window && !other.recurring)) return true;
        if (other.recurring && closure.window) {
          return recurringOverlapsWindow(other.recurring, closure.window);
        }
        if (other.window && closure.window) {
          return windowsOverlap(closure.window, other.window);
        }
        return true;
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
    const covered = closures.some((c) => {
      if (!runwayMatches(rwy, c.designator)) return false;
      return closureActiveInWindow(c, flightWindow);
    });
    return !covered;
  });

  // If every runway is covered by a closure, all are closed
  if (uncoveredRunway) return null;

  // Build human-readable description
  const fmt = (ms: number) => {
    const d = new Date(ms);
    return `${String(d.getUTCMonth() + 1).padStart(2, "0")}/${String(d.getUTCDate()).padStart(2, "0")} ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}Z`;
  };

  // Check for recurring closures first
  const recurringActive = closures.filter((c) => c.recurring && recurringOverlapsWindow(c.recurring, flightWindow));
  if (recurringActive.length > 0) {
    const sched = recurringActive[0].recurring!;
    const dayNames = [...sched.days].sort().map((d) => DAY_NAMES[d]).join("/");
    const startH = String(Math.floor(sched.startMinUTC / 60)).padStart(2, "0");
    const startM = String(sched.startMinUTC % 60).padStart(2, "0");
    const endH = String(Math.floor(sched.endMinUTC / 60)).padStart(2, "0");
    const endM = String(sched.endMinUTC % 60).padStart(2, "0");
    return `${dayNames} ${startH}${startM}–${endH}${endM}Z`;
  }

  const overlapping = closures.filter((c) => c.window && windowsOverlap(c.window, flightWindow));
  if (overlapping.length === 0) return null;
  const earliest = Math.min(...overlapping.map((c) => c.window!.start));
  const latest = Math.max(...overlapping.map((c) => c.window!.end));
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
        id: "",
        designator: desig,
        window: parseTimeWindow(a.notam_dates),
        recurring: parseRecurringSchedule(a.body, a.notam_dates),
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
