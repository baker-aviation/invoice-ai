/**
 * Parser for JetInsight post-flight CSV exports.
 * Extracts: tail, aircraft type, airports, fuel start/end, flight hours, etc.
 */

import { parseCSVLine, normalizeAirportCode } from "@/lib/fuelParsers";

export interface PostFlightRow {
  tail_number: string;
  aircraft_type: "CE-750" | "CL-30";
  origin: string;
  destination: string;
  flight_date: string;          // YYYY-MM-DD
  segment_number: number;
  flight_hrs: number | null;
  block_hrs: number | null;
  fuel_start_lbs: number | null;
  fuel_end_lbs: number | null;
  fuel_burn_lbs: number | null;
  fuel_burn_lbs_hour: number | null;
  takeoff_wt_lbs: number | null;
  pax: number | null;
  nautical_miles: number | null;
  gals_pre: number | null;
  gals_post: number | null;
  pic: string | null;
  sic: string | null;
  trip_id: string | null;
  upload_batch: string;
}

export interface PostFlightParseResult {
  rows: PostFlightRow[];
  error?: string;
  skipped: number;
}

const AIRCRAFT_TYPE_MAP: Record<string, "CE-750" | "CL-30"> = {
  "cessna citation x":   "CE-750",
  "citation x":          "CE-750",
  "citation x+":         "CE-750",
  "ce-750":              "CE-750",
  "c750":                "CE-750",
  "bombardier challenger 300": "CL-30",
  "challenger 300":      "CL-30",
  "cl-30":               "CL-30",
  "cl30":                "CL-30",
  "challenger 350":      "CL-30",
  "cl-35":               "CL-30",
};

function mapAircraftType(raw: string): "CE-750" | "CL-30" | null {
  const key = raw.toLowerCase().trim();
  return AIRCRAFT_TYPE_MAP[key] ?? null;
}

function num(raw: string | undefined): number | null {
  if (!raw) return null;
  const cleaned = raw.replace(/[$,]/g, "").trim();
  if (!cleaned) return null;
  const n = parseFloat(cleaned);
  return isNaN(n) ? null : n;
}

function intVal(raw: string | undefined): number | null {
  const n = num(raw);
  return n === null ? null : Math.round(n);
}

/**
 * Try to extract a date from the row.
 * Checks "Out time", "Off time", "Start Z", "End" columns.
 * Falls back to provided fallbackDate (typically today).
 */
function extractDate(fields: string[], headers: string[], fallbackDate: string): string {
  // Try date-bearing columns in priority order
  for (const col of ["OUT TIME", "OFF TIME", "START Z", "END"]) {
    const idx = headers.indexOf(col);
    if (idx < 0) continue;
    const raw = fields[idx]?.trim();
    if (!raw) continue;
    // Try parsing as date
    const d = new Date(raw);
    if (!isNaN(d.getTime())) return d.toISOString().split("T")[0];
    // Try MM/DD/YYYY or YYYY-MM-DD embedded
    const iso = raw.match(/(\d{4})-(\d{2})-(\d{2})/);
    if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
    const slash = raw.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (slash) return `${slash[3]}-${slash[1].padStart(2, "0")}-${slash[2].padStart(2, "0")}`;
  }
  return fallbackDate;
}

