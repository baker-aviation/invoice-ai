/**
 * FBO fee lookup — combines static fbo-fees.json with live fbo_handling_fees DB data.
 * Maps (airport, vendor/chain, aircraft type) → handling fee waiver details.
 */

import fboFeesRaw from "@/data/fbo-fees.json";

export interface FboFeeEntry {
  chain: string;
  airport_code: string;
  fbo_name: string;
  aircraft_type: string;
  facility_fee: number | null;
  gallons_to_waive: number | null;
  security_fee: number | null;
  landing_fee?: number | null;
  overnight_fee?: number | null;
  parking_info: string;
}

export interface FboWaiver {
  minGallons: number;
  feeWaived: number;
  fboName: string;
  landingFee: number;
  securityFee: number;
  overnightFee: number;
}

const NO_WAIVER: FboWaiver = {
  minGallons: 0, feeWaived: 0, fboName: "",
  landingFee: 0, securityFee: 0, overnightFee: 0,
};

// Aircraft type mapping: model codes → fbo-fees.json names
const AIRCRAFT_TYPE_MAP: Record<string, string> = {
  "CE-750": "Citation X",
  "C750": "Citation X",
  "Citation X": "Citation X",
  "CL-30": "Challenger 300",
  "CL300": "Challenger 300",
  "Challenger 300": "Challenger 300",
};

// Strip K-prefix from ICAO codes for matching
function normalizeAirport(code: string): string {
  const c = code.toUpperCase().trim();
  if (c.length === 4 && c.startsWith("K")) return c.slice(1);
  return c;
}

// Build lookup index: "airport|aircraft_type" → FboFeeEntry[]
const fboIndex = new Map<string, FboFeeEntry[]>();

for (const raw of fboFeesRaw as FboFeeEntry[]) {
  const key = `${raw.airport_code.toUpperCase()}|${raw.aircraft_type}`;
  if (!fboIndex.has(key)) fboIndex.set(key, []);
  fboIndex.get(key)!.push(raw);
}

// DB cache — loaded once on first call, then reused
let dbIndex: Map<string, FboFeeEntry[]> | null = null;
let dbLoadPromise: Promise<void> | null = null;

async function loadDbFees(): Promise<void> {
  if (dbIndex) return;
  if (dbLoadPromise) { await dbLoadPromise; return; }

  dbLoadPromise = (async () => {
    try {
      // Dynamic import to avoid pulling supabase into client bundles
      const { createServiceClient } = await import("@/lib/supabase/service");
      const supa = createServiceClient();

      const { data } = await supa
        .from("fbo_handling_fees")
        .select("airport_code, fbo_name, chain, aircraft_type, facility_fee, gallons_to_waive, security_fee, landing_fee, overnight_fee, parking_info")
        .eq("source", "jetinsight-scrape");

      dbIndex = new Map();
      for (const row of data ?? []) {
        const key = `${row.airport_code.toUpperCase()}|${row.aircraft_type}`;
        if (!dbIndex.has(key)) dbIndex.set(key, []);
        dbIndex.get(key)!.push({
          chain: row.chain ?? "",
          airport_code: row.airport_code,
          fbo_name: row.fbo_name,
          aircraft_type: row.aircraft_type,
          facility_fee: row.facility_fee,
          gallons_to_waive: row.gallons_to_waive,
          security_fee: row.security_fee,
          landing_fee: row.landing_fee ?? null,
          overnight_fee: row.overnight_fee ?? null,
          parking_info: row.parking_info ?? "",
        });
      }
    } catch {
      // If DB lookup fails (e.g. client-side), fall back to JSON only
      dbIndex = new Map();
    }
  })();
  await dbLoadPromise;
}

function lookupEntries(airport: string, aircraftType: string): FboFeeEntry[] {
  const ap = normalizeAirport(airport);
  const acType = AIRCRAFT_TYPE_MAP[aircraftType] ?? aircraftType;
  const key = `${ap}|${acType}`;

  // Merge: DB entries take priority, then static JSON
  const dbEntries = dbIndex?.get(key) ?? [];
  const jsonEntries = fboIndex.get(key) ?? [];

  if (dbEntries.length > 0) return dbEntries;
  return jsonEntries;
}

function matchVendor(entries: FboFeeEntry[], vendor: string): FboFeeEntry | undefined {
  const vLower = vendor.toLowerCase();
  return entries.find(e => {
    const chainLow = e.chain.toLowerCase();
    const fboLow = e.fbo_name.toLowerCase();
    return chainLow.includes(vLower) || vLower.includes(chainLow)
      || fboLow.includes(vLower) || vLower.includes(fboLow)
      || vLower.split(/\s+/)[0] === chainLow.split(/\s+/)[0]
      || vLower.split(/\s+/)[0] === fboLow.split(/\s+/)[0];
  });
}

function toWaiver(e: FboFeeEntry): FboWaiver {
  return {
    minGallons: e.gallons_to_waive!,
    feeWaived: e.facility_fee!,
    fboName: e.fbo_name,
    landingFee: e.landing_fee ?? 0,
    securityFee: e.security_fee ?? 0,
    overnightFee: e.overnight_fee ?? 0,
  };
}

/**
 * Look up FBO fee waiver info. Async version that checks DB first.
 */
export async function getFboWaiverAsync(
  airport: string,
  vendor: string | null,
  aircraftType: string,
): Promise<FboWaiver> {
  await loadDbFees();
  return getFboWaiver(airport, vendor, aircraftType);
}

/**
 * Synchronous lookup — uses DB cache if loaded, otherwise JSON only.
 */
export function getFboWaiver(
  airport: string,
  vendor: string | null,
  aircraftType: string,
): FboWaiver {
  const entries = lookupEntries(airport, aircraftType);
  if (!entries.length) return NO_WAIVER;

  // Try to match by vendor name
  if (vendor) {
    const match = matchVendor(entries, vendor);
    if (match && match.facility_fee != null && match.gallons_to_waive != null) {
      return toWaiver(match);
    }
  }

  // No vendor match — return the entry with the highest facility fee (worst-case)
  const withFees = entries.filter(e => e.facility_fee != null && e.facility_fee > 0 && e.gallons_to_waive != null);
  if (!withFees.length) return NO_WAIVER;

  const best = withFees.reduce((a, b) => (a.facility_fee! > b.facility_fee! ? a : b));
  return toWaiver(best);
}

/**
 * Get all FBO options at an airport for a given aircraft type.
 */
export async function getFboOptionsAtAirportAsync(
  airport: string,
  aircraftType: string,
): Promise<FboWaiver[]> {
  await loadDbFees();
  return getFboOptionsAtAirport(airport, aircraftType);
}

export function getFboOptionsAtAirport(
  airport: string,
  aircraftType: string,
): FboWaiver[] {
  const entries = lookupEntries(airport, aircraftType);
  return entries
    .filter(e => e.facility_fee != null && e.gallons_to_waive != null)
    .map(toWaiver);
}

/**
 * Preload DB fees cache. Call once at startup or before batch operations.
 */
export async function preloadDbFees(): Promise<void> {
  await loadDbFees();
}
