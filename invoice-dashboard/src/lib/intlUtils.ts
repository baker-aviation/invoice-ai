/**
 * Client-safe international flight utilities.
 * No server-only imports — can be used in both client and server components.
 */

import type { Flight } from "@/lib/opsApi";

/** US ICAO prefixes (mainland K + territory P-prefixes + TI USVI + TJ Puerto Rico) */
const US_ICAO_PREFIXES = ["K", "PH", "PA", "PF", "PG", "PJ", "PK", "PM", "PO", "PP", "PW", "TI", "TJ"];

/** USVI/PR airports — currently treated as domestic (no customs required) */
const INTL_TREATED_ICAOS = new Set<string>();

/** Returns true if an ICAO code is outside the US (or is a US territory treated as international) */
export function isInternationalIcao(icao: string | null): boolean {
  if (!icao) return false;
  if (INTL_TREATED_ICAOS.has(icao)) return true;

  // US FAA LIDs (non-ICAO identifiers): 1B1, 7B2, N87, etc.
  // Real ICAO codes are always 4 uppercase letters. If it's not 4 chars,
  // or starts with a digit, it's a US domestic FAA identifier.
  if (icao.length !== 4 || /^\d/.test(icao)) return false;

  for (const prefix of US_ICAO_PREFIXES) {
    if (icao.startsWith(prefix)) return false;
  }
  return true;
}

/** Returns true if a flight departs or arrives internationally */
export function isInternationalFlight(flight: Flight): boolean {
  return isInternationalIcao(flight.departure_icao) || isInternationalIcao(flight.arrival_icao);
}
