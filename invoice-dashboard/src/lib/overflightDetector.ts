/**
 * FIR Overflight Detector
 *
 * Given departure and arrival coordinates, computes a great-circle arc
 * and tests it against the FIR boundary dataset to determine which
 * countries' airspace the route overflies.
 */

import * as turf from "@turf/turf";
import { firBoundaries } from "./firBoundaries";

// ── Types ──────────────────────────────────────────────────────────

export type OverflightResult = {
  country_name: string;
  country_iso: string;
  fir_id: string;
};

// ── ICAO prefix → country ISO mapping ──────────────────────────────

const ICAO_PREFIX_MAP: Record<string, string> = {
  // US
  K: "US",
  // Canada
  C: "CA",
  // Catch-all M-prefix countries use 4-char prefix matching below
  // Mexico
  MM: "MX",
  // Guatemala
  MG: "GT",
  // Belize
  MZ: "BZ",
  // Honduras
  MH: "HN",
  // El Salvador
  MS: "SV",
  // Nicaragua
  MN: "NI",
  // Costa Rica
  MR: "CR",
  // Panama
  MP: "PA",
  // Cuba
  MU: "CU",
  // Jamaica
  MK: "JM",
  // Bahamas
  MY: "BS",
  // Dominican Republic
  MD: "DO",
  // Haiti
  MT: "HT",
  // Cayman Islands
  MW: "KY",
  // Puerto Rico / US Virgin Islands
  TJ: "PR",
  // TJSJ, TIST etc.
  TI: "PR",
  // Bermuda
  TX: "BM",
  // Trinidad & Tobago
  TT: "TT",
  // Barbados
  TB: "BB",
  // Antigua
  TA: "AG",
  // Guadeloupe (France)
  TF: "GP",
  // St Lucia
  TL: "LC",
  // Dominica
  TD: "DM",
  // Netherlands Antilles / Curacao
  TN: "CW",
  // St Vincent
  TV: "VC",
  // Turks & Caicos
  MB: "TC",
  // Colombia
  SK: "CO",
  // Venezuela
  SV: "VE",
  // Ecuador
  SE: "EC",
  // Brazil
  SB: "BR",
  // Peru
  SP: "PE",
  // Argentina
  SA: "AR",
  // Chile
  SC: "CL",
  // Bolivia
  SL: "BO",
  // Paraguay
  SG: "PY",
  // Uruguay
  SU: "UY",
  // Guyana
  SY: "GY",
  // Suriname
  SM: "SR",
};

/**
 * Maps an ICAO airport code to its country ISO code.
 * Tries 2-char prefix first (most specific), then 1-char.
 */
export function getCountryFromIcao(icao: string): string | null {
  if (!icao || icao.length < 3) return null;
  const upper = icao.toUpperCase();

  // 2-char prefix check first (e.g., MM, MG, SK, TJ, etc.)
  const two = upper.slice(0, 2);
  if (ICAO_PREFIX_MAP[two]) return ICAO_PREFIX_MAP[two];

  // 1-char prefix check (K = US, C = Canada)
  const one = upper.slice(0, 1);
  if (ICAO_PREFIX_MAP[one]) return ICAO_PREFIX_MAP[one];

  return null;
}

// ── Overflight detection ───────────────────────────────────────────

/**
 * Detects which FIR regions a great-circle route passes through.
 *
 * @param depLat  - Departure latitude
 * @param depLon  - Departure longitude
 * @param arrLat  - Arrival latitude
 * @param arrLon  - Arrival longitude
 * @param excludeCountries - ISO codes to exclude from results
 *   (e.g., ["US"] for a route departing/arriving in the US)
 *
 * @returns Array of overflown countries/FIRs, deduplicated by country.
 *   If a country has multiple FIRs overflown, each FIR is listed separately.
 */
export function detectOverflights(
  depLat: number,
  depLon: number,
  arrLat: number,
  arrLon: number,
  excludeCountries?: string[]
): OverflightResult[] {
  const excludeSet = new Set(
    (excludeCountries ?? []).map((c) => c.toUpperCase())
  );

  // Generate great-circle arc.
  // npoints controls resolution — more points = more accurate intersection
  // but slower. 100 is plenty for continental-scale routes.
  let route: GeoJSON.Feature;
  try {
    route = turf.greatCircle(
      turf.point([depLon, depLat]),
      turf.point([arrLon, arrLat]),
      { npoints: 100 }
    ) as GeoJSON.Feature;
  } catch {
    // turf.greatCircle can fail for very short distances or identical points
    // Fall back to a simple linestring
    route = turf.lineString([
      [depLon, depLat],
      [arrLon, arrLat],
    ]);
  }

  // Handle the case where greatCircle returns a MultiLineString
  // (happens when the route crosses the antimeridian)
  const routeFeatures: GeoJSON.Feature[] = [];
  if (route.geometry.type === "MultiLineString") {
    for (const coords of (route.geometry as GeoJSON.MultiLineString).coordinates) {
      routeFeatures.push(turf.lineString(coords));
    }
  } else {
    routeFeatures.push(route);
  }

  const results: OverflightResult[] = [];
  const seen = new Set<string>(); // track fir_id+name to avoid dupes

  // MHTG "Central American" FIR covers multiple countries as one polygon.
  // When detected, we report it as the combined FIR and let the caller
  // cross-reference with the countries table for specific permit needs.
  // Countries in MHTG: Honduras, Guatemala, Nicaragua, Costa Rica, El Salvador, Belize.

  for (const feature of firBoundaries.features) {
    const { fir_id, country_name, country_iso } = feature.properties;

    // Skip excluded countries
    if (excludeSet.has(country_iso.toUpperCase())) continue;

    // Test each segment of the route against this FIR polygon
    for (const segment of routeFeatures) {
      try {
        if (turf.booleanIntersects(segment, feature as GeoJSON.Feature)) {
          const key = `${fir_id}|${country_name}`;
          if (!seen.has(key)) {
            seen.add(key);
            results.push({ country_name, country_iso, fir_id });
          }
          break;
        }
      } catch {
        // Skip malformed geometries
      }
    }
  }

  return results;
}

/**
 * Convenience wrapper: detect overflights given ICAO codes and coordinates,
 * automatically excluding the departure and arrival countries.
 */
export function detectOverflightsFromIcao(
  depIcao: string,
  depLat: number,
  depLon: number,
  arrIcao: string,
  arrLat: number,
  arrLon: number
): OverflightResult[] {
  const exclude: string[] = [];

  const depCountry = getCountryFromIcao(depIcao);
  if (depCountry) exclude.push(depCountry);

  const arrCountry = getCountryFromIcao(arrIcao);
  if (arrCountry && arrCountry !== depCountry) exclude.push(arrCountry);

  return detectOverflights(depLat, depLon, arrLat, arrLon, exclude);
}
