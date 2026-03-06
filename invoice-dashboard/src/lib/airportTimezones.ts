/**
 * ICAO airport code → IANA timezone mapping.
 * Covers airports used by Baker Aviation flights.
 * Falls back to UTC for unknown airports.
 */

const AIRPORT_TZ: Record<string, string> = {
  // US — Eastern
  KABE: "America/New_York",
  KALB: "America/New_York",
  KAPF: "America/New_York",
  KBCT: "America/New_York",
  KDTW: "America/New_York",
  KGSO: "America/New_York",
  KHPN: "America/New_York",
  KHXD: "America/New_York",
  KIAD: "America/New_York",
  KOPF: "America/New_York",
  KPGD: "America/New_York",
  KPIE: "America/New_York",
  KSRQ: "America/New_York",
  KSSI: "America/New_York",
  KTEB: "America/New_York",
  KJFK: "America/New_York",
  KLGA: "America/New_York",
  KEWR: "America/New_York",
  KMIA: "America/New_York",
  KFLL: "America/New_York",
  KTPA: "America/New_York",
  KMCO: "America/New_York",
  KPBI: "America/New_York",
  KATL: "America/New_York",
  KCLT: "America/New_York",
  KRDU: "America/New_York",
  KBOS: "America/New_York",
  KPHL: "America/New_York",
  KBWI: "America/New_York",
  KDCA: "America/New_York",

  // US — Central
  KAAO: "America/Chicago",
  KACT: "America/Chicago",
  KADS: "America/Chicago",
  KAFW: "America/Chicago",
  KAMW: "America/Chicago",
  KANB: "America/Chicago",
  KAUS: "America/Chicago",
  KDAL: "America/Chicago",
  KDFW: "America/Chicago",
  KDTS: "America/Chicago",
  KEDC: "America/Chicago",
  KFTW: "America/Chicago",
  KHOU: "America/Chicago",
  KIAH: "America/Chicago",
  KJAN: "America/Chicago",
  KSAT: "America/Chicago",
  KSGF: "America/Chicago",
  KTME: "America/Chicago",
  KORD: "America/Chicago",
  KMDW: "America/Chicago",
  KMSY: "America/Chicago",
  KSTL: "America/Chicago",
  KMCI: "America/Chicago",
  KOKC: "America/Chicago",
  KTUL: "America/Chicago",

  // US — Mountain
  KAPA: "America/Denver",
  KDEN: "America/Denver",
  KASE: "America/Denver",
  KEGE: "America/Denver",
  KSLC: "America/Denver",
  KABQ: "America/Denver",
  KPHX: "America/Phoenix",
  KSDL: "America/Phoenix",

  // US — Pacific
  KAPC: "America/Los_Angeles",
  KBFI: "America/Los_Angeles",
  KLAS: "America/Los_Angeles",
  KLGB: "America/Los_Angeles",
  KPSP: "America/Los_Angeles",
  KSBA: "America/Los_Angeles",
  KSFO: "America/Los_Angeles",
  KVNY: "America/Los_Angeles",
  KLAX: "America/Los_Angeles",
  KSAN: "America/Los_Angeles",
  KSEA: "America/Los_Angeles",
  KPDX: "America/Los_Angeles",
  KOAK: "America/Los_Angeles",
  KSJC: "America/Los_Angeles",
  KONT: "America/Los_Angeles",
  KSNA: "America/Los_Angeles",
  KBUR: "America/Los_Angeles",

  // US — Other
  KSJU: "America/Puerto_Rico",
  PHNL: "Pacific/Honolulu",
  PANC: "America/Anchorage",

  // Canada
  CYEG: "America/Edmonton",
  CYFJ: "America/Yellowknife",
  CYVR: "America/Vancouver",
  CYYT: "America/St_Johns",
  CYYZ: "America/Toronto",
  CYUL: "America/Toronto",
  CYYC: "America/Edmonton",

  // Mexico
  MMPR: "America/Bahia_Banderas",
  MMSL: "America/Mexico_City",
  MMTO: "America/Mexico_City",
  MMMX: "America/Mexico_City",
  MMUN: "America/Cancun",

  // Caribbean
  MYNN: "America/Nassau",
};

/**
 * Get the IANA timezone for an ICAO airport code.
 * Returns null if unknown (caller should fall back to UTC).
 */
export function getAirportTimezone(icao: string | null | undefined): string | null {
  if (!icao) return null;
  return AIRPORT_TZ[icao.toUpperCase()] ?? null;
}

/**
 * Format a UTC ISO timestamp in the given timezone.
 * Returns something like "Mar 6, 09:06 EST" for local or "Mar 6, 14:06Z" for UTC.
 */
export function fmtTimeInTz(
  iso: string | null | undefined,
  airportIcao: string | null | undefined,
  useLocal: boolean,
): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;

  if (!useLocal) {
    // UTC format
    return (
      d.toLocaleString("en-US", {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
        timeZone: "UTC",
      }) + "Z"
    );
  }

  const tz = getAirportTimezone(airportIcao);
  if (!tz) {
    // Unknown airport — fall back to UTC
    return (
      d.toLocaleString("en-US", {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
        timeZone: "UTC",
      }) + "Z"
    );
  }

  // Format in local timezone with short tz abbreviation
  const timePart = d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: tz,
  });

  // Get timezone abbreviation (e.g. EST, CST, PST)
  const tzAbbr = d
    .toLocaleString("en-US", { timeZoneName: "short", timeZone: tz })
    .split(" ")
    .pop() ?? "";

  return `${timePart} ${tzAbbr}`;
}
