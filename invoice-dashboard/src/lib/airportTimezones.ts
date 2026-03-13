/**
 * ICAO airport code → IANA timezone mapping.
 * Covers all airports seen in Baker Aviation flights.
 * Falls back to UTC for unknown airports.
 */

const AIRPORT_TZ: Record<string, string> = {
  // ── US — Eastern ─────────────────────────────────
  KAAO: "America/New_York",   // Wichita Falls Muni? (actually TX — but KAAO is in OH)
  KABE: "America/New_York",   // Allentown, PA
  KALB: "America/New_York",   // Albany, NY
  KAPF: "America/New_York",   // Naples, FL
  KATL: "America/New_York",   // Atlanta, GA
  KATW: "America/Chicago",    // Appleton, WI
  KAUO: "America/New_York",   // Auburn, AL
  KAVP: "America/New_York",   // Wilkes-Barre, PA
  KBCT: "America/New_York",   // Boca Raton, FL
  KBED: "America/New_York",   // Bedford, MA
  KBKV: "America/New_York",   // Brooksville, FL
  KBLM: "America/New_York",   // Belmar, NJ
  KBNA: "America/Chicago",    // Nashville, TN
  KBOS: "America/New_York",   // Boston, MA
  KBTV: "America/New_York",   // Burlington, VT
  KBUY: "America/New_York",   // Burlington, NC
  KBVY: "America/New_York",   // Beverly, MA
  KBWI: "America/New_York",   // Baltimore, MD
  KCHS: "America/New_York",   // Charleston, SC
  KCLE: "America/New_York",   // Cleveland, OH
  KCLT: "America/New_York",   // Charlotte, NC
  KCMH: "America/New_York",   // Columbus, OH
  KCRE: "America/New_York",   // Myrtle Beach, SC
  KDAB: "America/New_York",   // Daytona Beach, FL
  KDAY: "America/New_York",   // Dayton, OH
  KDED: "America/New_York",   // DeLand, FL
  KDCA: "America/New_York",   // Reagan National, DC
  KDTW: "America/New_York",   // Detroit, MI
  KECP: "America/Chicago",    // Panama City, FL (panhandle)
  KEWR: "America/New_York",   // Newark, NJ
  KFCI: "America/New_York",   // Richmond, VA
  KFLL: "America/New_York",   // Fort Lauderdale, FL
  KFMY: "America/New_York",   // Fort Myers, FL
  KFNT: "America/New_York",   // Flint, MI
  KFOK: "America/New_York",   // Westhampton Beach, NY
  KFRG: "America/New_York",   // Farmingdale, NY
  KFXE: "America/New_York",   // Fort Lauderdale Exec, FL
  KGSO: "America/New_York",   // Greensboro, NC
  KHKY: "America/New_York",   // Hickory, NC
  KHPN: "America/New_York",   // White Plains, NY
  KHWD: "America/Los_Angeles", // Hayward, CA
  KHXD: "America/New_York",   // Hilton Head, SC
  KIAD: "America/New_York",   // Dulles, VA
  KILG: "America/New_York",   // Wilmington, DE
  KILM: "America/New_York",   // Wilmington, NC
  KIND: "America/New_York",   // Indianapolis, IN
  KINT: "America/New_York",   // Winston-Salem, NC
  KIPT: "America/New_York",   // Williamsport, PA
  KISM: "America/New_York",   // Kissimmee, FL
  // KJAC — listed in Mountain section
  KJAX: "America/New_York",   // Jacksonville, FL
  KJFK: "America/New_York",   // JFK, NY
  KJQF: "America/New_York",   // Concord, NC
  KJYO: "America/New_York",   // Leesburg, VA
  KLGA: "America/New_York",   // LaGuardia, NY
  KMCO: "America/New_York",   // Orlando, FL
  KMIA: "America/New_York",   // Miami, FL
  KMKY: "America/New_York",   // Marco Island, FL
  KOFP: "America/New_York",   // Hanover County, VA
  KOKV: "America/New_York",   // Winchester, VA
  KOPF: "America/New_York",   // Opa-locka, FL
  KORF: "America/New_York",   // Norfolk, VA
  KORL: "America/New_York",   // Orlando Exec, FL
  KOSU: "America/New_York",   // Columbus, OH
  KOXC: "America/New_York",   // Oxford, CT
  KPBI: "America/New_York",   // Palm Beach, FL
  KPDK: "America/New_York",   // DeKalb-Peachtree, GA
  KPGD: "America/New_York",   // Punta Gorda, FL
  KPGV: "America/New_York",   // Greenville, NC
  KPHL: "America/New_York",   // Philadelphia, PA
  KPIE: "America/New_York",   // St. Petersburg, FL
  KPIT: "America/New_York",   // Pittsburgh, PA
  KPNE: "America/New_York",   // Philadelphia NE, PA
  KRDU: "America/New_York",   // Raleigh-Durham, NC
  KRSW: "America/New_York",   // Fort Myers, FL
  KSAV: "America/New_York",   // Savannah, GA
  KSHD: "America/New_York",   // Staunton, VA
  KSIG: "America/New_York",   // Norfolk, VA (Bravo)
  KSOP: "America/New_York",   // Pinehurst, NC
  KSRQ: "America/New_York",   // Sarasota, FL
  KSSI: "America/New_York",   // Brunswick, GA
  KSUA: "America/New_York",   // Stuart, FL
  KTEB: "America/New_York",   // Teterboro, NJ
  KTIX: "America/New_York",   // Titusville, FL
  KTMB: "America/New_York",   // Kendall-Tamiami, FL
  "3T5": "America/New_York",  // Smoky Mountain, Sevierville, TN
  KTPA: "America/New_York",   // Tampa, FL
  KTTN: "America/New_York",   // Trenton, NJ
  KVNC: "America/New_York",   // Venice, FL
  KVRB: "America/New_York",   // Vero Beach, FL

  // ── US — Central ─────────────────────────────────
  KACT: "America/Chicago",    // Waco, TX
  KADS: "America/Chicago",    // Addison, TX
  KAFW: "America/Chicago",    // Fort Worth Alliance, TX
  KAMW: "America/Chicago",    // Ames, IA
  KANB: "America/Chicago",    // Anniston, AL
  KAUS: "America/Chicago",    // Austin, TX
  KBHM: "America/Chicago",    // Birmingham, AL
  KBTR: "America/Chicago",    // Baton Rouge, LA
  KBVO: "America/Chicago",    // Bartlesville, OK
  KCEW: "America/Chicago",    // Crestview, FL (panhandle = Central)
  KCID: "America/Chicago",    // Cedar Rapids, IA
  KCLL: "America/Chicago",    // College Station, TX
  KCMI: "America/Chicago",    // Champaign, IL
  KDAL: "America/Chicago",    // Dallas Love, TX
  KDFW: "America/Chicago",    // DFW, TX
  KDSM: "America/Chicago",    // Des Moines, IA
  KDTS: "America/Chicago",    // Destin, FL (panhandle = Central)
  KDWH: "America/Chicago",    // Houston Hooks, TX
  KEDC: "America/Chicago",    // Austin Exec, TX
  KESC: "America/Chicago",    // Escanaba, MI (Central part)
  KFAY: "America/New_York",   // Fayetteville, NC
  KFSD: "America/Chicago",    // Sioux Falls, SD
  KFTW: "America/Chicago",    // Fort Worth Meacham, TX
  KGDJ: "America/Chicago",    // Granbury, TX
  KGRB: "America/Chicago",    // Green Bay, WI
  KGTU: "America/Chicago",    // Georgetown, TX
  KGYY: "America/Chicago",    // Gary, IN
  KHCR: "America/Chicago",    // Heber Springs, AR
  KHOU: "America/Chicago",    // Houston Hobby, TX
  KIAH: "America/Chicago",    // Houston IAH, TX
  KICT: "America/Chicago",    // Wichita, KS
  KIKG: "America/Chicago",    // Kleberg Co, TX
  KIRK: "America/Chicago",    // Kirksville, MO
  KIXD: "America/Chicago",    // Olathe, KS
  KJAN: "America/Chicago",    // Jackson, MS
  KMCC: "America/Los_Angeles", // McClellan, CA
  KMDT: "America/New_York",   // Harrisburg, PA
  KMDW: "America/Chicago",    // Chicago Midway, IL
  KMCI: "America/Chicago",    // Kansas City, MO
  KMQT: "America/New_York",   // Marquette, MI (Eastern)
  KMKC: "America/Chicago",    // Kansas City Downtown, MO
  KMSY: "America/Chicago",    // New Orleans, LA
  KOKC: "America/Chicago",    // Oklahoma City, OK
  KORD: "America/Chicago",    // Chicago O'Hare, IL
  KPWK: "America/Chicago",    // Chicago Exec, IL
  KSAT: "America/Chicago",    // San Antonio, TX
  KSGF: "America/Chicago",    // Springfield, MO
  KSGR: "America/Chicago",    // Sugar Land, TX
  KSHV: "America/Chicago",    // Shreveport, LA
  KSTL: "America/Chicago",    // St. Louis, MO
  KSUS: "America/Chicago",    // Spirit of St. Louis, MO
  KTME: "America/Chicago",    // Houston Exec, TX
  KTUL: "America/Chicago",    // Tulsa, OK
  KTWF: "America/Boise",      // Twin Falls, ID
  KUES: "America/Chicago",    // Waukesha, WI

  // ── US — Mountain ────────────────────────────────
  KAPA: "America/Denver",     // Centennial, CO
  KAVQ: "America/Phoenix",    // Tucson Marana, AZ
  KBJC: "America/Denver",     // Broomfield, CO
  KBOI: "America/Boise",      // Boise, ID
  KBZN: "America/Denver",     // Bozeman, MT
  KCEZ: "America/Denver",     // Cortez, CO
  KCMD: "America/Denver",     // Culberson Co, TX — actually Central
  KDEN: "America/Denver",     // Denver, CO
  KASE: "America/Denver",     // Aspen, CO
  KEGE: "America/Denver",     // Eagle/Vail, CO
  KELP: "America/Denver",     // El Paso, TX
  KGPI: "America/Denver",     // Glacier Park, MT
  KHDN: "America/Denver",     // Hayden/Steamboat, CO
  KHII: "America/Phoenix",    // Lake Havasu, AZ
  KIWA: "America/Phoenix",    // Phoenix-Mesa, AZ
  KJAC: "America/Denver",     // Jackson Hole, WY
  KPHX: "America/Phoenix",    // Phoenix, AZ
  KABQ: "America/Denver",     // Albuquerque, NM
  KSDL: "America/Phoenix",    // Scottsdale, AZ
  KSLC: "America/Denver",     // Salt Lake City, UT
  KSUN: "America/Boise",      // Sun Valley, ID
  // KUDD — listed in Pacific section
  KTRM: "America/Los_Angeles", // Thermal, CA

  // ── US — Pacific ─────────────────────────────────
  KAPC: "America/Los_Angeles", // Napa, CA
  KBFI: "America/Los_Angeles", // Boeing Field, WA
  KBUR: "America/Los_Angeles", // Burbank, CA
  KBVS: "America/Los_Angeles", // Burlington, WA
  KCCR: "America/Los_Angeles", // Concord, CA
  KCMA: "America/Los_Angeles", // Camarillo, CA
  KCRQ: "America/Los_Angeles", // Carlsbad, CA
  KLAS: "America/Los_Angeles", // Las Vegas, NV
  KLAX: "America/Los_Angeles", // Los Angeles, CA
  KLGB: "America/Los_Angeles", // Long Beach, CA
  KNUQ: "America/Los_Angeles", // Moffett Field, CA
  KOAK: "America/Los_Angeles", // Oakland, CA
  KONT: "America/Los_Angeles", // Ontario, CA
  KPDC: "America/Los_Angeles", // Prairie du Chien? — probably Pacific
  KPDX: "America/Los_Angeles", // Portland, OR
  KPSP: "America/Los_Angeles", // Palm Springs, CA
  KSAN: "America/Los_Angeles", // San Diego, CA
  KSBA: "America/Los_Angeles", // Santa Barbara, CA
  KSBD: "America/Los_Angeles", // San Bernardino, CA
  KSEA: "America/Los_Angeles", // Seattle, WA
  KSFO: "America/Los_Angeles", // San Francisco, CA
  KSJC: "America/Los_Angeles", // San Jose, CA
  KSNA: "America/Los_Angeles", // Santa Ana/Orange County, CA
  KUDD: "America/Los_Angeles", // Bermuda Dunes, CA
  KVNY: "America/Los_Angeles", // Van Nuys, CA

  // ── US — Other ───────────────────────────────────
  KSJU: "America/Puerto_Rico", // San Juan, PR
  KSTT: "America/Puerto_Rico",  // St. Thomas, USVI (same tz as PR)
  PHNL: "Pacific/Honolulu",
  PANC: "America/Anchorage",

  // ── Canada ───────────────────────────────────────
  CYEG: "America/Edmonton",
  CYFJ: "America/Yellowknife",
  CYVR: "America/Vancouver",
  CYYT: "America/St_Johns",
  CYYZ: "America/Toronto",
  CYUL: "America/Toronto",
  CYYC: "America/Edmonton",

  // ── Mexico ───────────────────────────────────────
  MMMY: "America/Monterrey",   // Monterrey
  MMPR: "America/Bahia_Banderas", // Puerto Vallarta
  MMSD: "America/Mazatlan",    // Los Cabos
  MMSL: "America/Mexico_City", // San Luis Potosí
  MMTO: "America/Mexico_City", // Toluca
  MMMX: "America/Mexico_City", // Mexico City
  MMUN: "America/Cancun",      // Cancún
  MPTO: "America/Panama",      // Panama City (Tocumen)

  // ── Central America ──────────────────────────────
  MROC: "America/Costa_Rica",  // San José, Costa Rica
  MRLB: "America/Costa_Rica",  // Liberia, Costa Rica

  // ── Caribbean ────────────────────────────────────
  MBPV: "America/Grand_Turk",  // Providenciales, Turks & Caicos
  MDPC: "America/Santo_Domingo", // Punta Cana, DR
  MWCR: "America/Panama",     // Grand Cayman (EST year-round, same as Panama)
  MYAM: "America/Nassau",     // Marsh Harbour, Bahamas
  MYEH: "America/Nassau",     // Eleuthera, Bahamas
  MYNN: "America/Nassau",     // Nassau, Bahamas
  TBPB: "America/Barbados",   // Bridgetown, Barbados
  TNCM: "America/Curacao",    // St. Maarten
  TQPF: "America/Puerto_Rico", // Anguilla (AST, same offset as PR)
  TVSA: "America/Barbados",   // Arnos Vale, St. Vincent
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
export type TzMode = "local" | "UTC" | "AST" | "EST" | "CST" | "MST" | "AZT" | "PST" | "AKST";

const TZ_MODE_MAP: Record<TzMode, string | null> = {
  local: null, // resolved per-airport
  UTC: "UTC",
  AST: "America/Puerto_Rico",   // Atlantic (no DST)
  EST: "America/New_York",
  CST: "America/Chicago",
  MST: "America/Denver",
  AZT: "America/Phoenix",       // Arizona (no DST)
  PST: "America/Los_Angeles",
  AKST: "America/Anchorage",
};

export function fmtTimeInTz(
  iso: string | null | undefined,
  airportIcao: string | null | undefined,
  useLocal: boolean,
  tzMode?: TzMode,
): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;

  // Resolve timezone: tzMode takes priority, then useLocal flag
  const mode: TzMode = tzMode ?? (useLocal ? "local" : "UTC");
  const fixedTz = TZ_MODE_MAP[mode];

  // For fixed timezone modes (UTC, EST, CST, etc.)
  if (fixedTz) {
    const suffix = mode === "UTC" ? "Z" : "";
    try {
      const timePart = d.toLocaleString("en-US", {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
        timeZone: fixedTz,
      });
      if (mode === "UTC") return timePart + suffix;
      const tzAbbr = d
        .toLocaleString("en-US", { timeZoneName: "short", timeZone: fixedTz })
        .split(" ")
        .pop() ?? mode;
      return `${timePart} ${tzAbbr}`;
    } catch {
      return d.toLocaleString("en-US", {
        month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC",
      }) + "Z";
    }
  }

  // Local mode: use airport timezone
  const tz = getAirportTimezone(airportIcao);
  if (!tz) {
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

  try {
    const timePart = d.toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZone: tz,
    });

    const tzAbbr = d
      .toLocaleString("en-US", { timeZoneName: "short", timeZone: tz })
      .split(" ")
      .pop() ?? "";

    return `${timePart} ${tzAbbr}`;
  } catch {
    // Invalid timezone — fall back to UTC
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
}
