/**
 * FBO fee lookup from fbo-fees.json data.
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

/**
 * Look up FBO fee waiver info for a specific airport, vendor, and aircraft.
 * Tries to match vendor name against chain or fbo_name (fuzzy).
 * If no vendor match, returns the best (cheapest waiver) option at that airport.
 */
export function getFboWaiver(
  airport: string,
  vendor: string | null,
  aircraftType: string,
): FboWaiver {
  const ap = normalizeAirport(airport);
  const acType = AIRCRAFT_TYPE_MAP[aircraftType] ?? aircraftType;
  const key = `${ap}|${acType}`;
  const entries = fboIndex.get(key);
  if (!entries?.length) return NO_WAIVER;

  // Try to match by vendor name
  if (vendor) {
    const vLower = vendor.toLowerCase();
    const match = entries.find(e => {
      const chainLow = e.chain.toLowerCase();
      const fboLow = e.fbo_name.toLowerCase();
      // Check if vendor contains chain or vice versa
      return chainLow.includes(vLower) || vLower.includes(chainLow)
        || fboLow.includes(vLower) || vLower.includes(fboLow)
        // Also match first word (e.g. "Signature" matches "Signature Flight Support")
        || vLower.split(/\s+/)[0] === chainLow.split(/\s+/)[0];
    });

    if (match && match.facility_fee != null && match.gallons_to_waive != null) {
      return {
        minGallons: match.gallons_to_waive,
        feeWaived: match.facility_fee,
        fboName: match.fbo_name,
        landingFee: (match as FboFeeEntry).landing_fee ?? 0,
        securityFee: match.security_fee ?? 0,
        overnightFee: (match as FboFeeEntry).overnight_fee ?? 0,
      };
    }
  }

  // No vendor match — return the entry with the highest facility fee
  // (conservative: assume worst-case fee if we don't know the FBO)
  const withFees = entries.filter(e => e.facility_fee != null && e.facility_fee > 0 && e.gallons_to_waive != null);
  if (!withFees.length) return NO_WAIVER;

  // Pick the one with the highest fee (most impactful for tankering decision)
  const best = withFees.reduce((a, b) => (a.facility_fee! > b.facility_fee! ? a : b));
  return {
    minGallons: best.gallons_to_waive!,
    feeWaived: best.facility_fee!,
    fboName: best.fbo_name,
    landingFee: (best as FboFeeEntry).landing_fee ?? 0,
    securityFee: best.security_fee ?? 0,
    overnightFee: (best as FboFeeEntry).overnight_fee ?? 0,
  };
}

/**
 * Get all FBO options at an airport for a given aircraft type.
 * Useful for the UI to show a dropdown of FBOs with their fee details.
 */
export function getFboOptionsAtAirport(
  airport: string,
  aircraftType: string,
): FboWaiver[] {
  const ap = normalizeAirport(airport);
  const acType = AIRCRAFT_TYPE_MAP[aircraftType] ?? aircraftType;
  const key = `${ap}|${acType}`;
  const entries = fboIndex.get(key);
  if (!entries?.length) return [];

  return entries
    .filter(e => e.facility_fee != null && e.gallons_to_waive != null)
    .map(e => ({
      minGallons: e.gallons_to_waive!,
      feeWaived: e.facility_fee!,
      fboName: e.fbo_name,
      landingFee: (e as FboFeeEntry).landing_fee ?? 0,
      securityFee: e.security_fee ?? 0,
      overnightFee: (e as FboFeeEntry).overnight_fee ?? 0,
    }));
}