export function parsePostFlightCSV(
  csvText: string,
  batchId: string,
  fallbackDate?: string,
): PostFlightParseResult {
  const lines = csvText.split("\n").filter((l) => l.trim());
  if (lines.length < 2) return { rows: [], skipped: 0, error: "CSV has no data rows" };

  const headers = parseCSVLine(lines[0]).map((h) => h.toUpperCase().trim());

  // Detect required columns
  const col = (name: string) => headers.indexOf(name);
  const aircraftIdx = col("AIRCRAFT");
  const typeIdx = col("AIRCRAFT TYPE");
  const origIdx = col("ORIG");
  const destIdx = col("DEST");
  const fuelStartIdx = col("FUEL START LBS");
  const fuelEndIdx = col("FUEL END LBS");
  const flightHrsIdx = col("FLIGHT HRS");

  if (aircraftIdx < 0) return { rows: [], skipped: 0, error: "Missing 'Aircraft' column" };
  if (origIdx < 0) return { rows: [], skipped: 0, error: "Missing 'Orig' column" };
  if (destIdx < 0) return { rows: [], skipped: 0, error: "Missing 'Dest' column" };
  if (fuelStartIdx < 0 && fuelEndIdx < 0) {
    return { rows: [], skipped: 0, error: "Missing 'Fuel start lbs' and 'Fuel end lbs' columns" };
  }

  // Optional columns
  const blockHrsIdx = col("BLOCK HRS");
  const burnIdx = col("FUEL BURN LBS");
  const burnHrIdx = col("FUEL BURN LBS/HOUR");
  const towIdx = col("TAKEOFF WT LBS");
  const paxIdx = col("PAX");
  const nmIdx = col("NAUTICAL MILES");
  const galsPreIdx = col("GALS PRE");
  const galsPostIdx = col("GALS POST");
  const picIdx = col("PIC");
  const sicIdx = col("SIC");
  const tripIdx = col("TRIP");
  const segIdx = col("SEGMENT #");

  const today = fallbackDate ?? new Date().toISOString().split("T")[0];

  const rows: PostFlightRow[] = [];
  let skipped = 0;

  // Track segment numbers per tail+date combo
  const segCounters = new Map<string, number>();

  for (let i = 1; i < lines.length; i++) {
    const fields = parseCSVLine(lines[i]);

    const tail = fields[aircraftIdx]?.trim().toUpperCase();
    if (!tail) { skipped++; continue; }

    const rawType = fields[typeIdx]?.trim() ?? "";
    const acType = mapAircraftType(rawType);
    if (!acType) { skipped++; continue; }

    const orig = fields[origIdx]?.trim().toUpperCase();
    const dest = fields[destIdx]?.trim().toUpperCase();
    if (!orig || !dest) { skipped++; continue; }

    const flightDate = extractDate(fields, headers, today);

    // Segment number: use CSV value if available, otherwise auto-increment
    let segNum: number;
    if (segIdx >= 0 && fields[segIdx]?.trim()) {
      segNum = parseInt(fields[segIdx].trim(), 10) || 1;
    } else {
      const key = `${tail}|${flightDate}`;
      const cur = (segCounters.get(key) ?? 0) + 1;
      segCounters.set(key, cur);
      segNum = cur;
    }

    rows.push({
      tail_number: tail,
      aircraft_type: acType,
      origin: normalizeAirportCode(orig),
      destination: normalizeAirportCode(dest),
      flight_date: flightDate,
      segment_number: segNum,
      flight_hrs: num(fields[flightHrsIdx]),
      block_hrs: blockHrsIdx >= 0 ? num(fields[blockHrsIdx]) : null,
      fuel_start_lbs: num(fields[fuelStartIdx]),
      fuel_end_lbs: num(fields[fuelEndIdx]),
      fuel_burn_lbs: burnIdx >= 0 ? num(fields[burnIdx]) : null,
      fuel_burn_lbs_hour: burnHrIdx >= 0 ? num(fields[burnHrIdx]) : null,
      takeoff_wt_lbs: towIdx >= 0 ? num(fields[towIdx]) : null,
      pax: paxIdx >= 0 ? intVal(fields[paxIdx]) : null,
      nautical_miles: nmIdx >= 0 ? num(fields[nmIdx]) : null,
      gals_pre: galsPreIdx >= 0 ? num(fields[galsPreIdx]) : null,
      gals_post: galsPostIdx >= 0 ? num(fields[galsPostIdx]) : null,
      pic: picIdx >= 0 ? fields[picIdx]?.trim() || null : null,
      sic: sicIdx >= 0 ? fields[sicIdx]?.trim() || null : null,
      trip_id: tripIdx >= 0 ? fields[tripIdx]?.trim() || null : null,
      upload_batch: batchId,
    });
  }

  return { rows, skipped };
}
