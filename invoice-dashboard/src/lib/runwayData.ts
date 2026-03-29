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

/**
 * Given NOTAM_RUNWAY alerts for an airport, return the IDs of alerts that
 * can be suppressed because the airport has at least one OTHER paved runway
 * >= minLength_ft that this specific NOTAM does NOT close.
 *
 * Each NOTAM is evaluated independently — we don't aggregate closures across
 * the batch because they typically have different effective times.
 *
 * Conservative: if we can't parse which runway a NOTAM closes, or if the
 * airport isn't in our dataset, we do NOT suppress it.
 */
export function getSuppressedRunwayNotamIds(
  airportCode: string,
  notams: Array<{ id: string; body: string | null }>,
  minLength_ft = 5000,
): Set<string> {
  const suppress = new Set<string>();
  const info = getRunways(airportCode);
  if (!info) return suppress; // unknown airport → show everything

  const pavedLong = info.runways.filter(
    (r) => (r.surface === "A" || r.surface === "C") && r.length_ft >= minLength_ft,
  );
  if (pavedLong.length === 0) return suppress; // no usable runways at all

  for (const n of notams) {
    if (!n.body) continue;
    const designator = parseClosedRunway(n.body);
    if (!designator) continue;

    // Check if there's another 5000+ ft paved runway NOT closed by this NOTAM
    const otherOpen = pavedLong.some((r) => !runwayMatches(r, designator));
    if (otherOpen) suppress.add(n.id);
  }

  return suppress;
}

/**
 * Collect suppressed NOTAM_RUNWAY IDs across all airports in a flat alert list.
 * Returns an array of alert IDs that can be hidden (airport still has 5000+ ft paved open).
 */
export function getRunwaySuppressedIds<
  T extends { id: string; alert_type: string; body: string | null; airport_icao: string | null },
>(alerts: T[], minLength_ft = 5000): string[] {
  // Group NOTAM_RUNWAY alerts by airport
  const byAirport = new Map<string, T[]>();
  for (const a of alerts) {
    if (a.alert_type !== "NOTAM_RUNWAY" || !a.airport_icao) continue;
    const key = a.airport_icao.toUpperCase();
    if (!byAirport.has(key)) byAirport.set(key, []);
    byAirport.get(key)!.push(a);
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
  T extends { id: string; alert_type: string; body: string | null; airport_icao: string | null },
>(alerts: T[], minLength_ft = 5000): T[] {
  const suppressed = new Set(getRunwaySuppressedIds(alerts, minLength_ft));
  return alerts.filter((a) => !suppressed.has(a.id));
}
