/**
 * Crew Swap Optimizer v4 — Transport-First Assignment
 *
 * Full crew swap planning engine. For each crew member, evaluates all viable
 * transport options (commercial flights, Uber, rental car, drive), scores them
 * on cost + reliability + duty efficiency, and picks the best combination.
 *
 * KEY CHANGE from v3: Crew assignment is now TRANSPORT-FIRST.
 * Instead of estimating costs with a heuristic and then discovering infeasible
 * routes, we now:
 *   1. Build swap points for every tail
 *   2. Run full buildCandidates() + scoreCandidate() for every crew × tail combo
 *   3. Only assign crew where transport is PROVEN viable
 *   4. Run final transport plan with pre-validated assignments
 *
 * Enforces: 14hr duty day, midnight home deadline, FBO arrival buffers,
 * backup flight requirements, aircraft never unattended, and more.
 *
 * See swapRules.ts for all constants.
 */

import { estimateDriveTime, findNearbyCommercialAirports, isCommercialAirport, type DriveEstimate } from "./driveTime";
import { getAirportTimezone } from "./airportTimezones";
import { getCrewDifficulty } from "./airportTiers";
import type { FlightOffer } from "./amadeus";
import type { PilotRoute } from "./pilotRoutes";
import {
  MAX_DUTY_HOURS, DUTY_ON_BEFORE_COMMERCIAL, DEPLANE_BUFFER, TERMINAL_TO_FBO_BUFFER,
  FBO_ARRIVAL_BUFFER, FBO_ARRIVAL_BUFFER_PREFERRED, RELAXED_FBO_ARRIVAL_BUFFER,
  DUTY_OFF_AFTER_LAST_LEG,
  INTERNATIONAL_DUTY_OFF, AIRPORT_SECURITY_BUFFER, RENTAL_RETURN_BUFFER, MIN_OFFGOING_COMMERCIAL_BUFFER,
  EARLIEST_DUTY_ON_HOUR, UBER_MAX_MINUTES, RENTAL_MAX_MINUTES,
  RELAXED_RENTAL_MAX_MINUTES,
  BUDGET_CARRIERS, PREFERRED_HUBS, BACKUP_FLIGHT_MIN_GAP, MAX_CONNECTIONS,
  RELAXED_MAX_CONNECTIONS,
  EARLY_LATE_BONUS_PIC, EARLY_LATE_BONUS_SIC,
  RENTAL_HANDOFF_FUEL_COST, STAGGER_MIN_GAP_HOURS, HANDOFF_BUFFER_MINUTES,
  TEB_PENALTY_AIRPORTS, TEB_OFFGOING_PENALTY, TEB_ONCOMING_PENALTY,
  GROUND_ONLY_CUTOFF_HOUR,
} from "./swapRules";

// ─── Train routes (Amtrak NEC + Brightline) ──────────────────────────────────
const TRAIN_ROUTES: { stations: string[]; name: string; schedules: { dep: string; arr: string; durationMin: number }[]; costPerLeg: number }[] = [
  {
    name: "Amtrak NEC",
    // Northeast Corridor stations (IATA codes for nearby airports)
    stations: ["BOS", "PVD", "NHV", "STM", "NYP", "EWR", "TEB", "MMU", "ABE", "PHL", "ILG", "BWI", "DCA", "IAD"],
    // NHV=New Haven (KOXC/KHVN), STM=Stamford (KHPN), NYP=Penn Station (KLGA/KJFK/KEWR), ABE=Allentown (KABE)
    // Representative schedules (hourly service, key departure windows)
    schedules: [
      { dep: "05:30", arr: "09:30", durationMin: 240 },  // early morning
      { dep: "06:30", arr: "10:30", durationMin: 240 },
      { dep: "07:30", arr: "11:30", durationMin: 240 },
      { dep: "08:30", arr: "12:30", durationMin: 240 },
      { dep: "10:00", arr: "14:00", durationMin: 240 },
      { dep: "12:00", arr: "16:00", durationMin: 240 },
      { dep: "14:00", arr: "18:00", durationMin: 240 },
      { dep: "16:00", arr: "20:00", durationMin: 240 },
    ],
    costPerLeg: 75,  // avg NEC regional fare
  },
  {
    name: "Brightline",
    stations: ["MIA", "FLL", "WPB", "MCO"],
    schedules: [
      { dep: "06:00", arr: "09:30", durationMin: 210 },  // MIA→MCO full run
      { dep: "08:00", arr: "11:30", durationMin: 210 },
      { dep: "10:00", arr: "13:30", durationMin: 210 },
      { dep: "12:00", arr: "15:30", durationMin: 210 },
      { dep: "14:00", arr: "17:30", durationMin: 210 },
      { dep: "16:00", arr: "19:30", durationMin: 210 },
    ],
    costPerLeg: 50,  // avg Brightline fare
  },
];

// Map train station codes to nearby airport ICAOs (for matching crew homes/swap points)
const TRAIN_STATION_AIRPORTS: Record<string, string[]> = {
  "BOS": ["KBOS", "KBED"],
  "PVD": ["KPVD"],
  "NHV": ["KHVN", "KOXC", "KBDR"],
  "STM": ["KHPN"],
  "NYP": ["KLGA", "KJFK", "KEWR", "KTEB"],
  "EWR": ["KEWR"],
  "TEB": ["KTEB"],
  "MMU": ["KMMU"],
  "ABE": ["KABE"],
  "PHL": ["KPHL", "KILG"],
  "ILG": ["KILG"],
  "BWI": ["KBWI"],
  "DCA": ["KDCA", "KIAD"],
  "IAD": ["KIAD"],
  "MIA": ["KMIA", "KOPF", "KTMB"],
  "FLL": ["KFLL", "KFXE", "KBCT"],
  "WPB": ["KPBI"],
  "MCO": ["KMCO", "KORL", "KSFB", "KISM"],
};

// US territory airports that start with K but are effectively international
// (no ground transport from mainland, expensive flights)
// US territory airports — both K-prefixed (from JetInsight) and real ICAO codes
// These are effectively international: no ground transport from mainland, expensive flights
const TERRITORY_AIRPORTS = new Set([
  "KSJU", "TJSJ",   // San Juan, PR
  "KBQN", "TJBQ",   // Aguadilla, PR
  "KPSE", "TJPS",   // Ponce, PR
  "KSTT", "TIST",   // St Thomas, USVI
  "KSTX", "TISX",   // St Croix, USVI
]);

// ═══════════════════════════════════════════════════════════════════════════════
// LAYER 1: Types
// ═══════════════════════════════════════════════════════════════════════════════

export type CrewMember = {
  id: string;
  name: string;
  /** JetInsight legal name (when different from display name) */
  jetinsight_name?: string | null;
  role: "PIC" | "SIC";
  home_airports: string[];
  aircraft_types: string[];
  is_checkairman: boolean;
  /** Aircraft types this crew member is a checkairman for (e.g., ["citation_x"], ["challenger"], or both) */
  checkairman_types: string[];
  is_skillbridge: boolean;
  /** Crew grade 1-4: 1=struggling, 2=new but ok, 3=average, 4=rock solid/can train */
  grade: number;
  /** Per-crew restrictions (e.g., { no_international: true }) */
  restrictions: Record<string, boolean>;
  priority: number;
  standby_count?: number;
  rotation_group?: "A" | "B" | null;
};

export type FlightLeg = {
  id: string;
  tail_number: string;
  departure_icao: string;
  arrival_icao: string;
  scheduled_departure: string;
  scheduled_arrival: string | null;
  flight_type: string | null;
  pic: string | null;
  sic: string | null;
};

export type AirportAlias = {
  fbo_icao: string;
  commercial_icao: string;
  preferred: boolean;
};

export type SwapAssignment = {
  oncoming_pic: string | null;
  oncoming_sic: string | null;
  offgoing_pic: string | null;
  offgoing_sic: string | null;
  /** Swap point ICAO chosen during assignment phase — used by transport planner */
  oncoming_pic_swap_icao?: string;
  oncoming_sic_swap_icao?: string;
};

/** One row in the swap sheet — one crew member's travel plan */
export type CrewSwapRow = {
  name: string;
  home_airports: string[];
  role: "PIC" | "SIC";
  direction: "oncoming" | "offgoing";
  aircraft_type: string;
  tail_number: string;
  swap_location: string | null;
  all_swap_points: string[];  // IATA codes of all available swap points for this tail
  travel_type: "commercial" | "uber" | "rental_car" | "drive" | "none";
  flight_number: string | null;
  departure_time: string | null;
  arrival_time: string | null;
  travel_from: string | null;
  travel_to: string | null;
  cost_estimate: number | null;
  duration_minutes: number | null;
  available_time: string | null;
  duty_on_time: string | null;
  duty_off_time: string | null;
  is_checkairman: boolean;
  checkairman_types: string[];
  is_skillbridge: boolean;
  grade: number;
  volunteer_status: string | null;
  notes: string | null;
  warnings: string[];
  drive_estimate: DriveEstimate | null;
  flight_offer: FlightOffer | null;
  alt_flights: { flight_number: string; dep: string; arr: string; price: string }[];
  backup_flight: string | null;
  score: number;
  /** false = tentative/standby, true = confirmed/book it. Defaults to false for new plans. */
  confirmed: boolean;
};

export type SwapPointScore = {
  icao: string; iata: string; position: string; ease: number;
  drive_min: number; is_commercial: boolean; is_international: boolean;
  timing_penalty: number; proximity_bonus: number; after_live_bonus: number;
  comm_airports: number; selected: boolean;
};

export type SwapPlanResult = {
  swap_date: string;
  rows: CrewSwapRow[];
  warnings: string[];
  total_cost: number;
  plan_score: number;
  solved_count: number;
  unsolved_count: number;
  two_pass?: TwoPassStats;
  /** Per-tail swap point scoring breakdown (for debug/transparency) */
  swap_point_debug?: Record<string, SwapPointScore[]>;
  /** Missing flight cache pairs that could solve unsolved crew (for auto-seeding) */
  missing_flight_pairs?: { origin: string; destination: string; crew: string; tail: string }[];
  /** Diagnostic breakdown of WHY tails/crew are unsolved */
  diagnostics?: {
    unsolved_tails: {
      tail: string;
      role: "PIC" | "SIC";
      reason: string;
      type_mismatch_count: number;
      no_route_count: number;
      intl_restricted_count: number;
      route_score_zero_count: number;
      total_crew_checked: number;
    }[];
    unsolved_crew: {
      name: string;
      role: "PIC" | "SIC";
      tails_checked: number;
      type_mismatch_tails: string[];
      intl_restricted_tails: string[];
      no_route_tails: string[];
      route_score_zero_tails: string[];
    }[];
    type_mismatch_blockers: {
      tail: string;
      role: "PIC" | "SIC";
      tail_type: string;
      crew_types_available: string[];
    }[];
  };
};

/** Pre-optimizer constraints set by coordinator (forced crew→tail, pair, fleet) */
export type SwapConstraint =
  | { type: "force_tail"; crew_name: string; tail: string; reason?: string }
  | { type: "force_pair"; crew_a: string; crew_b: string; day?: string; reason?: string }
  | { type: "force_fleet"; crew_name: string; aircraft_type: string; reason?: string };

export type TwoPassStats = {
  pass1_solved: number;
  pass1_unsolved: number;
  pass1_cost: number;
  pass2_solved: number;
  pass2_volunteers_used: { name: string; role: "PIC" | "SIC"; tail: string; type: "early" | "late" }[];
  pass2_bonus_cost: number;
  pass3_solved: number;
  pass3_standby_used: { name: string; role: "PIC" | "SIC"; tail: string }[];
  pass3_relaxation: boolean;
  feedback_loop_solved: number;
  feedback_loop_iterations: number;
  feedback_loop_swaps: { crew_moved: string; role: "PIC" | "SIC"; from_tail: string; to_tail: string; backfilled_by: string; new_swap_point?: string }[];
  total_cost: number;
};

// ─── Internal Types ──────────────────────────────────────────────────────────

type TransportCandidate = {
  type: "commercial" | "uber" | "rental_car" | "drive" | "none";
  flightNumber: string | null;
  depTime: Date | null;
  arrTime: Date | null;
  from: string;
  to: string;
  cost: number;
  durationMin: number;
  isDirect: boolean;
  isBudgetCarrier: boolean;
  hubConnection: boolean;
  connectionCount: number;
  offer: FlightOffer | null;
  drive: DriveEstimate | null;
  fboArrivalTime: Date | null;
  /** Offgoing only: when crew physically leaves the FBO (depTime for ground, earlier for commercial) */
  fboLeaveTime: Date | null;
  dutyOnTime: Date | null;
  score: number;
  backups: TransportCandidate[];
};

type SwapPoint = {
  icao: string;
  time: Date;
  position: "before_live" | "after_live" | "between_legs" | "idle";
  isAdjacentLive: boolean;
  /** For between_legs: the departure time of the next leg (= deadline for oncoming crew) */
  window_end?: Date;
};

type CrewTask = {
  name: string;
  crewMember: CrewMember | null;
  role: "PIC" | "SIC";
  direction: "oncoming" | "offgoing";
  tail: string;
  aircraftType: string;
  swapPoint: SwapPoint;
  homeAirports: string[];
  candidates: TransportCandidate[];
  best: TransportCandidate | null;
  warnings: string[];
  earlyVolunteer?: boolean;
  lateVolunteer?: boolean;
};

// ═══════════════════════════════════════════════════════════════════════════════
// LAYER 2: Timing Engine
// ═══════════════════════════════════════════════════════════════════════════════

const LIVE_TYPES = new Set(["charter", "revenue", "owner"]);

function isLiveType(type: string | null): boolean {
  return !!type && LIVE_TYPES.has(type.toLowerCase());
}

export function ms(minutes: number): number { return minutes * 60_000; }

/** Get local hour at an airport for a UTC timestamp */
export function getLocalHour(utcDate: Date, icao: string): number {
  const tz = getAirportTimezone(icao) ?? "America/New_York";
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hour: "numeric", hour12: false,
  }).formatToParts(utcDate);
  return parseInt(parts.find(p => p.type === "hour")?.value ?? "12");
}

/**
 * Convert a local time at a specific timezone to UTC.
 * The old toLocaleString→new Date() round-trip was broken: new Date(localeString)
 * parses as SERVER local time (CDT), not the target timezone, adding ~1-5hr errors.
 *
 * Correct approach: guess UTC, check what local time that is, compute offset.
 */
export function localTimeToUtc(dateStr: string, hour: number, minute: number, tz: string): Date {
  const guess = new Date(`${dateStr}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00Z`);
  // What local hour does this UTC time correspond to in the target timezone?
  const localHour = parseInt(
    guess.toLocaleString("en-US", { timeZone: tz, hour: "numeric", hour12: false }),
  );
  // Compute the adjustment needed: if we want hour=18 local but guess gives localHour=14,
  // we need to add 4 hours to the UTC guess.
  let diff = hour - localHour;
  // Handle midnight wrapping (e.g., want 1am local but got 23 → diff=-22, should be +2)
  if (diff > 12) diff -= 24;
  if (diff < -12) diff += 24;
  return new Date(guess.getTime() + diff * 3600_000 + (minute > 0 ? 0 : 0));
}

/** Get midnight local at an airport on the NEXT day after dateStr (i.e. end of that day) */
export function midnightUtc(icao: string, dateStr: string): Date {
  const tz = getAirportTimezone(icao) ?? "America/New_York";
  const nextDay = new Date(dateStr);
  nextDay.setDate(nextDay.getDate() + 1);
  const ndStr = nextDay.toISOString().slice(0, 10);
  return localTimeToUtc(ndStr, 0, 0, tz);
}

/**
 * Parse a HasData flight time string using the airport's timezone.
 * HasData stores "YYYY-MM-DD HH:MM" in LOCAL airport time. Without this,
 * new Date() parses as server timezone (CDT) instead of airport timezone (EDT).
 */
function parseFlightTime(timeStr: string, airportIata: string): Date {
  // If the time is already a UTC ISO string (from hasdata.ts parseHdTime),
  // parse it directly — do NOT re-convert through localTimeToUtc or we'll
  // double-apply the timezone offset (e.g., 4h error for EDT airports).
  if (timeStr.endsWith("Z") || timeStr.includes("+") || /\.\d{3}Z$/.test(timeStr)) {
    return new Date(timeStr);
  }

  // Legacy/raw HasData format: "2026-03-18 14:30" (local airport time)
  const clean = timeStr.replace("T", " ").trim();
  const m = clean.match(/^(\d{4}-\d{2}-\d{2})\s+(\d{1,2}):(\d{2})/);
  if (!m) return new Date(timeStr); // fallback to default parsing
  const [, dateStr, hourStr, minStr] = m;
  const tz = getAirportTimezone(toIcao(airportIata)) ?? "America/New_York";
  return localTimeToUtc(dateStr, parseInt(hourStr), parseInt(minStr), tz);
}

/** Duty-on time for commercial flight from home airport */
export function dutyOnForCommercial(flightDepTime: Date): Date {
  return new Date(flightDepTime.getTime() - ms(DUTY_ON_BEFORE_COMMERCIAL));
}

/** Duty-on with drive to non-home airport first */
function dutyOnWithDrive(driveStartTime: Date): Date {
  return driveStartTime;
}

/** Duty-off for offgoing crew */
export function dutyOff(lastLegArrival: Date, isInternational: boolean): Date {
  const buffer = isInternational ? INTERNATIONAL_DUTY_OFF : DUTY_OFF_AFTER_LAST_LEG;
  return new Date(lastLegArrival.getTime() + ms(buffer));
}

/** When crew arrives at FBO after commercial flight + deplane + ground transport */
export function fboArrivalAfterCommercial(
  flightArrTime: Date,
  driveToFboMin: number,
): Date {
  // When crew arrives at a commercial airport and needs to get to a separate FBO:
  // deplane (30min) + terminal-to-FBO Uber (15min if driving to FBO, 0 if same airport) + drive
  const terminalToFbo = driveToFboMin > 0 ? TERMINAL_TO_FBO_BUFFER : 0;
  return new Date(flightArrTime.getTime() + ms(DEPLANE_BUFFER) + ms(terminalToFbo) + ms(driveToFboMin));
}

/** Latest departure time for offgoing crew to make it home by midnight */
function latestDepartureForMidnight(
  homeMidnight: Date,
  flightDurationMin: number,
  hasRentalReturn: boolean,
): Date {
  // Home arrival = flight arrival + deplane. Must be before midnight.
  // So flight must arrive by midnight - deplane_buffer
  // Flight departure = arrival - duration
  const arrivalDeadline = new Date(homeMidnight.getTime() - ms(DEPLANE_BUFFER));
  return new Date(arrivalDeadline.getTime() - ms(flightDurationMin));
}

/** Check 14hr duty day limit */
export function checkDutyDay(dutyOn: Date, dutyEnd: Date): { valid: boolean; hours: number } {
  const hours = (dutyEnd.getTime() - dutyOn.getTime()) / (60 * 60_000);
  return { valid: hours <= MAX_DUTY_HOURS, hours };
}

// ═══════════════════════════════════════════════════════════════════════════════
// LAYER 3: Transport Candidate Builder
// ═══════════════════════════════════════════════════════════════════════════════

function normalizeName(name: string): string {
  let n = name.trim().toLowerCase();
  if (n.includes(",")) {
    const parts = n.split(",").map((p) => p.trim());
    if (parts.length === 2) n = `${parts[1]} ${parts[0]}`;
  }
  return n.replace(/\s+/g, " ");
}

function findCrewByName(roster: CrewMember[], name: string, role: "PIC" | "SIC"): CrewMember | null {
  const norm = normalizeName(name);
  // Check jetinsight_name first (DB-stored legal name mapping)
  const jiMatch = roster.find((c) => c.role === role && c.jetinsight_name && normalizeName(c.jetinsight_name) === norm);
  if (jiMatch) return jiMatch;
  const jiMatchAny = roster.find((c) => c.jetinsight_name && normalizeName(c.jetinsight_name) === norm);
  if (jiMatchAny) return jiMatchAny;
  // Exact display name match
  const exact = roster.find((c) => c.role === role && normalizeName(c.name) === norm);
  if (exact) return exact;
  const normParts = norm.split(" ");
  const lastName = normParts[normParts.length - 1];
  const lastNameMatches = roster.filter((c) => {
    if (c.role !== role) return false;
    const cParts = normalizeName(c.name).split(" ");
    return cParts[cParts.length - 1] === lastName;
  });
  if (lastNameMatches.length === 1) return lastNameMatches[0];
  // Also try cross-role for jetinsight names with wrong role
  const crossRole = roster.find((c) => normalizeName(c.name) === norm);
  if (crossRole) return crossRole;
  return roster.find(
    (c) => c.role === role && (normalizeName(c.name).includes(norm) || norm.includes(normalizeName(c.name))),
  ) ?? null;
}

function findCommercialAirport(fboIcao: string, aliases: AirportAlias[]): string {
  const upper = fboIcao.toUpperCase();
  const preferred = aliases.find((a) => a.fbo_icao.toUpperCase() === upper && a.preferred);
  if (preferred) return preferred.commercial_icao;
  const any = aliases.find((a) => a.fbo_icao.toUpperCase() === upper);
  return any ? any.commercial_icao : fboIcao;
}

/** Get all commercial airports for an FBO (aliases first, then nearby within 30mi) */
export function findAllCommercialAirports(fboIcao: string, aliases: AirportAlias[]): string[] {
  const upper = fboIcao.toUpperCase();
  const result = new Set<string>();

  // 0. If the FBO itself is a commercial airport (e.g. KIAD, KRDU), include it first.
  //    The nearby-search skips self, so we'd miss it without this check.
  if (isCommercialAirport(upper)) result.add(upper);

  // 1. Check alias table (preferred first)
  const matching = aliases.filter((a) => a.fbo_icao.toUpperCase() === upper);
  const sorted = [...matching].sort((a, b) => (b.preferred ? 1 : 0) - (a.preferred ? 1 : 0));
  for (const a of sorted) result.add(a.commercial_icao);

  // 2. Find nearby commercial airports — 50 mile primary, 75 mile fallback.
  // 30mi missed DFW for KTKI (McKinney, 35mi) and similar cases where a major
  // hub with far more flights sits just outside the narrow radius.
  const nearby50 = findNearbyCommercialAirports(upper, 50);
  for (const n of nearby50) {
    if (!result.has(n.icao)) result.add(n.icao);
  }
  if (result.size === 0) {
    // Nothing within 50 miles — widen to 100 miles (covers truly isolated FBOs)
    const nearby100 = findNearbyCommercialAirports(upper, 100);
    for (const n of nearby100) {
      if (!result.has(n.icao)) result.add(n.icao);
    }
  }

  // 3. Fallback: if nothing found even within 75 miles, use the FBO code itself
  if (result.size === 0) result.add(fboIcao);

  return Array.from(result);
}

const ICAO_IATA: Record<string, string> = {
  // Canada
  CYYZ: "YYZ", CYUL: "YUL", CYVR: "YVR", CYOW: "YOW", CYYC: "YYC",
  CYEG: "YEG", CYWG: "YWG", CYHZ: "YHZ", CYQB: "YQB",
  // Mexico
  MMMX: "MEX", MMUN: "CUN", MMMY: "MTY", MMGL: "GDL", MMSD: "SJD",
  MMPR: "PVR", MMMD: "MID",
  // Caribbean
  MBPV: "MHH", MYNN: "NAS", MKJP: "KIN", TIST: "STT", TJSJ: "SJU",
  TNCM: "SXM", TFFR: "PTP", TAPA: "ANU",
  TXKF: "BDA", MYGF: "FPO", MYEH: "ELH",
  // Central America
  MROC: "SJO", MRLB: "LIR", MHTG: "TGU", MGGT: "GUA",
  MSLP: "SAL", MNMG: "MGA", MPTO: "PTY",
};

export function toIata(icao: string): string {
  if (ICAO_IATA[icao]) return ICAO_IATA[icao];
  return icao.length === 4 && icao.startsWith("K") ? icao.slice(1) : icao;
}

export function toIcao(code: string): string {
  return code.length === 3 ? `K${code}` : code;
}

function parseDuration(iso: string): number {
  const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?/);
  if (!m) return 0;
  return (parseInt(m[1] ?? "0") * 60) + parseInt(m[2] ?? "0");
}

/** Track keys we've already warned about to avoid log spam */
const _warnedFlightKeys = new Set<string>();

/** Look up commercial flights by key, trying alternate ICAO/IATA conversions */
function lookupFlights(
  commercialFlights: Map<string, FlightOffer[]>,
  origin: string,
  dest: string,
  date: string,
): FlightOffer[] {
  // Try primary key (already IATA-converted)
  const key = `${origin}-${dest}-${date}`;
  const primary = commercialFlights.get(key);
  if (primary) return primary;

  // Try raw ICAO keys (K-prefixed for US airports)
  const originIcao = origin.length === 3 ? `K${origin}` : origin;
  const destIcao = dest.length === 3 ? `K${dest}` : dest;
  const icaoKey = `${originIcao}-${destIcao}-${date}`;
  if (icaoKey !== key) {
    const icaoResult = commercialFlights.get(icaoKey);
    if (icaoResult) return icaoResult;
  }

  // Try mixed keys (one IATA, one ICAO)
  const mixedKey1 = `${originIcao}-${dest}-${date}`;
  const mixedKey2 = `${origin}-${destIcao}-${date}`;
  for (const mk of [mixedKey1, mixedKey2]) {
    if (mk !== key && mk !== icaoKey) {
      const mixedResult = commercialFlights.get(mk);
      if (mixedResult) return mixedResult;
    }
  }

  // Log a warning (once per unique key)
  if (!_warnedFlightKeys.has(key)) {
    _warnedFlightKeys.add(key);
    console.warn(`[SwapOptimizer] No commercial flights found for key "${key}" (map has ${commercialFlights.size} entries)`);
  }

  return [];
}

/** Build all transport candidates for a crew task */
function buildCandidates(
  task: CrewTask,
  aliases: AirportAlias[],
  commercialFlights: Map<string, FlightOffer[]> | undefined,
  swapDate: string,
  tailLegs?: FlightLeg[],
): TransportCandidate[] {
  const candidates: TransportCandidate[] = [];
  const swapIcao = task.swapPoint.icao;
  const commAirports = findAllCommercialAirports(swapIcao, aliases);
  const _debugCrew = task.name.includes("Sullivan") || task.name.includes("Ricci") || task.name.includes("Bengoechea") || task.name.includes("Weakley");

  // Determine deadline/target times
  const homeMidnight = task.homeAirports[0]
    ? midnightUtc(toIcao(task.homeAirports[0]), swapDate)
    : midnightUtc(swapIcao, swapDate);

  // Oncoming hard deadline: crew MUST arrive before the aircraft leaves the swap point.
  // For before_live: deadline = departure time of the next leg.
  // For between_legs: deadline = window_end (departure of the leg after the gap).
  // For after_live/idle: aircraft isn't departing, use 10pm local as safety net.
  let oncomingHardDeadline: Date | null = null;
  if (task.direction === "oncoming") {
    if (task.swapPoint.position === "before_live" || task.swapPoint.position === "between_legs") {
      // Use the actual aircraft departure as the hard deadline
      const depTime = (task.swapPoint.position === "between_legs" && task.swapPoint.window_end)
        ? task.swapPoint.window_end
        : task.swapPoint.time;
      // Crew must arrive FBO_ARRIVAL_BUFFER minutes before departure
      oncomingHardDeadline = new Date(depTime.getTime() - ms(FBO_ARRIVAL_BUFFER));
    } else {
      // after_live / idle — no departure constraint, use 11pm local
      // 10 PM was too aggressive — offgoing can hold 15-30 extra min easily
      const tz = getAirportTimezone(swapIcao) ?? "America/New_York";
      oncomingHardDeadline = localTimeToUtc(swapDate, 23, 0, tz);
    }
  }

  // If aircraft departs before 8am local, only ground transport (uber/rental) can make it.
  // Commercial flights can't arrive in time — reject commercial candidates for this swap point.
  let groundOnlySwap = false;
  if (task.direction === "oncoming" && (task.swapPoint.position === "before_live" || task.swapPoint.position === "between_legs")) {
    const depTime = (task.swapPoint.position === "between_legs" && task.swapPoint.window_end)
      ? task.swapPoint.window_end
      : task.swapPoint.time;
    const tz = getAirportTimezone(swapIcao) ?? "America/New_York";
    const depLocalHour = parseFloat(
      new Date(depTime).toLocaleString("en-US", { hour: "numeric", hour12: false, timeZone: tz })
    );
    if (depLocalHour < GROUND_ONLY_CUTOFF_HOUR) {
      groundOnlySwap = true;
    }
  }

  // Estimate duty-end for oncoming crew: last leg arrival + off-duty buffer
  // For offgoing crew: duty-end = when they arrive home (checked per-candidate)
  let oncomingDutyEnd: Date | null = null;
  if (task.direction === "oncoming" && tailLegs) {
    // Use stored date portion (same as extractSwapPoints) — JetInsight stores
    // local times as UTC, so slice(0,10) gives the intended schedule date.
    const wedLegs = tailLegs.filter((f) => f.scheduled_departure.slice(0, 10) === swapDate);
    const lastLeg = wedLegs[wedLegs.length - 1];
    if (lastLeg?.scheduled_arrival) {
      oncomingDutyEnd = dutyOff(new Date(lastLeg.scheduled_arrival), false);
    } else if (lastLeg) {
      // No arrival time — estimate 3hr flight + off-duty buffer
      oncomingDutyEnd = new Date(new Date(lastLeg.scheduled_departure).getTime() + ms(180) + ms(DUTY_OFF_AFTER_LAST_LEG));
    } else {
      // No legs on swap day — idle tail. Don't set an artificial duty end.
      // The 10 PM default was killing all morning flights (6 AM dep = 16hr duty).
      // Duty will be re-evaluated when actual legs get scheduled.
      oncomingDutyEnd = null;
    }
  }

  if (_debugCrew) {
    console.log(`[CandidateDebug] ${task.name}: buildCandidates START — swap=${toIata(swapIcao)} (${task.swapPoint.position}) commAirports=[${commAirports.map(c => toIata(c)).join(",")}] homes=[${task.homeAirports.join(",")}] deadline=${oncomingHardDeadline?.toISOString() ?? 'none'} dutyEnd=${oncomingDutyEnd?.toISOString() ?? 'none'} groundOnly=${groundOnlySwap}`);
  }

  for (const homeApt of task.homeAirports) {
    const homeIata = toIata(homeApt);
    const homeIcao = toIcao(homeApt);

    // ── Ground transport options ──────────────────────────────────────────
    const drive = estimateDriveTime(
      task.direction === "oncoming" ? homeIcao : swapIcao,
      task.direction === "oncoming" ? swapIcao : homeIcao,
    );

    if (drive && drive.estimated_drive_minutes <= RENTAL_MAX_MINUTES) {
      const driveMin = drive.estimated_drive_minutes;
      let type: "uber" | "rental_car" | "drive";
      let label: string;
      let cost: number;

      if (driveMin <= UBER_MAX_MINUTES) {
        type = "uber";
        label = "UBER";
        // Uber estimate: ~$2-3/mile for short rides
        cost = Math.max(25, Math.round(drive.estimated_drive_miles * 2.0));
      } else {
        type = "rental_car";
        label = "RENTAL";
        // Rental: ~$80/day + $0.50/mile for gas
        cost = 80 + Math.round(drive.estimated_drive_miles * 0.50);
      }

      // For oncoming: they need to arrive at FBO by the swap point time - buffer
      let depTime: Date | null = null;
      let arrTime: Date | null = null;
      let fboArr: Date | null = null;
      let dutyOn: Date | null = null;

      if (task.direction === "oncoming") {
        // Work backwards from when they need to be at FBO.
        // For between_legs, use window_end (next departure) instead of arrival time —
        // crew only needs to arrive before the aircraft's NEXT departure, not before it lands.
        const deadlineRef = (task.swapPoint.position === "between_legs" && task.swapPoint.window_end)
          ? task.swapPoint.window_end
          : task.swapPoint.time;
        const mustBeAtFbo = new Date(deadlineRef.getTime() - ms(FBO_ARRIVAL_BUFFER));
        arrTime = mustBeAtFbo;
        depTime = new Date(arrTime.getTime() - ms(driveMin));
        fboArr = arrTime;
        // Duty-on: for Uber < 1hr from home, no adjustment. Otherwise, start of drive.
        dutyOn = type === "uber" ? fboArr : depTime;

        // 14hr duty day check: duty-on through estimated end of flying day
        if (oncomingDutyEnd && dutyOn) {
          const { valid, hours } = checkDutyDay(dutyOn, oncomingDutyEnd);
          if (!valid) {
            if (_debugCrew) console.log(`[CandidateDebug] ${task.name}: REJECTED ${label} — duty day ${hours.toFixed(1)}hr exceeds ${MAX_DUTY_HOURS}hr (drive dep ${depTime?.toISOString()} to dutyEnd ${oncomingDutyEnd.toISOString()})`);
            continue;
          }
        }
      } else {
        // Offgoing: leaving the aircraft, driving home
        // For before_live/idle, use early morning — Step 2 constraint adjusts real timing
        let earliestLeave = task.swapPoint.time;
        if (task.swapPoint.position === "before_live" || task.swapPoint.position === "idle") {
          const tz = getAirportTimezone(task.swapPoint.icao) ?? "America/New_York";
          earliestLeave = localTimeToUtc(swapDate, 5, 0, tz);
        }
        depTime = earliestLeave;
        arrTime = new Date(depTime.getTime() + ms(driveMin));
        fboArr = null;
        dutyOn = null;

        // 14hr duty day check for offgoing: swap point (duty start proxy) → home arrival
        // Offgoing duty started before the swap, so we check from a reasonable duty-on
        // (earliest leg that day or 6am local) through home arrival
        if (arrTime.getTime() > homeMidnight.getTime()) {
          continue; // Won't make midnight — already checked but catches drive scenarios
        }
      }

      candidates.push({
        type,
        flightNumber: label,
        depTime,
        arrTime,
        from: task.direction === "oncoming" ? homeIata : toIata(swapIcao),
        to: task.direction === "oncoming" ? toIata(swapIcao) : homeIata,
        cost,
        durationMin: driveMin,
        isDirect: true,
        isBudgetCarrier: false,
        hubConnection: false,
        connectionCount: 0,
        offer: null,
        drive,
        fboArrivalTime: fboArr,
        fboLeaveTime: task.direction === "offgoing" ? depTime : null,
        dutyOnTime: dutyOn,
        score: 0,
        backups: [],
      });

      // Self-drive (personal car) removed from optimizer — available as manual override only.
    }

    // ── Train options (Amtrak NEC, Brightline) ────────────────────────────
    for (const route of TRAIN_ROUTES) {
      // Find which station(s) the home airport is near
      const homeStations = route.stations.filter(st =>
        TRAIN_STATION_AIRPORTS[st]?.some(ap => ap.toUpperCase() === homeIcao.toUpperCase())
      );
      // Find which station(s) the swap airport is near
      const swapStations = route.stations.filter(st =>
        TRAIN_STATION_AIRPORTS[st]?.some(ap => ap.toUpperCase() === swapIcao.toUpperCase())
      );

      if (homeStations.length === 0 || swapStations.length === 0) continue;

      // Determine direction on the route
      const homeIdx = Math.min(...homeStations.map(s => route.stations.indexOf(s)));
      const swapIdx = Math.min(...swapStations.map(s => route.stations.indexOf(s)));
      if (homeIdx === swapIdx) continue;

      // Estimate duration based on number of stops between stations
      const stops = Math.abs(swapIdx - homeIdx);
      const durationMin = Math.round(stops * (route.schedules[0].durationMin / (route.stations.length - 1)));
      const cost = route.costPerLeg;

      // Generate a candidate for each schedule
      for (const sched of route.schedules) {
        const depHour = parseInt(sched.dep.split(":")[0]);
        const depMin = parseInt(sched.dep.split(":")[1]);
        const tz = task.direction === "oncoming"
          ? (getAirportTimezone(homeIcao) ?? "America/New_York")
          : (getAirportTimezone(swapIcao) ?? "America/New_York");

        const depTime = localTimeToUtc(swapDate, depHour, depMin, tz);
        const arrTime = new Date(depTime.getTime() + durationMin * 60_000);

        let fboArr: Date | null = null;
        let dutyOn: Date | null = null;

        if (task.direction === "oncoming") {
          // Train arrives near swap airport, add ground transport time to FBO
          const driveToFbo = estimateDriveTime(toIcao(swapStations[0]), swapIcao);
          const driveMinToFbo = driveToFbo?.estimated_drive_minutes ?? 15;
          fboArr = new Date(arrTime.getTime() + driveMinToFbo * 60_000);
          dutyOn = depTime;

          if (oncomingHardDeadline && fboArr.getTime() > oncomingHardDeadline.getTime()) {
            const lateMin = (fboArr.getTime() - oncomingHardDeadline.getTime()) / 60_000;
            if (lateMin > 360) continue; // >6hr late = truly not viable
            // Keep with penalty (same logic as commercial flights)
          }
          if (oncomingDutyEnd && dutyOn) {
            const { valid } = checkDutyDay(dutyOn, oncomingDutyEnd);
            if (!valid) continue;
          }
        } else {
          // Offgoing: crew takes train from near swap point toward home
          const driveFromFbo = estimateDriveTime(swapIcao, toIcao(swapStations[0]));
          const driveMinFromFbo = driveFromFbo?.estimated_drive_minutes ?? 15;
          const fboLeave = new Date(depTime.getTime() - driveMinFromFbo * 60_000 - 30 * 60_000); // 30min buffer

          // Check if crew can make this train
          let releaseTime = task.swapPoint.time;
          if (task.swapPoint.position === "before_live" || task.swapPoint.position === "idle") {
            const spTz = getAirportTimezone(task.swapPoint.icao) ?? "America/New_York";
            releaseTime = localTimeToUtc(swapDate, 5, 0, spTz);
          }
          if (fboLeave.getTime() < releaseTime.getTime()) continue;

          // Check midnight
          if (arrTime.getTime() > homeMidnight.getTime()) continue;

          fboArr = null;
          dutyOn = null;
        }

        candidates.push({
          type: "commercial" as const,  // reuse commercial type for train (displays as flight number)
          flightNumber: `${route.name.replace(/\s+/g, "")} ${sched.dep.replace(":", "")}`,
          depTime,
          arrTime,
          from: task.direction === "oncoming" ? homeStations[0] : swapStations[0],
          to: task.direction === "oncoming" ? swapStations[0] : homeStations[0],
          cost,
          durationMin,
          isDirect: true,
          isBudgetCarrier: false,
          hubConnection: false,
          connectionCount: 0,
          offer: null,
          drive: null,
          fboArrivalTime: fboArr,
          fboLeaveTime: task.direction === "offgoing" ? new Date(depTime.getTime() - 30 * 60_000) : null,
          dutyOnTime: dutyOn,
          score: 0,
          backups: [],
        });
      }
    }

    // ── Commercial flight options ─────────────────────────────────────────
    if (!commercialFlights) continue;

    // Build search dates: swap-day (Wednesday), plus day-before/after for volunteers
    // SkillBridge crew can only go early if they volunteer (flag in oncoming pool)
    const datesToSearch = [swapDate];
    const canGoEarly = task.earlyVolunteer && !(task.crewMember?.is_skillbridge && !task.earlyVolunteer);
    if (canGoEarly) {
      const dayBefore = new Date(swapDate);
      dayBefore.setDate(dayBefore.getDate() - 1);
      datesToSearch.unshift(dayBefore.toISOString().slice(0, 10));
    }
    // Offgoing crew always searches next day — late after_live arrivals
    // (9-10 PM) have no same-day flights home. Thursday morning works.
    if (task.lateVolunteer || task.direction === "offgoing") {
      const dayAfter = new Date(swapDate);
      dayAfter.setDate(dayAfter.getDate() + 1);
      datesToSearch.push(dayAfter.toISOString().slice(0, 10));
    }

    // Resolve home to nearby commercial airports for flight search origins/destinations.
    // Crew at GA/FBO airports (e.g., KILG/Wilmington) can drive to a nearby commercial
    // airport (e.g., PHL) to catch flights. Without this, those crew show 0 flight options.
    const homeFlightAirports: { iata: string; driveCost: number; driveMin: number }[] =
      [{ iata: homeIata, driveCost: 0, driveMin: 0 }];
    if (!isCommercialAirport(homeIcao)) {
      const nearbyComm = findAllCommercialAirports(homeIcao, aliases);
      for (const nc of nearbyComm) {
        const ncIata = toIata(nc);
        if (ncIata === homeIata) continue;
        const d = estimateDriveTime(homeIcao, toIcao(nc));
        if (d && d.estimated_drive_minutes <= RENTAL_MAX_MINUTES) {
          const cost = d.estimated_drive_minutes <= UBER_MAX_MINUTES
            ? Math.max(25, Math.round(d.estimated_drive_miles * 2.0))
            : 80 + Math.round(d.estimated_drive_miles * 0.50);
          homeFlightAirports.push({ iata: ncIata, driveCost: cost, driveMin: d.estimated_drive_minutes });
        }
      }
    }

    // Skip commercial flights entirely if aircraft departs before 8am — only ground transport viable
    if (groundOnlySwap) {
      // No commercial candidates — ground transport (uber/rental) already added above
    } else for (const commApt of commAirports) {
      const commIata = toIata(commApt);
      const driveToFbo = estimateDriveTime(
        task.direction === "oncoming" ? toIcao(commIata) : swapIcao,
        task.direction === "oncoming" ? swapIcao : toIcao(commIata),
      );
      const driveToFboMin = driveToFbo?.estimated_drive_minutes ?? 0;

      for (const homeFlight of homeFlightAirports) {
      let originIata: string;
      let destIata: string;
      if (task.direction === "oncoming") {
        originIata = homeFlight.iata;
        destIata = commIata;
      } else {
        originIata = commIata;
        destIata = homeFlight.iata;
      }
      const homeGroundCost = homeFlight.driveCost;

      for (const searchDate of datesToSearch) {
      const offers = lookupFlights(commercialFlights, originIata, destIata, searchDate);
      if (_debugCrew && offers.length > 0) {
        console.log(`[CandidateDebug] ${task.name} (${task.direction} ${task.role}): ${originIata}→${destIata} found ${offers.length} offers for ${searchDate}`);
      }
      if (_debugCrew && offers.length === 0) {
        console.log(`[CandidateDebug] ${task.name}: ${originIata}→${destIata} NO OFFERS in cache for ${searchDate}`);
      }
      for (const offer of offers) {
        const segs = offer.itineraries?.[0]?.segments ?? [];
        if (segs.length === 0) continue;
        let missedDeadline = false;

        // Reject 2+ connections
        if (segs.length - 1 > MAX_CONNECTIONS) continue;

        const firstSeg = segs[0];
        const lastSeg = segs[segs.length - 1];

        // Parse HasData flight times using the correct airport timezone.
        // HasData stores local times ("2026-03-18 14:30") but new Date() parses
        // these as server local time (CDT), not the airport's timezone (EDT).
        // This 1-hour error causes flights to fail timing checks incorrectly.
        const flightDep = parseFlightTime(firstSeg.departure.at, firstSeg.departure.iataCode);
        const flightArr = parseFlightTime(lastSeg.arrival.at, lastSeg.arrival.iataCode);
        const totalDuration = segs.reduce((s, sg) => s + parseDuration(sg.duration), 0);
        const flightNum = segs.map((s) => `${s.carrierCode}${s.number}`).join("/");
        const isDirect = segs.length === 1;
        const isBudget = segs.some((s) => BUDGET_CARRIERS.includes(s.carrierCode));
        const isHub = segs.length > 1 && segs.some((s) =>
          PREFERRED_HUBS.includes(s.arrival.iataCode) || PREFERRED_HUBS.includes(s.departure.iataCode),
        );

        let fboArr: Date | null = null;
        let dutyOn: Date | null = null;
        let cost = parseFloat(offer.price.total);

        // Add ground transport cost to/from commercial airport
        let groundCost = 0;
        if (driveToFboMin > 0 && driveToFboMin <= UBER_MAX_MINUTES) {
          groundCost = Math.max(25, Math.round((driveToFbo?.estimated_drive_miles ?? 0) * 2.0));
        } else if (driveToFboMin > 0) {
          groundCost = 80 + Math.round((driveToFbo?.estimated_drive_miles ?? 0) * 0.50);
        }

        if (task.direction === "oncoming") {
          fboArr = fboArrivalAfterCommercial(flightArr, driveToFboMin);
          dutyOn = dutyOnForCommercial(flightDep);

          // Hard deadline: must arrive at FBO before aircraft departs.
          // If ALL candidates miss the deadline, we still keep them (heavily penalized)
          // so the feasibility matrix marks this crew as viable with a late-arrival penalty.
          // This prevents offgoing deadline cascading from making tails completely unsolvable.
          let missedDeadline = false;
          if (oncomingHardDeadline && fboArr.getTime() > oncomingHardDeadline.getTime()) {
            // How late are we? If more than 6 hours past deadline, truly not viable
            const lateMinutes = (fboArr.getTime() - oncomingHardDeadline.getTime()) / 60_000;
            if (lateMinutes > 360) {
              if (_debugCrew) console.log(`[CandidateDebug] ${task.name}: REJECTED ${flightNum} — FBO arrival ${fboArr.toISOString()} > deadline ${oncomingHardDeadline.toISOString()} (${Math.round(lateMinutes)}min late, >6hr)`);
              continue;
            }
            missedDeadline = true;
            if (_debugCrew) console.log(`[CandidateDebug] ${task.name}: LATE ${flightNum} — FBO arrival ${fboArr.toISOString()} > deadline ${oncomingHardDeadline.toISOString()} (${Math.round(lateMinutes)}min late, keeping with penalty)`);
          }

          // Check: duty-on not before 0400 local
          const localHour = getLocalHour(dutyOn, homeIcao);
          if (localHour < EARLIEST_DUTY_ON_HOUR && localHour >= 0) {
            // Soft penalty, don't reject
          }

          // 14hr duty day check: duty-on through estimated end of flying day
          if (oncomingDutyEnd && dutyOn) {
            const { valid, hours } = checkDutyDay(dutyOn, oncomingDutyEnd);
            if (!valid) {
              if (_debugCrew) console.log(`[CandidateDebug] ${task.name}: REJECTED ${flightNum} — duty day ${hours.toFixed(1)}hr exceeds ${MAX_DUTY_HOURS}hr (${dutyOn.toISOString()} to ${oncomingDutyEnd.toISOString()})`);
              continue;
            }
          }
        } else {
          // Offgoing: check if they can make this flight
          // For before_live and idle swap points, offgoing crew can leave as soon
          // as oncoming arrives — use early morning as candidate filter, then the
          // aircraft-unattended constraint (Step 2) enforces the real timing.
          // For after_live/between_legs, the crew works through that leg first.
          let releaseTime = task.swapPoint.time;
          if (task.swapPoint.position === "before_live" || task.swapPoint.position === "idle") {
            const tz = getAirportTimezone(task.swapPoint.icao) ?? "America/New_York";
            releaseTime = localTimeToUtc(swapDate, 5, 0, tz);
          }
          // Need to get to commercial airport + security buffer
          const buffer = driveToFboMin > UBER_MAX_MINUTES ? RENTAL_RETURN_BUFFER : AIRPORT_SECURITY_BUFFER;
          const needAtAirport = new Date(flightDep.getTime() - ms(buffer));
          const needLeaveAircraft = new Date(needAtAirport.getTime() - ms(driveToFboMin));

          // Allow 30min grace — crew can rush to airport if flight is tight.
          // Hard reject only if they'd need to leave >30min before release.
          const RELEASE_GRACE_MS = ms(30);
          if (needLeaveAircraft.getTime() < releaseTime.getTime() - RELEASE_GRACE_MS) {
            if (_debugCrew) console.log(`[CandidateDebug] ${task.name}: REJECTED ${flightNum} — need leave ${needLeaveAircraft.toISOString()} < release ${releaseTime.toISOString()} - 30min grace`);
            continue;
          }

          // Flag tight departures: commercial flight departs < 90 min after last leg lands.
          // For after_live/between_legs, releaseTime = last leg arrival. Check gap.
          const gapFromLandingMin = (flightDep.getTime() - releaseTime.getTime()) / 60_000;
          if ((task.swapPoint.position === "after_live" || task.swapPoint.position === "between_legs") &&
              gapFromLandingMin < MIN_OFFGOING_COMMERCIAL_BUFFER) {
            // Hard reject if gap < 45 min (physically impossible)
            if (gapFromLandingMin < AIRPORT_SECURITY_BUFFER) {
              if (_debugCrew) console.log(`[CandidateDebug] ${task.name}: REJECTED ${flightNum} — only ${Math.round(gapFromLandingMin)}min after landing (need ${MIN_OFFGOING_COMMERCIAL_BUFFER}min)`);
              continue;
            }
            // Soft penalty + keep with warning for 45-89 min gap
            cost += 200;
            if (_debugCrew) console.log(`[CandidateDebug] ${task.name}: TIGHT ${flightNum} — only ${Math.round(gapFromLandingMin)}min after landing (want ${MIN_OFFGOING_COMMERCIAL_BUFFER}min), keeping with penalty`);
          }

          // Check midnight deadline — allow 1 AM grace (crew can arrive slightly late)
          const homeArr = new Date(flightArr.getTime() + ms(DEPLANE_BUFFER));
          const midnightGrace = new Date(homeMidnight.getTime() + ms(60)); // 1 AM
          if (homeArr.getTime() > midnightGrace.getTime()) {
            // Skill-Bridge SIC gets Thursday midnight
            if (task.crewMember?.is_skillbridge && task.role === "SIC") {
              const thurMidnight = new Date(homeMidnight.getTime() + 24 * 60 * 60_000);
              if (homeArr.getTime() > thurMidnight.getTime()) continue;
            } else {
              // Next-day (Thursday) flights: allow offgoing crew to arrive home by
              // Thursday noon if no same-day flights work. This adds a hotel night
              // but is better than "no viable transport — arrange manually".
              const thurNoon = new Date(homeMidnight.getTime() + 12 * 60 * 60_000);
              if (homeArr.getTime() <= thurNoon.getTime()) {
                // Keep this candidate but add hotel cost penalty
                cost += 150; // Hotel night estimate
              } else {
                continue; // Won't make Thursday noon either
              }
            }
          }
          fboArr = null;
          dutyOn = null;
        }

        // For offgoing commercial: compute when crew physically leaves the FBO
        let fboLeave: Date | null = null;
        if (task.direction === "offgoing") {
          const buffer = driveToFboMin > UBER_MAX_MINUTES ? RENTAL_RETURN_BUFFER : AIRPORT_SECURITY_BUFFER;
          fboLeave = new Date(flightDep.getTime() - ms(buffer) - ms(driveToFboMin));
        }

        const candidate: TransportCandidate = {
          type: "commercial",
          flightNumber: flightNum,
          depTime: flightDep,
          arrTime: flightArr,
          from: firstSeg.departure.iataCode,
          to: lastSeg.arrival.iataCode,
          cost: cost + groundCost + homeGroundCost,
          durationMin: totalDuration,
          isDirect,
          isBudgetCarrier: isBudget,
          hubConnection: isHub,
          connectionCount: segs.length - 1,
          offer,
          drive: driveToFbo,
          fboArrivalTime: fboArr,
          fboLeaveTime: fboLeave,
          dutyOnTime: dutyOn,
          score: 0,
          backups: [],
        };

        // Apply heavy penalty if candidate misses the deadline (but was kept as fallback)
        if (missedDeadline) {
          candidate.score = -50; // Will be overridden by scoreCandidate, but signals low priority
          candidate.cost += 500; // $500 penalty for late arrival
        }

        if (_debugCrew) console.log(`[CandidateDebug] ${task.name}: ${missedDeadline ? 'LATE-ACCEPTED' : 'ACCEPTED'} ${flightNum} ${originIata}→${destIata} dep=${flightDep.toISOString().slice(11,16)} fboArr=${fboArr?.toISOString().slice(11,16) ?? '?'} cost=$${Math.round(cost + groundCost)}`);
        candidates.push(candidate);
      }
      } // end for searchDate
      } // end for homeFlight
    } // end for commApt
  } // end for homeApt

  // ── Drive-to-hub for offgoing crew ────────────────────────────────────────
  // When offgoing crew finish at a small airport late in the evening (e.g. CHS
  // at 7:48 PM), there may be no same-day flights home from nearby airports.
  // In that case, they can rent a car and drive 2-4 hours to a major hub (ATL,
  // CLT, ORD, DFW, etc.) that has later flights.
  const hasCommercialCandidates = candidates.some(c => c.type === "commercial");
  if (task.direction === "offgoing" && !hasCommercialCandidates && commercialFlights) {
    const MAX_DRIVE_TO_HUB_MIN = 240; // 4 hours max drive

    // Find all commercial airports within 250 miles of swap point
    const hubAirports = findNearbyCommercialAirports(swapIcao, 250);
    // Filter out airports already checked in the regular search
    const commAirportSet = new Set(commAirports.map(c => c.toUpperCase()));
    const newHubs = hubAirports.filter(h => !commAirportSet.has(h.icao.toUpperCase()));

    if (_debugCrew) {
      console.log(`[CandidateDebug] ${task.name}: DRIVE-TO-HUB — no commercial candidates found, checking ${newHubs.length} hub airports within 250mi (excluded ${hubAirports.length - newHubs.length} already-checked)`);
    }

    // Build search dates for offgoing (same logic as regular search)
    const hubDatesToSearch = [swapDate];
    const hubDayAfter = new Date(swapDate);
    hubDayAfter.setDate(hubDayAfter.getDate() + 1);
    hubDatesToSearch.push(hubDayAfter.toISOString().slice(0, 10));

    for (const hub of newHubs) {
      const hubIcao = hub.icao;
      const hubIata = toIata(hubIcao);

      // Calculate drive time from swap point to this hub
      const driveToHub = estimateDriveTime(swapIcao, hubIcao);
      if (!driveToHub || driveToHub.estimated_drive_minutes > MAX_DRIVE_TO_HUB_MIN) continue;

      const driveMin = driveToHub.estimated_drive_minutes;
      const driveCost = 80 + Math.round(driveToHub.estimated_drive_miles * 0.50); // rental car cost

      if (_debugCrew) {
        console.log(`[CandidateDebug] ${task.name}: DRIVE-TO-HUB checking ${hubIata} (${Math.round(hub.distanceMiles)}mi, ~${Math.round(driveMin)}min drive)`);
      }

      for (const homeApt of task.homeAirports) {
        const homeIata = toIata(homeApt);
        const homeIcao = toIcao(homeApt);

        // Expand home to nearby commercial airports (same as regular search)
        const hubHomeFlightAirports: { iata: string; driveCost: number }[] =
          [{ iata: homeIata, driveCost: 0 }];
        if (!isCommercialAirport(homeIcao)) {
          const nearbyComm = findAllCommercialAirports(homeIcao, aliases);
          for (const nc of nearbyComm) {
            const ncIata = toIata(nc);
            if (ncIata === homeIata) continue;
            const d = estimateDriveTime(homeIcao, toIcao(nc));
            if (d && d.estimated_drive_minutes <= RENTAL_MAX_MINUTES) {
              const cost = d.estimated_drive_minutes <= UBER_MAX_MINUTES
                ? Math.max(25, Math.round(d.estimated_drive_miles * 2.0))
                : 80 + Math.round(d.estimated_drive_miles * 0.50);
              hubHomeFlightAirports.push({ iata: ncIata, driveCost: cost });
            }
          }
        }

        for (const homeFlight of hubHomeFlightAirports) {
          const originIata = hubIata;
          const destIata = homeFlight.iata;
          const homeGroundCost = homeFlight.driveCost;

          for (const searchDate of hubDatesToSearch) {
            const offers = lookupFlights(commercialFlights, originIata, destIata, searchDate);
            if (_debugCrew && offers.length > 0) {
              console.log(`[CandidateDebug] ${task.name}: DRIVE-TO-HUB ${originIata}→${destIata} found ${offers.length} offers for ${searchDate}`);
            }

            for (const offer of offers) {
              const segs = offer.itineraries?.[0]?.segments ?? [];
              if (segs.length === 0) continue;
              if (segs.length - 1 > MAX_CONNECTIONS) continue;

              const firstSeg = segs[0];
              const lastSeg = segs[segs.length - 1];

              const flightDep = parseFlightTime(firstSeg.departure.at, firstSeg.departure.iataCode);
              const flightArr = parseFlightTime(lastSeg.arrival.at, lastSeg.arrival.iataCode);
              const totalFlightDuration = segs.reduce((s, sg) => s + parseDuration(sg.duration), 0);
              const flightNum = segs.map((s) => `${s.carrierCode}${s.number}`).join("/");
              const isDirect = segs.length === 1;
              const isBudget = segs.some((s) => BUDGET_CARRIERS.includes(s.carrierCode));
              const isHub = segs.length > 1 && segs.some((s) =>
                PREFERRED_HUBS.includes(s.arrival.iataCode) || PREFERRED_HUBS.includes(s.departure.iataCode),
              );

              const flightCost = parseFloat(offer.price.total);

              // Offgoing timing: crew must be released, drive to hub, clear security, then fly
              let releaseTime = task.swapPoint.time;
              if (task.swapPoint.position === "before_live" || task.swapPoint.position === "idle") {
                const tz = getAirportTimezone(task.swapPoint.icao) ?? "America/New_York";
                releaseTime = localTimeToUtc(swapDate, 5, 0, tz);
              }

              // Need: release → drive to hub → security buffer → flight departs
              const needAtHub = new Date(flightDep.getTime() - ms(RENTAL_RETURN_BUFFER));
              const needLeaveFbo = new Date(needAtHub.getTime() - ms(driveMin));

              if (needLeaveFbo.getTime() < releaseTime.getTime()) {
                if (_debugCrew) console.log(`[CandidateDebug] ${task.name}: DRIVE-TO-HUB REJECTED ${flightNum} — need leave FBO ${needLeaveFbo.toISOString()} < release ${releaseTime.toISOString()}`);
                continue;
              }

              // Check midnight deadline at home
              const homeArr = new Date(flightArr.getTime() + ms(DEPLANE_BUFFER));
              const homeHomeMidnight = task.homeAirports[0]
                ? midnightUtc(toIcao(task.homeAirports[0]), swapDate)
                : homeMidnight;
              if (homeArr.getTime() > homeHomeMidnight.getTime()) {
                // SkillBridge SIC gets Thursday midnight
                if (task.crewMember?.is_skillbridge && task.role === "SIC") {
                  const thurMidnight = new Date(homeHomeMidnight.getTime() + 24 * 60 * 60_000);
                  if (homeArr.getTime() > thurMidnight.getTime()) continue;
                } else {
                  continue; // Won't make midnight
                }
              }

              const totalCost = driveCost + flightCost + homeGroundCost;
              const totalDuration = driveMin + totalFlightDuration;
              const displayFlightNum = `RENTAL→${hubIata} + ${flightNum}`;

              const candidate: TransportCandidate = {
                type: "rental_car",
                flightNumber: displayFlightNum,
                depTime: flightDep,
                arrTime: flightArr,
                from: toIata(swapIcao),
                to: lastSeg.arrival.iataCode,
                cost: totalCost,
                durationMin: totalDuration,
                isDirect,
                isBudgetCarrier: isBudget,
                hubConnection: isHub,
                connectionCount: segs.length - 1,
                offer,
                drive: driveToHub,
                fboArrivalTime: null,
                fboLeaveTime: needLeaveFbo,
                dutyOnTime: null,
                score: 0,
                backups: [],
              };

              if (_debugCrew) console.log(`[CandidateDebug] ${task.name}: DRIVE-TO-HUB ACCEPTED ${displayFlightNum} dep=${flightDep.toISOString().slice(11,16)} homeArr=${homeArr.toISOString().slice(11,16)} cost=$${Math.round(totalCost)} (rental=$${driveCost} + flight=$${Math.round(flightCost)})`);
              candidates.push(candidate);
            }
          }
        }
      }
    }

    if (_debugCrew) {
      const hubCandidateCount = candidates.filter(c => c.flightNumber?.startsWith("RENTAL→")).length;
      console.log(`[CandidateDebug] ${task.name}: DRIVE-TO-HUB found ${hubCandidateCount} total drive-to-hub candidates`);
    }
  }

  if (_debugCrew) {
    console.log(`[CandidateDebug] ${task.name}: TOTAL ${candidates.filter(c => c.type !== "none").length} viable candidates from ${commAirports.length} commercial airports`);
    if (candidates.every(c => c.type === "none")) {
      console.log(`[CandidateDebug] ${task.name}: ALL REJECTED. swapIcao=${swapIcao} commAirports=[${commAirports.map(c => toIata(c)).join(",")}] homeAirports=[${task.homeAirports.join(",")}]`);
    }
  }

  // If no candidates found, add a "none" placeholder
  if (candidates.length === 0) {
    candidates.push({
      type: "none",
      flightNumber: null,
      depTime: null,
      arrTime: null,
      from: task.direction === "offgoing" ? toIata(task.swapPoint.icao) : (task.homeAirports[0] ? toIata(task.homeAirports[0]) : "???"),
      to: task.direction === "offgoing" ? (task.homeAirports[0] ? toIata(task.homeAirports[0]) : "???") : toIata(task.swapPoint.icao),
      cost: 0,
      durationMin: 0,
      isDirect: false,
      isBudgetCarrier: false,
      hubConnection: false,
      connectionCount: 0,
      offer: null,
      drive: null,
      fboArrivalTime: null,
      fboLeaveTime: null,
      dutyOnTime: null,
      score: 0,
      backups: [],
    });
  }

  return candidates;
}

// ═══════════════════════════════════════════════════════════════════════════════
// LAYER 4: Scoring Engine
// ═══════════════════════════════════════════════════════════════════════════════

/** Find backup flights for a commercial candidate */
function findBackups(
  primary: TransportCandidate,
  allCandidates: TransportCandidate[],
  task?: CrewTask,
): TransportCandidate[] {
  if (primary.type !== "commercial" || !primary.depTime) return [];

  return allCandidates.filter((c) => {
    if (c === primary) return false;
    if (c.type !== "commercial") return false;
    if (!c.depTime || !primary.depTime) return false;
    // Backup must depart at least BACKUP_FLIGHT_MIN_GAP after primary
    const gap = (c.depTime.getTime() - primary.depTime.getTime()) / 60_000;
    if (gap < BACKUP_FLIGHT_MIN_GAP) return false;

    // Backup must still arrive at FBO before 1800 local (offgoing crew holds until then)
    if (task?.direction === "oncoming" && c.fboArrivalTime) {
      const tz = getAirportTimezone(task.swapPoint.icao) ?? "America/New_York";
      const dateStr = task.swapPoint.time.toISOString().slice(0, 10);
      const hardDeadline = localTimeToUtc(dateStr, 22, 0, tz);
      if (c.fboArrivalTime.getTime() > hardDeadline.getTime()) return false;
    }

    return true;
  }).slice(0, 3);
}

/** Score a single transport candidate (0-100, higher = better) */
function scoreCandidate(
  c: TransportCandidate,
  task: CrewTask,
  pairCandidate: TransportCandidate | null, // PIC's choice, for SIC pairing bonus
): number {
  if (c.type === "none") return 0;

  let score = 50; // baseline

  // ── Cost scoring (lower cost = higher score) ───────────────────────────
  // $0 = +25, $300 = +10, $600+ = 0
  const costPenalty = Math.max(0, 25 - Math.round(c.cost / 25));
  score += costPenalty;

  // ── Reliability scoring ────────────────────────────────────────────────
  if (c.type === "uber" || c.type === "rental_car") {
    // Scale reliability by drive time — 20min Uber ≠ 5hr rental
    const driveMin = c.durationMin ?? 0;
    if (driveMin <= UBER_MAX_MINUTES) score += 15;       // Uber: highly reliable
    else if (driveMin <= 120) score += 12;                // Short rental: 1-2hr
    else if (driveMin <= 240) score += 8;                 // Medium rental: 2-4hr
    else score += 3;                                       // Long rental: 4-5hr, eats duty day
  } else if (c.type === "commercial") {
    if (c.isDirect) score += 12;
    else if (c.hubConnection) score += 8;
    else score += 3; // non-hub connection

    if (c.isBudgetCarrier) score -= 8;

    // Backup flight availability + quality
    if (c.backups.length >= 2) {
      score += 8;
      // Bonus for high-quality backups (direct, low cost, reasonable timing)
      const bestBackup = c.backups[0];
      if (bestBackup.isDirect) score += 3;
      if (bestBackup.cost <= 400) score += 2;
    } else if (c.backups.length === 1) {
      score += 4;
      const backup = c.backups[0];
      if (backup.isDirect) score += 2;
    } else {
      score -= 5; // No backup
    }
  }

  // ── FBO arrival timing (oncoming only) ──────────────────────────────
  // Arriving before the first leg is ideal but not required.
  // Offgoing crew holds until oncoming arrives.
  // For between_legs, score vs window_end (next departure) not aircraft arrival time.
  if (task.direction === "oncoming" && c.fboArrivalTime) {
    const deadlineRef = (task.swapPoint.position === "between_legs" && task.swapPoint.window_end)
      ? task.swapPoint.window_end
      : task.swapPoint.time;
    const bufferMin = (deadlineRef.getTime() - c.fboArrivalTime.getTime()) / 60_000;
    if (bufferMin >= FBO_ARRIVAL_BUFFER_PREFERRED) score += 10; // 90+ min early — ideal
    else if (bufferMin >= FBO_ARRIVAL_BUFFER) score += 7;       // 60+ min early — good
    else if (bufferMin >= 0) score += 3;                         // Before swap point — OK
    else if (bufferMin >= -120) score -= 2;                      // Up to 2hr late — acceptable
    else if (bufferMin >= -240) score -= 5;                      // Up to 4hr late — less ideal
    else score -= 10;                                             // 4+ hr late — poor

    // ── Early arrival bonus (get new crews in ASAP) ────────────────────
    // Nudge the optimizer toward earlier flights when costs are similar.
    const arrLocalHour = getLocalHour(c.fboArrivalTime, task.swapPoint.icao);
    if (arrLocalHour < 12) score += 15;        // Before noon — outstanding
    else if (arrLocalHour < 14) score += 8;    // Before 2pm — great
    else if (arrLocalHour < 16) score += 3;    // Before 4pm — decent
  }

  // ── Duty-on timing (avoid before 0400L) ────────────────────────────────
  // Humans routinely book 0400-0500L flights on swap day — mild penalty only
  if (c.dutyOnTime && task.homeAirports[0]) {
    const localHour = getLocalHour(c.dutyOnTime, toIcao(task.homeAirports[0]));
    if (localHour < EARLIEST_DUTY_ON_HOUR && localHour >= 0) {
      score -= 3; // Mild penalty — early flights are normal on swap day
    }
  }

  // ── PIC+SIC same flight bonus ──────────────────────────────────────────
  if (pairCandidate && c.type === "commercial" && pairCandidate.type === "commercial") {
    if (c.flightNumber === pairCandidate.flightNumber) {
      score += 10; // Same flight = shared ground transport, easier coordination
    } else if (c.depTime && pairCandidate.depTime) {
      const timeDiff = Math.abs(c.depTime.getTime() - pairCandidate.depTime.getTime()) / 60_000;
      if (timeDiff <= 120) score += 5; // Similar arrival times
    }
  }

  // ── Offgoing: prefer later flights (1700-1800L ideal for idle tails) ────
  if (task.direction === "offgoing" && c.depTime) {
    const localHour = getLocalHour(c.depTime, task.swapPoint.icao);
    const isIdle = task.swapPoint.position === "idle";
    if (isIdle) {
      // Idle tails: strongly prefer latest flight making midnight.
      // 1700-1800L = ideal, earlier = progressively worse.
      if (localHour >= 17 && localHour <= 18) score += 12;
      else if (localHour === 16 || localHour === 19) score += 8;
      else if (localHour >= 14 && localHour <= 20) score += 4;
      else if (localHour < 14) score -= 3; // too early — wastes the hold opportunity
    } else {
      if (localHour >= 17 && localHour <= 18) score += 5;
      else if (localHour >= 15 && localHour <= 20) score += 2;
    }
  }

  // ── Swap adjacent to live leg bonus ────────────────────────────────────
  if (task.swapPoint.isAdjacentLive) score += 5;

  // ── International swap penalty (last resort) ──────────────────────────
  const swapIcao = task.swapPoint.icao;
  const isInternational = swapIcao.length === 4 && !swapIcao.startsWith("K") &&
    !swapIcao.startsWith("PH") && // Hawaii (PHNL, PHKO, etc.)
    !swapIcao.startsWith("PA") && // Alaska (PANC, PAFA, etc.)
    !swapIcao.startsWith("PG") && // Guam
    !swapIcao.startsWith("TJ");   // Puerto Rico (TJSJ)
  if (isInternational) score -= 15;

  // ── TEB: strongly prefer EWR, penalize LGA/JFK ────────────────────────
  if (toIata(swapIcao) === "TEB" && c.type === "commercial") {
    const commAirport = task.direction === "oncoming" ? c.to : c.from;
    if (TEB_PENALTY_AIRPORTS.includes(commAirport)) {
      score += task.direction === "offgoing" ? TEB_OFFGOING_PENALTY : TEB_ONCOMING_PENALTY;
    }
  }

  return Math.max(0, Math.min(100, score));
}

// ═══════════════════════════════════════════════════════════════════════════════
// LAYER 5: Combination Optimizer
// ═══════════════════════════════════════════════════════════════════════════════

/** Result from optimizeTail — includes timing violation info for swap-point retry */
type OptimizeTailResult = {
  /** True if any oncoming crew arrives after aircraft departs at a before_live/between_legs swap point */
  timingViolation: boolean;
  /** How many ms the worst violator is late (positive = late). 0 if no violation. */
  violationGapMs: number;
  /** The aircraft-coverage auto-fix resolved the oncoming/offgoing overlap but NOT the departure constraint */
  coverageFixed: boolean;
  /** True if offgoing crew leaves before oncoming arrives (aircraft unattended gap) */
  unattendedGap: boolean;
  /** How many ms the aircraft is unattended (offgoing leaves before oncoming arrives). 0 if no gap. */
  unattendedGapMs: number;
};

/** Check if any oncoming crew arrives after aircraft departs at a departure-constrained swap point.
 *  This is the HARD constraint — aircraft cannot depart without crew on board. */
function checkDepartureTimingViolation(tasks: CrewTask[]): { violation: boolean; gapMs: number } {
  const oncoming = tasks.filter((t) => t.direction === "oncoming");
  let worstGapMs = 0;

  for (const task of oncoming) {
    const sp = task.swapPoint;
    // Only before_live and between_legs have a departure time constraint
    if (sp.position !== "before_live" && sp.position !== "between_legs") continue;

    const depTime = (sp.position === "between_legs" && sp.window_end)
      ? sp.window_end : sp.time;
    const depMs = new Date(depTime).getTime();
    const deadlineMs = depMs - ms(FBO_ARRIVAL_BUFFER);

    if (!task.best || task.best.type === "none") {
      // No transport at all for oncoming crew at a departure-constrained point = violation
      worstGapMs = Math.max(worstGapMs, ms(9999)); // massive gap
      continue;
    }

    const arrivalMs = task.best.fboArrivalTime?.getTime();
    if (arrivalMs && arrivalMs > deadlineMs) {
      const gap = arrivalMs - deadlineMs;
      worstGapMs = Math.max(worstGapMs, gap);
    }
  }

  return { violation: worstGapMs > 0, gapMs: worstGapMs };
}

/** Check if offgoing crew leaves the FBO before oncoming arrives — aircraft unattended.
 *  This catches after_live and idle positions where there's no departure constraint
 *  but the aircraft still can't be left unattended. */
function checkUnattendedGap(tasks: CrewTask[]): { violation: boolean; gapMs: number } {
  const oncoming = tasks.filter((t) => t.direction === "oncoming");
  const offgoing = tasks.filter((t) => t.direction === "offgoing");
  let worstGapMs = 0;

  for (const onTask of oncoming) {
    const offTask = offgoing.find((t) => t.role === onTask.role);
    if (!offTask) continue;

    // Offgoing's departure time (when they physically leave the FBO)
    const offLeaveMs = offTask.best?.fboLeaveTime?.getTime()
      ?? offTask.best?.depTime?.getTime();
    // Oncoming's arrival time (when they arrive at the FBO)
    const onArriveMs = onTask.best?.fboArrivalTime?.getTime();

    if (!offLeaveMs || !onArriveMs) continue;

    // Gap = how long the aircraft would be unattended
    // Positive means oncoming arrives AFTER offgoing leaves
    const gap = onArriveMs - offLeaveMs;
    if (gap > HANDOFF_BUFFER_MINUTES * 60_000) {
      // Oncoming arrives more than HANDOFF_BUFFER after offgoing leaves
      worstGapMs = Math.max(worstGapMs, gap);
    }
  }

  return { violation: worstGapMs > 0, gapMs: worstGapMs };
}

/** For each tail, find the best combination of transport for all crew */
function optimizeTail(
  tasks: CrewTask[],
  aliases: AirportAlias[],
  commercialFlights: Map<string, FlightOffer[]> | undefined,
  swapDate: string,
  tailLegs?: FlightLeg[],
  deadlines?: OncomingDeadline[],
): OptimizeTailResult {
  // Build candidates for each task
  for (const task of tasks) {
    task.candidates = buildCandidates(task, aliases, commercialFlights, swapDate, tailLegs);

    // Add early/late volunteer bonus to cost (company pays extra)
    // Skill-Bridge SICs do NOT get bonuses
    if ((task.earlyVolunteer || task.lateVolunteer) && !task.crewMember?.is_skillbridge) {
      const bonus = task.role === "PIC" ? EARLY_LATE_BONUS_PIC : EARLY_LATE_BONUS_SIC;
      for (const c of task.candidates) {
        if (c.type !== "none") c.cost += bonus;
      }
    }
  }

  // Separate by direction
  const oncoming = tasks.filter((t) => t.direction === "oncoming");
  const offgoing = tasks.filter((t) => t.direction === "offgoing");

  // ── Filter oncoming candidates by offgoing deadlines ───────────────
  // When offgoing-first deadlines are provided, oncoming must arrive before
  // the offgoing crew needs to leave the FBO. This eliminates timing conflicts.
  if (deadlines && deadlines.length > 0) {
    const tail = tasks[0]?.tail;
    const tailDeadlines = deadlines.filter((d) => d.tail === tail);
    for (const onTask of oncoming) {
      const dl = tailDeadlines.find((d) => d.role === onTask.role);
      if (!dl) continue;
      const deadlineMs = dl.deadline.getTime();
      const filtered = onTask.candidates.filter((c) => {
        if (c.type === "none") return true;
        if (!c.fboArrivalTime) return true; // can't evaluate — keep
        return c.fboArrivalTime.getTime() <= deadlineMs;
      });
      if (filtered.some((c) => c.type !== "none")) {
        onTask.candidates = filtered;
      }
      // If NO candidates meet the deadline: keep all — offgoing takes a later flight.
      // The humans solve oncoming first, then tell offgoing to adjust.
    }
  }

  // Score and select oncoming PIC first (to pair SIC with same flights)
  const oncomingPic = oncoming.find((t) => t.role === "PIC");
  const oncomingSic = oncoming.find((t) => t.role === "SIC");

  if (oncomingPic) {
    // Find backups for each candidate
    for (const c of oncomingPic.candidates) {
      c.backups = findBackups(c, oncomingPic.candidates, oncomingPic);
    }
    // Score each candidate
    for (const c of oncomingPic.candidates) {
      c.score = scoreCandidate(c, oncomingPic, null);
    }
    // Select best
    oncomingPic.candidates.sort((a, b) => b.score - a.score);
    oncomingPic.best = oncomingPic.candidates[0] ?? null;
  }

  if (oncomingSic) {
    for (const c of oncomingSic.candidates) {
      c.backups = findBackups(c, oncomingSic.candidates, oncomingSic);
    }
    // Score with PIC pairing consideration
    const picBest = oncomingPic?.best ?? null;
    for (const c of oncomingSic.candidates) {
      c.score = scoreCandidate(c, oncomingSic, picBest);
    }
    oncomingSic.candidates.sort((a, b) => b.score - a.score);
    oncomingSic.best = oncomingSic.candidates[0] ?? null;
  }

  // ── Shared rental: halve cost when oncoming PIC+SIC both rent to same FBO ──
  if (oncomingPic?.best?.type === "rental_car" && oncomingSic?.best?.type === "rental_car") {
    const picTo = oncomingPic.best.to;
    const sicTo = oncomingSic.best.to;
    if (picTo === sicTo) {
      oncomingPic.best.cost = Math.round(oncomingPic.best.cost / 2);
      oncomingSic.best.cost = Math.round(oncomingSic.best.cost / 2);
      oncomingPic.best.flightNumber = "RENTAL (shared)";
      oncomingSic.best.flightNumber = "RENTAL (shared)";
    }
  }

  // ── Compute oncoming PIC arrival for aircraft-unattended constraint ──
  // One PIC at the FBO = aircraft is attended. Use PIC arrival, not latest of PIC+SIC.
  // If no PIC, fall back to earliest oncoming arrival.
  const oncomingPicArrival = oncomingPic?.best?.fboArrivalTime?.getTime() ?? null;
  const oncomingArrivals = oncoming
    .filter((t) => t.best?.fboArrivalTime)
    .map((t) => t.best!.fboArrivalTime!.getTime());
  const oncomingArrivalForConstraint = oncomingPicArrival
    ?? (oncomingArrivals.length > 0 ? Math.min(...oncomingArrivals) : null);

  // ── Rental car handoff: reduce offgoing ground cost when sharing oncoming's rental ──
  const oncomingRentalBest = oncoming.find((t) => t.best?.type === "rental_car")?.best ?? null;
  if (oncomingRentalBest) {
    const swapIcao = offgoing[0]?.swapPoint?.icao;
    if (swapIcao) {
      const sharedCommAirports = new Set(findAllCommercialAirports(swapIcao, aliases));
      for (const task of offgoing) {
        for (const c of task.candidates) {
          if (c.type !== "commercial") continue;
          // Check if this candidate's commercial airport is in the shared set
          const commIcao = toIcao(c.from);
          if (!sharedCommAirports.has(commIcao) && !sharedCommAirports.has(c.from)) continue;
          // Validate timing: car available after handoff → drive to commercial → arrive before flight - RENTAL_RETURN_BUFFER
          const carAvailableAt = oncomingRentalBest.fboArrivalTime
            ? new Date(oncomingRentalBest.fboArrivalTime.getTime() + ms(HANDOFF_BUFFER_MINUTES))
            : null;
          if (!carAvailableAt || !c.depTime) continue;
          const driveToComm = estimateDriveTime(swapIcao, commIcao);
          const driveMin = driveToComm?.estimated_drive_minutes ?? 0;
          const arriveAtCommercial = new Date(carAvailableAt.getTime() + ms(driveMin));
          const mustBeAtAirport = new Date(c.depTime.getTime() - ms(RENTAL_RETURN_BUFFER));
          if (arriveAtCommercial.getTime() <= mustBeAtAirport.getTime()) {
            // Timing works — replace ground transport cost with fuel-only
            const originalGroundCost = driveMin > UBER_MAX_MINUTES
              ? 80 + Math.round((driveToComm?.estimated_drive_miles ?? 0) * 0.50)
              : Math.max(25, Math.round((driveToComm?.estimated_drive_miles ?? 0) * 2.0));
            c.cost = c.cost - originalGroundCost + RENTAL_HANDOFF_FUEL_COST;
            c.flightNumber = (c.flightNumber ?? "") + " (handoff)";
          }
        }
      }
    }
  }

  // ── Aircraft never unattended — constraint ──────────────────────────
  // Uses oncoming PIC arrival (one PIC = aircraft attended).
  // For commercial flights: use fboLeaveTime (when crew physically leaves FBO).
  // For ground transport (uber/rental/drive): departure is flexible — crew leaves
  //   after handoff, so adjust depTime to oncoming arrival instead of filtering out.
  // Graceful degradation: if all options fail, keep them with a warning.
  if (oncomingArrivalForConstraint) {
    const earliestOffgoingLeave = oncomingArrivalForConstraint + ms(HANDOFF_BUFFER_MINUTES);
    for (const task of offgoing) {
      const adjusted: TransportCandidate[] = [];
      for (const c of task.candidates) {
        if (c.type === "none") { adjusted.push(c); continue; }

        // Ground transport: departure is flexible — crew waits for handoff then leaves
        if (c.type === "uber" || c.type === "rental_car" || c.type === "drive") {
          if (c.fboLeaveTime && c.fboLeaveTime.getTime() < earliestOffgoingLeave) {
            // Adjust departure to after handoff
            const delay = earliestOffgoingLeave - c.fboLeaveTime.getTime();
            c.depTime = new Date((c.depTime?.getTime() ?? 0) + delay);
            c.arrTime = new Date((c.arrTime?.getTime() ?? 0) + delay);
            c.fboLeaveTime = new Date(earliestOffgoingLeave);
          }
          adjusted.push(c);
          continue;
        }

        // Commercial flights: check fboLeaveTime (when crew must leave FBO for airport)
        const leaveTime = c.fboLeaveTime ?? c.depTime;
        if (!leaveTime) { adjusted.push(c); continue; }
        if (leaveTime.getTime() >= earliestOffgoingLeave) {
          adjusted.push(c); // Passes constraint
        }
        // else: filtered out — crew must leave FBO before oncoming arrives
      }

      // If some candidates pass, use only those. If ALL got filtered, keep the
      // originals with a warning — better to suggest a late-departing option than
      // show NO TRANSPORT. The ops team can manually adjust.
      const viableAdjusted = adjusted.filter(c => c.type !== "none");
      if (viableAdjusted.length > 0) {
        task.candidates = adjusted;
      } else {
        // Keep original candidates — none pass timing but at least show options
        task.warnings.push(
          `Offgoing departs before oncoming PIC arrives + ${HANDOFF_BUFFER_MINUTES}min handoff — may need manual coordination`,
        );
      }
    }
  }

  // ── Score offgoing PIC first → use as pairCandidate for SIC ──────────
  const offgoingPic = offgoing.find((t) => t.role === "PIC");
  const offgoingSic = offgoing.find((t) => t.role === "SIC");

  if (offgoingPic) {
    for (const c of offgoingPic.candidates) {
      c.backups = findBackups(c, offgoingPic.candidates, offgoingPic);
    }
    for (const c of offgoingPic.candidates) {
      c.score = scoreCandidate(c, offgoingPic, null);
    }
    offgoingPic.candidates.sort((a, b) => b.score - a.score);
    offgoingPic.best = offgoingPic.candidates[0] ?? null;
  }

  if (offgoingSic) {
    for (const c of offgoingSic.candidates) {
      c.backups = findBackups(c, offgoingSic.candidates, offgoingSic);
    }
    const offPicBest = offgoingPic?.best ?? null;
    for (const c of offgoingSic.candidates) {
      c.score = scoreCandidate(c, offgoingSic, offPicBest);
    }
    offgoingSic.candidates.sort((a, b) => b.score - a.score);
    offgoingSic.best = offgoingSic.candidates[0] ?? null;
  }

  // ── Shared rental for offgoing PIC+SIC going home ──
  if (offgoingPic?.best?.type === "rental_car" && offgoingSic?.best?.type === "rental_car") {
    const picFrom = offgoingPic.best.from;
    const sicFrom = offgoingSic.best.from;
    if (picFrom === sicFrom) {
      offgoingPic.best.cost = Math.round(offgoingPic.best.cost / 2);
      offgoingSic.best.cost = Math.round(offgoingSic.best.cost / 2);
      offgoingPic.best.flightNumber = "RENTAL (shared)";
      offgoingSic.best.flightNumber = "RENTAL (shared)";
    }
  }

  // ── Rental handoff: offgoing takes oncoming's rental/personal car ────
  // If oncoming drives to FBO (rental or personal car) and offgoing also needs
  // ground transport from the same FBO, offgoing can take oncoming's car.
  // Saves one rental cost (~$80). Only applies when the existing commercial-
  // flight handoff (above) didn't already cover it.
  if (oncomingPic?.best && offgoingPic?.best) {
    const onType = oncomingPic.best.type;
    const offType = offgoingPic.best.type;
    if (
      (onType === "rental_car" || onType === "drive") &&
      (offType === "rental_car" || offType === "uber") &&
      !offgoingPic.best.flightNumber?.includes("(handoff)")
    ) {
      offgoingPic.best.cost = Math.max(0, offgoingPic.best.cost - 80);
      offgoingPic.best.flightNumber = `${offgoingPic.best.flightNumber} (handoff)`;
    }
  }
  if (oncomingSic?.best && offgoingSic?.best) {
    const onType = oncomingSic.best.type;
    const offType = offgoingSic.best.type;
    if (
      (onType === "rental_car" || onType === "drive") &&
      (offType === "rental_car" || offType === "uber") &&
      !offgoingSic.best.flightNumber?.includes("(handoff)")
    ) {
      offgoingSic.best.cost = Math.max(0, offgoingSic.best.cost - 80);
      offgoingSic.best.flightNumber = `${offgoingSic.best.flightNumber} (handoff)`;
    }
  }

  // ── Rental handoff for NO TRANSPORT offgoing: if oncoming has rental and
  // offgoing has no viable transport BUT their home airports are within 30mi,
  // auto-assign offgoing to take oncoming's rental car (fuel cost only).
  for (const [onTask, offTask] of [[oncomingPic, offgoingPic], [oncomingSic, offgoingSic], [oncomingPic, offgoingSic], [oncomingSic, offgoingPic]] as [CrewTask | undefined, CrewTask | undefined][]) {
    if (!onTask?.best || !offTask?.best) continue;
    if (onTask.best.type !== "rental_car" && onTask.best.type !== "drive") continue;
    if (offTask.best.type !== "none") continue; // only for NO TRANSPORT

    // Check home airports within 30mi of each other
    let closeEnough = false;
    for (const onHome of onTask.homeAirports) {
      for (const offHome of offTask.homeAirports) {
        if (onHome.toUpperCase() === offHome.toUpperCase()) { closeEnough = true; break; }
        const drive = estimateDriveTime(toIcao(onHome), toIcao(offHome));
        if (drive && drive.straight_line_miles <= 30) { closeEnough = true; break; }
      }
      if (closeEnough) break;
    }

    if (closeEnough) {
      // Assign rental handoff: offgoing takes oncoming's car, fuel-only cost
      offTask.best = {
        type: "rental_car",
        flightNumber: "RENTAL (handoff)",
        depTime: null,
        arrTime: null,
        from: offTask.best.from || toIata(offTask.swapPoint.icao),
        to: offTask.homeAirports[0] ? toIata(offTask.homeAirports[0]) : "",
        cost: RENTAL_HANDOFF_FUEL_COST,
        durationMin: onTask.best.durationMin, // same drive as oncoming
        isDirect: true,
        isBudgetCarrier: false,
        hubConnection: false,
        connectionCount: 0,
        offer: null,
        drive: onTask.best.drive,
        fboArrivalTime: null,
        fboLeaveTime: null,
        dutyOnTime: null,
        score: 65,
        backups: [],
      };
    }
  }

  // Handle any remaining offgoing tasks (edge case: extra roles)
  for (const task of offgoing) {
    if (task === offgoingPic || task === offgoingSic) continue;
    for (const c of task.candidates) {
      c.backups = findBackups(c, task.candidates, task);
      c.score = scoreCandidate(c, task, null);
    }
    task.candidates.sort((a, b) => b.score - a.score);
    task.best = task.candidates[0] ?? null;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // AIRCRAFT NEVER EMPTY — hard constraint with automatic resolution
  // ══════════════════════════════════════════════════════════════════════════
  // For each role (PIC/SIC), verify oncoming arrives BEFORE offgoing departs.
  // If not, try two alternatives and pick the cheaper one. If neither works,
  // mark the tail unsolved.
  const HANDOFF_BUFFER_MS = ms(HANDOFF_BUFFER_MINUTES);

  for (const [onTask, offTask] of [
    [oncomingPic, offgoingPic],
    [oncomingSic, offgoingSic],
  ] as [CrewTask | undefined, CrewTask | undefined][]) {
    if (!onTask?.best || !offTask?.best) continue;
    if (onTask.best.type === "none" || offTask.best.type === "none") continue;

    const oncomingArrival = onTask.best.fboArrivalTime;
    const offgoingDeparture = offTask.best.fboLeaveTime ?? offTask.best.depTime;

    if (!oncomingArrival || !offgoingDeparture) continue;

    // Check: does oncoming arrive at least HANDOFF_BUFFER before offgoing leaves?
    if (oncomingArrival.getTime() + HANDOFF_BUFFER_MS <= offgoingDeparture.getTime()) {
      continue; // Timing is fine — aircraft is never empty
    }

    // CONFLICT: aircraft would be empty. Try to resolve automatically.
    console.log(
      `[AircraftCoverage] ${onTask.tail} ${onTask.role}: CONFLICT — ` +
      `oncoming arrives ${oncomingArrival.toISOString().slice(11, 16)}Z, ` +
      `offgoing departs ${offgoingDeparture.toISOString().slice(11, 16)}Z ` +
      `(need ${HANDOFF_BUFFER_MINUTES}min buffer)`
    );

    // Option A: Keep oncoming, find later offgoing transport
    // Offgoing holds at FBO until oncoming arrives, then takes a later flight/transport
    const requiredOffgoingLeaveTime = oncomingArrival.getTime() + HANDOFF_BUFFER_MS;
    const laterOffgoing = offTask.candidates
      .filter((c) => {
        if (c.type === "none") return false;
        const leave = (c.fboLeaveTime ?? c.depTime)?.getTime();
        return leave != null && leave >= requiredOffgoingLeaveTime;
      })
      .sort((a, b) => a.cost - b.cost); // cheapest viable option

    // Option B: Keep offgoing, find earlier oncoming transport
    // Oncoming arrives earlier so they're at FBO before offgoing needs to leave
    const requiredOncomingArrival = offgoingDeparture.getTime() - HANDOFF_BUFFER_MS;
    const earlierOncoming = onTask.candidates
      .filter((c) => {
        if (c.type === "none") return false;
        const arr = c.fboArrivalTime?.getTime();
        return arr != null && arr <= requiredOncomingArrival;
      })
      .sort((a, b) => b.score - a.score); // best-scored viable option

    const optionA = laterOffgoing[0] ?? null;
    const optionB = earlierOncoming[0] ?? null;

    if (optionA && optionB) {
      // Compare costs: use whichever is cheaper overall
      const costA = optionA.cost + (onTask.best.cost ?? 0);
      const costB = (offTask.best.cost ?? 0) + optionB.cost;
      if (costA <= costB) {
        console.log(`[AircraftCoverage] ${onTask.tail} ${onTask.role}: Option A — later offgoing ${optionA.flightNumber ?? optionA.type} (cost $${Math.round(optionA.cost)})`);
        offTask.best = optionA;
      } else {
        console.log(`[AircraftCoverage] ${onTask.tail} ${onTask.role}: Option B — earlier oncoming ${optionB.flightNumber ?? optionB.type} (cost $${Math.round(optionB.cost)})`);
        onTask.best = optionB;
      }
    } else if (optionA) {
      console.log(`[AircraftCoverage] ${onTask.tail} ${onTask.role}: Option A — later offgoing ${optionA.flightNumber ?? optionA.type} (cost $${Math.round(optionA.cost)})`);
      offTask.best = optionA;
    } else if (optionB) {
      console.log(`[AircraftCoverage] ${onTask.tail} ${onTask.role}: Option B — earlier oncoming ${optionB.flightNumber ?? optionB.type} (cost $${Math.round(optionB.cost)})`);
      onTask.best = optionB;
    } else {
      // NEITHER option works — mark as unsolved
      const warningMsg = `Cannot ensure aircraft coverage — oncoming ${onTask.role} arrives ${oncomingArrival.toISOString().slice(11, 16)}Z but offgoing must leave ${offgoingDeparture.toISOString().slice(11, 16)}Z (need ${HANDOFF_BUFFER_MINUTES}min handoff)`;
      onTask.warnings.push(warningMsg);
      offTask.warnings.push(warningMsg);
      console.log(`[AircraftCoverage] ${onTask.tail} ${onTask.role}: UNSOLVED — ${warningMsg}`);
    }
  }

  // ── Check departure timing violation (oncoming arrives after aircraft departs) ──
  const depCheck = checkDepartureTimingViolation(tasks);

  // ── Check unattended gap (offgoing leaves before oncoming arrives) ──
  // This catches after_live/idle positions where there's no departure constraint
  // but the aircraft still can't be left unattended.
  const gapCheck = checkUnattendedGap(tasks);

  // Auto-fix unattended gaps: try later offgoing or earlier oncoming
  if (gapCheck.violation) {
    for (const [onTask, offTask] of [
      [oncomingPic, offgoingPic],
      [oncomingSic, offgoingSic],
    ] as [CrewTask | undefined, CrewTask | undefined][]) {
      if (!onTask?.best || !offTask?.best) continue;
      if (onTask.best.type === "none" || offTask.best.type === "none") continue;

      const onArriveMs = onTask.best.fboArrivalTime?.getTime();
      const offLeaveMs = offTask.best.fboLeaveTime?.getTime()
        ?? offTask.best.depTime?.getTime();
      if (!onArriveMs || !offLeaveMs) continue;

      const gap = onArriveMs - offLeaveMs;
      if (gap <= HANDOFF_BUFFER_MINUTES * 60_000) continue; // no gap for this pair

      console.log(
        `[UnattendedGap] ${onTask.tail} ${onTask.role}: gap=${Math.round(gap / 60_000)}min — ` +
        `oncoming arrives ${new Date(onArriveMs).toISOString().slice(11, 16)}Z, ` +
        `offgoing leaves ${new Date(offLeaveMs).toISOString().slice(11, 16)}Z`
      );

      // Option A: find later offgoing transport (hold at FBO until oncoming arrives)
      const requiredOffLeave = onArriveMs + ms(HANDOFF_BUFFER_MINUTES);
      const laterOffgoing = offTask.candidates
        .filter((c) => {
          if (c.type === "none") return false;
          const leave = (c.fboLeaveTime ?? c.depTime)?.getTime();
          return leave != null && leave >= requiredOffLeave;
        })
        .sort((a, b) => a.cost - b.cost);

      // Option B: find earlier oncoming transport
      const requiredOnArrive = offLeaveMs - ms(HANDOFF_BUFFER_MINUTES);
      const earlierOncoming = onTask.candidates
        .filter((c) => {
          if (c.type === "none") return false;
          const arr = c.fboArrivalTime?.getTime();
          return arr != null && arr <= requiredOnArrive;
        })
        .sort((a, b) => b.score - a.score);

      const optionA = laterOffgoing[0] ?? null;
      const optionB = earlierOncoming[0] ?? null;

      if (optionA && optionB) {
        const costA = optionA.cost + (onTask.best.cost ?? 0);
        const costB = (offTask.best.cost ?? 0) + optionB.cost;
        if (costA <= costB) {
          console.log(`[UnattendedGap] ${onTask.tail} ${onTask.role}: Option A — later offgoing ${optionA.flightNumber ?? optionA.type}`);
          offTask.best = optionA;
        } else {
          console.log(`[UnattendedGap] ${onTask.tail} ${onTask.role}: Option B — earlier oncoming ${optionB.flightNumber ?? optionB.type}`);
          onTask.best = optionB;
        }
      } else if (optionA) {
        console.log(`[UnattendedGap] ${onTask.tail} ${onTask.role}: Option A — later offgoing ${optionA.flightNumber ?? optionA.type}`);
        offTask.best = optionA;
      } else if (optionB) {
        console.log(`[UnattendedGap] ${onTask.tail} ${onTask.role}: Option B — earlier oncoming ${optionB.flightNumber ?? optionB.type}`);
        onTask.best = optionB;
      } else {
        const warningMsg = `Aircraft unattended for ${Math.round(gap / 60_000)}min — offgoing leaves before oncoming arrives (need ${HANDOFF_BUFFER_MINUTES}min handoff)`;
        onTask.warnings.push(warningMsg);
        offTask.warnings.push(warningMsg);
        console.log(`[UnattendedGap] ${onTask.tail} ${onTask.role}: UNSOLVED — ${warningMsg}`);
      }
    }

    // Re-check after auto-fix attempts
    const gapRecheck = checkUnattendedGap(tasks);
    return {
      timingViolation: depCheck.violation,
      violationGapMs: depCheck.gapMs,
      coverageFixed: true,
      unattendedGap: gapRecheck.violation,
      unattendedGapMs: gapRecheck.gapMs,
    };
  }

  return {
    timingViolation: depCheck.violation,
    violationGapMs: depCheck.gapMs,
    coverageFixed: true, // The auto-fix above ran; caller checks depCheck separately
    unattendedGap: false,
    unattendedGapMs: 0,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// LAYER 6: Swap Point Extraction
// ═══════════════════════════════════════════════════════════════════════════════

/** Extract swap points for a tail on a given date. Reusable by both
 *  buildSwapPlan and the feasibility matrix builder. */
function extractSwapPoints(
  tail: string,
  byTail: Map<string, FlightLeg[]>,
  swapDate: string,
): { swapPoints: SwapPoint[]; overnightAirport: string | null; aircraftType: string } {
  const legs = byTail.get(tail) ?? [];

  // ── Date classification ──────────────────────────────────────────────
  // JetInsight schedule JSON provides departure times in LOCAL airport time
  // without a timezone indicator (e.g. "2026-04-09T10:00:00"). The schedule-sync
  // stores these directly into a Postgres timestamptz column, which assumes UTC.
  // This means the date portion of the stored ISO string (slice 0..10) preserves
  // the INTENDED local date from JetInsight, even though the full timestamp is
  // technically wrong by the airport's UTC offset.
  //
  // Using new Date(isoStr).toLocaleDateString(tz) to "correct" back to local
  // time double-converts: it treats the already-local digits as UTC, then shifts
  // again, pushing early-morning flights (midnight–4am local) to the previous day.
  // Example: PBI→TEB departing April 9 01:00 local is stored as 01:00 UTC.
  //   → toLocaleDateString("America/New_York") = April 8 21:00 ET → "2026-04-08"
  //   → WRONG — the flight is April 9, not April 8.
  //
  // Fix: use the stored date portion directly. This matches JetInsight's intended
  // schedule date and avoids the double-conversion trap.
  const storedDate = (isoStr: string): string => isoStr.slice(0, 10);

  const wedLegs = legs.filter((f) => storedDate(f.scheduled_departure) === swapDate);
  const liveWedLegs = wedLegs.filter((f) => isLiveType(f.flight_type));

  const priorLegs = legs.filter(
    (f) => storedDate(f.scheduled_departure) < swapDate,
  );
  const lastPrior = priorLegs[priorLegs.length - 1];
  const overnightAirport = lastPrior?.arrival_icao ?? wedLegs[0]?.departure_icao ?? null;

  const swapPoints: SwapPoint[] = [];

  if (liveWedLegs.length > 0) {
    // Before first live leg
    const firstLive = liveWedLegs[0];
    swapPoints.push({
      icao: firstLive.departure_icao,
      time: new Date(firstLive.scheduled_departure),
      position: "before_live",
      isAdjacentLive: true,
    });
    // Between live legs — SIC can swap at intermediate airports
    // (PIC covers SIC seat for legs before the SIC arrives)
    for (let i = 0; i < liveWedLegs.length - 1; i++) {
      const leg = liveWedLegs[i];
      const nextLeg = liveWedLegs[i + 1];
      if (leg.arrival_icao && leg.scheduled_arrival) {
        swapPoints.push({
          icao: leg.arrival_icao,
          time: new Date(leg.scheduled_arrival),
          position: "between_legs",
          isAdjacentLive: true,
          // window_end = next departure = actual crew deadline
          window_end: nextLeg?.scheduled_departure ? new Date(nextLeg.scheduled_departure) : undefined,
        });
      }
    }
    // After last live leg
    const lastLive = liveWedLegs[liveWedLegs.length - 1];
    if (lastLive.arrival_icao && lastLive.scheduled_arrival) {
      swapPoints.push({
        icao: lastLive.arrival_icao,
        time: new Date(lastLive.scheduled_arrival),
        position: "after_live",
        isAdjacentLive: true,
      });
    }
  } else if (wedLegs.length > 0) {
    swapPoints.push({
      icao: wedLegs[0].departure_icao,
      time: new Date(wedLegs[0].scheduled_departure),
      position: "between_legs",
      isAdjacentLive: false,
    });
    // Include intermediate airports for non-live legs too
    for (let i = 0; i < wedLegs.length - 1; i++) {
      const leg = wedLegs[i];
      if (leg.arrival_icao && leg.scheduled_arrival) {
        swapPoints.push({
          icao: leg.arrival_icao,
          time: new Date(leg.scheduled_arrival),
          position: "between_legs",
          isAdjacentLive: false,
        });
      }
    }
    const lastWed = wedLegs[wedLegs.length - 1];
    if (lastWed.arrival_icao && lastWed.scheduled_arrival) {
      swapPoints.push({
        icao: lastWed.arrival_icao,
        time: new Date(lastWed.scheduled_arrival),
        position: "between_legs",
        isAdjacentLive: false,
      });
    }
  } else if (overnightAirport) {
    // For idle tails, split into two swap points:
    // - Oncoming target: 0800L (get new crew there early for coverage)
    // - Offgoing target: 1700L (hold old crew until late afternoon)
    const tz = getAirportTimezone(overnightAirport) ?? "America/New_York";

    function localToUtc(hour: number): Date {
      const localRef = new Date(`${swapDate}T${String(hour).padStart(2, "0")}:00:00`);
      const utcS = localRef.toLocaleString("en-US", { timeZone: "UTC" });
      const localS = localRef.toLocaleString("en-US", { timeZone: tz });
      const off = new Date(utcS).getTime() - new Date(localS).getTime();
      return new Date(localRef.getTime() + off);
    }

    // Oncoming arrives early (0800L)
    swapPoints.push({
      icao: overnightAirport,
      time: localToUtc(8),
      position: "idle",
      isAdjacentLive: false,
    });
    // Offgoing departs late (1700L) — hold the aircraft
    swapPoints.push({
      icao: overnightAirport,
      time: localToUtc(17),
      position: "idle",
      isAdjacentLive: false,
    });
  }

  return { swapPoints, overnightAirport, aircraftType: "unknown" };
}

// ═══════════════════════════════════════════════════════════════════════════════
// LAYER 7: Public API / Orchestrator
// ═══════════════════════════════════════════════════════════════════════════════

export function buildSwapPlan(params: {
  flights: FlightLeg[];
  crewRoster: CrewMember[];
  aliases: AirportAlias[];
  swapDate: string;
  commercialFlights?: Map<string, FlightOffer[]>;
  swapAssignments?: Record<string, SwapAssignment>;
  oncomingPool?: OncomingPool;
  stayingCrew?: Array<{ name: string; tail: string; role: "PIC" | "SIC" }>;
  strategy?: "offgoing_first" | "oncoming_first";
}): SwapPlanResult {
  const { flights, crewRoster, aliases, swapDate, commercialFlights, swapAssignments, oncomingPool, stayingCrew, strategy = "oncoming_first" } = params;
  _warnedFlightKeys.clear(); // Reset per-run to avoid stale warnings
  const globalWarnings: string[] = [];
  const allTasks: CrewTask[] = [];

  // When offgoing-first: compute deadlines (latest oncoming arrival per tail)
  // so optimizeTail can reject oncoming candidates that arrive too late.
  let offgoingDeadlines: OncomingDeadline[] | undefined;
  if (strategy === "offgoing_first" && swapAssignments && Object.keys(swapAssignments).length > 0) {
    const offResult = solveOffgoingFirst({ flights, crewRoster, aliases, swapDate, commercialFlights, swapAssignments });
    offgoingDeadlines = offResult.deadlines;
  }

  if (!swapAssignments || Object.keys(swapAssignments).length === 0) {
    globalWarnings.push("No swap assignments found. Upload the swap Excel document first.");
    return { swap_date: swapDate, rows: [], warnings: globalWarnings, total_cost: 0, plan_score: 0, solved_count: 0, unsolved_count: 0 };
  }

  // ── Group flights by tail ──────────────────────────────────────────────
  const byTail = new Map<string, FlightLeg[]>();
  for (const f of flights) {
    if (!f.tail_number) continue;
    if (!byTail.has(f.tail_number)) byTail.set(f.tail_number, []);
    byTail.get(f.tail_number)!.push(f);
  }
  for (const [, legs] of byTail) {
    legs.sort((a, b) => new Date(a.scheduled_departure).getTime() - new Date(b.scheduled_departure).getTime());
  }

  // ── Sort tails by difficulty: hardest swap locations first ────────────
  // Difficulty = how hard is it to get crew to/from this location commercially.
  // Primary: drive time to nearest commercial airport (longer = harder).
  // Secondary: whether the FBO itself has commercial service (much easier).
  // Tertiary: number of reachable commercial airports (more options = easier).
  // Uses the EASIEST swap point per tail — for EGE→VNY, VNY drives the score.
  const tailEntries = Object.entries(swapAssignments);
  const tailDifficulty = new Map<string, number>();
  for (const [tail] of tailEntries) {
    const { swapPoints } = extractSwapPoints(tail, byTail, swapDate);
    let easiestScore = Infinity;
    for (const sp of swapPoints) {
      const spIcao = sp.icao;
      const commAirports = findAllCommercialAirports(spIcao, aliases);

      // Does the FBO itself have commercial service?
      const selfCommercial = isCommercialAirport(spIcao);

      // Shortest drive time to any commercial airport
      let minDriveMin = Infinity;
      for (const commIcao of commAirports) {
        if (commIcao.toUpperCase() === spIcao.toUpperCase()) {
          minDriveMin = 0; // IS a commercial airport
          break;
        }
        const drive = estimateDriveTime(spIcao, commIcao);
        if (drive) minDriveMin = Math.min(minDriveMin, drive.estimated_drive_minutes);
      }
      if (minDriveMin === Infinity) minDriveMin = 999;

      // Difficulty score: higher = harder. Drive time dominates.
      // Self-commercial gets a 30min bonus, each extra option subtracts 2.
      const score = minDriveMin - (selfCommercial ? 30 : 0) - (commAirports.length * 2);
      easiestScore = Math.min(easiestScore, score);
    }
    tailDifficulty.set(tail, easiestScore);
  }
  // Higher difficulty = processed first
  tailEntries.sort((a, b) => (tailDifficulty.get(b[0]) ?? 0) - (tailDifficulty.get(a[0]) ?? 0));

  // Debug: collect swap point scores per tail
  const swapPointDebug: Record<string, Array<{ icao: string; iata: string; position: string; ease: number; drive_min: number; is_commercial: boolean; is_international: boolean; timing_penalty: number; proximity_bonus: number; after_live_bonus: number; comm_airports: number; selected: boolean }>> = {};

  // ── Process each tail (hardest first) ───────────────────────────────
  for (const [tail, assignment] of tailEntries) {
    // Determine aircraft type
    const anyName = assignment.oncoming_pic ?? assignment.offgoing_pic ?? assignment.oncoming_sic ?? assignment.offgoing_sic;
    const anyCrew = anyName ? (findCrewByName(crewRoster, anyName, "PIC") ?? findCrewByName(crewRoster, anyName, "SIC")) : null;
    const aircraftType = anyCrew?.aircraft_types[0] ?? "unknown";

    // Use extracted swap-point builder
    const { swapPoints } = extractSwapPoints(tail, byTail, swapDate);

    if (swapPoints.length === 0) {
      globalWarnings.push(`${tail}: No swap points found — no flights and no known position`);
      continue;
    }

    // Swap point logic:
    // - PIC evaluates ALL swap points — prefers easier commercial airports.
    //   For EGE→VNY: VNY (near BUR/LAX) >> EGE (remote, only DEN).
    //   On swap day, can fly with 2 PICs so mid-day handoff is fine.
    // - SIC can swap at ANY swap point — PIC covers SIC seat for early legs.
    // - Offgoing leaves from the SAME swap point as their oncoming counterpart.

    // Pick PIC swap point:
    // - With flights: best commercial accessibility (EGE→VNY: VNY near BUR/LAX wins)
    // - Drive-only: use first swap point (default), let buildCandidates try all
    let picSwapPoint = swapPoints[0]; // default
    const swapPointScores: { icao: string; iata: string; position: string; ease: number; drive_min: number; is_commercial: boolean; is_international: boolean; timing_penalty: number; proximity_bonus: number; after_live_bonus: number; comm_airports: number; selected: boolean }[] = [];

    // HARD RULE: prefer domestic after_live ONLY when alternative is international
    const hasIntlOption2 = swapPoints.some(sp => {
      const upper = sp.icao.toUpperCase();
      return !upper.startsWith("K") && !upper.startsWith("CY");
    });
    if (hasIntlOption2) {
      const domesticAfterLive2 = swapPoints.find(sp => {
        if (sp.position !== "after_live") return false;
        const upper = sp.icao.toUpperCase();
        return upper.startsWith("K") || upper.startsWith("CY");
      });
      if (domesticAfterLive2) picSwapPoint = domesticAfterLive2;
    }

    // If assignment phase already proved a swap point, use it directly — avoids
    // the transport phase independently picking a different (wrong) swap point.
    const assignedPicSwapIcao = assignment.oncoming_pic_swap_icao;
    if (assignedPicSwapIcao) {
      const matched = swapPoints.find((sp) => sp.icao.toUpperCase() === assignedPicSwapIcao.toUpperCase());
      if (matched) picSwapPoint = matched;
    } else if (swapPoints.length > 1 && commercialFlights) {
      let bestEase = -Infinity;
      for (const sp of swapPoints) {
        const commAirports = findAllCommercialAirports(sp.icao, aliases);
        // Use isCommercialAirport() — matches buildFeasibilityMatrix's check so both
        // phases pick the SAME swap point. The old alias-based self-reference check
        // missed airports like KIAD that ARE commercial but have no self-alias entry.
        const selfCommercial = isCommercialAirport(sp.icao);
        let minDrive = Infinity;
        for (const c of commAirports) {
          if (c.toUpperCase() === sp.icao.toUpperCase()) { minDrive = 0; break; }
          const d = estimateDriveTime(sp.icao, c);
          if (d) minDrive = Math.min(minDrive, d.estimated_drive_minutes);
        }
        if (minDrive === Infinity) minDrive = 999;
        // Heavy penalty for international swap points (outside continental US + Canada).
        // Crew stranded in Caribbean/Mexico is much worse than driving 30min to EWR.
        const isInternational = commAirports.every((c) => {
          const upper = c.toUpperCase();
          if (TERRITORY_AIRPORTS.has(upper)) return true;
          return !upper.startsWith("K") && !upper.startsWith("CY") && !upper.startsWith("Y");
        });

        // Penalty for late arrival at after_live/between_legs swap points.
        // If an aircraft flies KTEB→KPSP at 6pm, the crew arrives PSP at ~11pm —
        // too late for any commercial flights home. Penalize by how late the swap is.
        // "before_live" and "idle" have no timing penalty (crew leaves whenever they want).
        // For between_legs, use window_end (next departure) — the actual crew deadline.
        let timingPenalty = 0;
        if (sp.position === "after_live" || sp.position === "between_legs") {
          const tz = getAirportTimezone(sp.icao) ?? "America/New_York";
          const refTime = (sp.position === "between_legs" && sp.window_end) ? sp.window_end : sp.time;
          const localHour = parseFloat(
            new Date(refTime).toLocaleString("en-US", { hour: "numeric", hour12: false, timeZone: tz })
          );
          // Penalty ramps up after noon local: 0 at noon, 50 at 6pm, 150 at 10pm+
          const hoursAfterNoon = Math.max(0, localHour - 12);
          timingPenalty = Math.min(150, hoursAfterNoon * 12);
        }

        // Crew-proximity bonus: how close is the oncoming pool to this swap point?
        // Prevents picking remote airports (e.g. SJU) when all crew live on the mainland.
        let totalProximity = 0;
        let proximityCount = 0;
        const picPool = oncomingPool?.pic ?? [];
        for (const p of picPool) {
          for (const home of p.home_airports) {
            for (const comm of commAirports) {
              const d = estimateDriveTime(toIcao(home), comm);
              if (d) {
                totalProximity += Math.min(d.straight_line_miles, 2000);
                proximityCount++;
                break; // closest commercial airport is enough
              }
            }
          }
        }
        const avgMiles = proximityCount > 0 ? totalProximity / proximityCount : 1000;
        // Bonus: 0mi avg = +120, 500mi avg = +60, 1000mi+ = 0
        const proximityBonus = Math.max(0, 120 - (avgMiles / 1000) * 120);

        // ── before_live / between_legs: penalize based on how tight the timing is.
        // The aircraft departs this swap point at a specific time — oncoming crew
        // must arrive FBO_ARRIVAL_BUFFER (60min) before. If most oncoming crew
        // can't realistically make it, this swap point should lose to after_live.
        let hardReject = false;
        if (sp.position === "before_live" || sp.position === "between_legs") {
          const depTime = (sp.position === "between_legs" && sp.window_end) ? sp.window_end : sp.time;
          const depMs = new Date(depTime).getTime();
          const spTz = getAirportTimezone(sp.icao) ?? "America/New_York";
          const depLocalHour = parseFloat(
            new Date(depTime).toLocaleString("en-US", { hour: "numeric", hour12: false, timeZone: spTz })
          );

          if (depLocalHour < GROUND_ONLY_CUTOFF_HOUR) {
            // Before 6 AM — only ground transport viable
            timingPenalty += 100;
          } else if (depLocalHour < 10) {
            timingPenalty += 50;
          }

          // Check how many oncoming pool members can actually make this departure.
          // If fewer than half the pool can arrive in time, add heavy penalty.
          // This catches cases like SFO 10am departure where DEN/GEG crew can't make it
          // even though the local hour looks reasonable.
          const deadlineMs = depMs - ms(FBO_ARRIVAL_BUFFER);
          let canMakeIt = 0;
          let totalChecked = 0;
          const poolToCheck = picPool.length > 0 ? picPool : (oncomingPool?.sic ?? []);
          for (const p of poolToCheck) {
            totalChecked++;
            let reachable = false;
            for (const home of p.home_airports) {
              // Check ground transport
              const drive = estimateDriveTime(toIcao(home), sp.icao);
              if (drive && drive.estimated_drive_minutes <= UBER_MAX_MINUTES) {
                reachable = true; break;
              }
              // Check if any commercial flight arrives before deadline
              if (commercialFlights) {
                const homeIata = toIata(home);
                for (const commDest of commAirports) {
                  const destIata = toIata(commDest);
                  const flights = lookupFlights(commercialFlights, homeIata, destIata, swapDate);
                  for (const offer of flights) {
                    const segs = offer.itineraries?.[0]?.segments ?? [];
                    const lastSeg = segs[segs.length - 1];
                    if (lastSeg) {
                      const arrMs = new Date(lastSeg.arrival.at).getTime();
                      // Arrival + deplane (30min) + drive to FBO must be before deadline
                      const fboArrMs = arrMs + 30 * 60_000 + (estimateDriveTime(toIcao(destIata), sp.icao)?.estimated_drive_minutes ?? 0) * 60_000;
                      if (fboArrMs <= deadlineMs) { reachable = true; break; }
                    }
                  }
                  if (reachable) break;
                }
              }
              if (reachable) break;
            }
            if (reachable) canMakeIt++;
          }
          // If fewer than half the oncoming pool can make this departure, heavy penalty
          if (totalChecked > 0 && canMakeIt < totalChecked * 0.5) {
            const unreachablePenalty = canMakeIt === 0 ? 300 : 150;
            timingPenalty += unreachablePenalty;
          }
        }

        // Bonus for domestic "after_live" — this is where the aircraft ENDS UP.
        // Strongly prefer swapping at the final destination over intermediate stops,
        // especially when the intermediate is international/remote.
        const afterLiveBonus = sp.position === "after_live" ? 80 : 0;

        // Ease score: lower drive = easier, self-commercial = bonus, more options = bonus
        const ease = hardReject ? -9999 : (
          -minDrive + (selfCommercial ? 30 : 0) + (commAirports.length * 2)
          - (isInternational ? 500 : 0) - timingPenalty + proximityBonus + afterLiveBonus
        );
        swapPointScores.push({
          icao: sp.icao, iata: toIata(sp.icao), position: sp.position,
          ease: Math.round(ease), drive_min: minDrive === Infinity ? 999 : minDrive,
          is_commercial: selfCommercial, is_international: isInternational,
          timing_penalty: Math.round(timingPenalty), proximity_bonus: Math.round(proximityBonus),
          after_live_bonus: afterLiveBonus, comm_airports: commAirports.length, selected: false,
        });
        // Debug log for tails with international swap points
        if (isInternational || sp.icao === "TQPF" || tail.includes("555")) {
          console.log(`[SwapPointDebug] ${tail} ${toIata(sp.icao)} (${sp.position}): ease=${Math.round(ease)} drive=${minDrive} intl=${isInternational} comm=${commAirports.length} timing=${Math.round(timingPenalty)} prox=${Math.round(proximityBonus)} afterLive=${afterLiveBonus}`);
        }
        // ── Bug fix: penalize swap points where offgoing crew can't get home ──
        // Check if offgoing PIC or SIC have ANY viable transport home from this swap point.
        // If not, heavily penalize so swap points with offgoing viability win.
        const noOffgoingTransportPenalty = -400;
        let offgoingPenalty = 0;
        const offgoingNames = [assignment.offgoing_pic, assignment.offgoing_sic].filter(Boolean) as string[];
        if (offgoingNames.length > 0) {
          let anyOffgoingViable = false;
          for (const offName of offgoingNames) {
            const offCrew = findCrewByName(crewRoster, offName, "PIC") ?? findCrewByName(crewRoster, offName, "SIC");
            const offHomes = offCrew?.home_airports ?? [];
            if (offHomes.length === 0) { anyOffgoingViable = true; break; } // can't evaluate — don't penalize

            let crewViable = false;
            for (const home of offHomes) {
              // Check ground transport: swap point → home within rental max
              const drive = estimateDriveTime(sp.icao, toIcao(home));
              if (drive && drive.estimated_drive_minutes <= RENTAL_MAX_MINUTES) {
                crewViable = true; break;
              }
              // Check commercial flights: swap point commercial airports → home commercial airports
              if (commercialFlights) {
                const homeIata = toIata(home);
                const homeIcao = toIcao(home);
                const homeSearchIatas = [homeIata];
                if (!isCommercialAirport(homeIcao)) {
                  const nearbyComm = findAllCommercialAirports(homeIcao, aliases);
                  for (const nc of nearbyComm) homeSearchIatas.push(toIata(nc));
                }
                for (const commOrig of commAirports) {
                  const origIata = toIata(commOrig);
                  for (const destIata of homeSearchIatas) {
                    // Check swap day and day after (offgoing can fly next morning)
                    if (lookupFlights(commercialFlights, origIata, destIata, swapDate).length > 0) {
                      crewViable = true; break;
                    }
                    const dayAfter = new Date(swapDate);
                    dayAfter.setDate(dayAfter.getDate() + 1);
                    if (lookupFlights(commercialFlights, origIata, destIata, dayAfter.toISOString().slice(0, 10)).length > 0) {
                      crewViable = true; break;
                    }
                  }
                  if (crewViable) break;
                }
              }
              if (crewViable) break;
            }
            if (crewViable) { anyOffgoingViable = true; break; }
          }
          if (!anyOffgoingViable) {
            offgoingPenalty = noOffgoingTransportPenalty;
            console.log(`[SwapPointDebug] ${tail} ${toIata(sp.icao)}: offgoing has NO viable transport home — penalty ${noOffgoingTransportPenalty}`);
          }
        }

        const easeWithOffgoing = ease + offgoingPenalty;
        if (easeWithOffgoing > bestEase) {
          bestEase = easeWithOffgoing;
          picSwapPoint = sp;
        }
      }
      // Mark the selected swap point
      const selectedScore = swapPointScores.find(s => s.icao === picSwapPoint.icao);
      if (selectedScore) selectedScore.selected = true;

      // If ALL swap points were hard-rejected (bestEase <= -9999), fall back to
      // the last swap point (typically where the aircraft ends up — after_live/idle).
      // This is better than leaving the PIC unassigned.
      if (bestEase <= -9999 && swapPoints.length > 0) {
        // Prefer after_live or idle points (where aircraft ends up)
        const fallback = swapPoints.find((sp) => sp.position === "after_live" || sp.position === "idle")
          ?? swapPoints[swapPoints.length - 1];
        picSwapPoint = fallback;
        globalWarnings.push(`${tail}: all swap points had timing conflicts — falling back to ${toIata(fallback.icao)}`);
      }
    }

    // Store swap point scores for debug
    if (swapPointScores.length > 0) swapPointDebug[tail] = swapPointScores;

    // Validate: never 2 SICs on the same tail (2 PICs is OK on swap day)
    const hasOncomingPic = !!assignment.oncoming_pic;
    const hasOncomingSic = !!assignment.oncoming_sic;
    if (!hasOncomingPic && hasOncomingSic) {
      // SIC-only swap is fine — PIC stays on the aircraft
    }

    // ── Helper: resolve crew member from name ────────────────────────────
    function resolveCrewMember(name: string, role: "PIC" | "SIC"): { crewMember: CrewMember | null; homeAirports: string[]; warnings: string[] } {
      const warnings: string[] = [];
      let crewMember = findCrewByName(crewRoster, name, role);
      if (!crewMember) {
        const oppositeRole = role === "PIC" ? "SIC" : "PIC";
        crewMember = findCrewByName(crewRoster, name, oppositeRole);
        if (crewMember) {
          warnings.push(`"${name}" found in roster as ${oppositeRole} instead of ${role}`);
        } else {
          const norm = name.trim().toLowerCase().replace(/\s+/g, " ");
          const parts = norm.includes(",")
            ? norm.split(",").map((p) => p.trim()).reverse()
            : norm.split(" ");
          const lastName = parts[parts.length - 1];
          const lastNameMatch = crewRoster.find((c) => {
            const cParts = c.name.trim().toLowerCase().replace(/\s+/g, " ").split(" ");
            return cParts[cParts.length - 1] === lastName;
          });
          if (lastNameMatch) {
            crewMember = lastNameMatch;
            warnings.push(`"${name}" matched to "${lastNameMatch.name}" (${lastNameMatch.role}) by last name`);
          } else {
            warnings.push(`"${name}" not found in roster`);
          }
        }
      }

      // Resolve home airports: roster first, then fall back to oncoming pool data
      let homeAirports = crewMember?.home_airports ?? [];
      if (homeAirports.length === 0 && oncomingPool) {
        const poolList = role === "PIC" ? oncomingPool.pic : oncomingPool.sic;
        // Also check the opposite role's pool
        const altPoolList = role === "PIC" ? oncomingPool.sic : oncomingPool.pic;
        const normName = name.trim().toLowerCase().replace(/\s+/g, " ");
        const poolEntry = [...poolList, ...altPoolList].find((p) =>
          p.name.trim().toLowerCase().replace(/\s+/g, " ") === normName
        );
        if (poolEntry?.home_airports?.length) {
          homeAirports = poolEntry.home_airports;
        }
      }

      return { crewMember, homeAirports, warnings };
    }

    // ── Helper: look up volunteer flags from oncoming pool ──────────────
    function getVolunteerFlags(name: string, role: "PIC" | "SIC"): { earlyVolunteer: boolean; lateVolunteer: boolean } {
      if (!oncomingPool) return { earlyVolunteer: false, lateVolunteer: false };
      const poolList = role === "PIC" ? oncomingPool.pic : oncomingPool.sic;
      const altPoolList = role === "PIC" ? oncomingPool.sic : oncomingPool.pic;
      const normName = name.trim().toLowerCase().replace(/\s+/g, " ");
      const entry = [...poolList, ...altPoolList].find((p) =>
        p.name.trim().toLowerCase().replace(/\s+/g, " ") === normName
      );
      return {
        earlyVolunteer: entry?.early_volunteer ?? false,
        lateVolunteer: entry?.late_volunteer ?? false,
      };
    }

    // ── Create crew tasks + run optimizer ───────────────────────────────
    // Wrapped in a helper so we can retry with alternative swap points
    // when oncoming crew can't arrive before the aircraft departs.

    if (!assignment.oncoming_pic) {
      globalWarnings.push(`${tail}: No oncoming PIC assigned — no qualified crew can reach this aircraft`);
    }
    if (!assignment.oncoming_sic) {
      globalWarnings.push(`${tail}: No oncoming SIC assigned — no qualified crew can reach this aircraft`);
    }

    /** Build tasks for a given swap point and run optimizeTail */
    function buildAndOptimizeTasks(
      useSwapPoint: SwapPoint,
    ): { tasks: CrewTask[]; result: OptimizeTailResult } {
      const tasks: CrewTask[] = [];

      const isIdleTail = swapPoints.length >= 2 && swapPoints.every((sp) => sp.position === "idle");
      const useOffgoingSwapPoint = isIdleTail ? swapPoints[swapPoints.length - 1] : useSwapPoint;

      // PIC tasks
      for (const [name, direction] of [
        [assignment.oncoming_pic, "oncoming"] as const,
        [assignment.offgoing_pic, "offgoing"] as const,
      ]) {
        if (!name) continue;
        const { crewMember, homeAirports, warnings } = resolveCrewMember(name, "PIC");
        if (homeAirports.length === 0) {
          console.warn(`[SwapOptimizer] No home airports for "${name}" (PIC, ${tail})`);
        }
        if (useSwapPoint !== swapPoints[0]) {
          warnings.push(`PIC swaps at ${toIata(useSwapPoint.icao)} (${useSwapPoint.position}) — easier commercial access than ${toIata(swapPoints[0].icao)}`);
        }
        const volFlags = direction === "oncoming" ? getVolunteerFlags(name, "PIC") : { earlyVolunteer: false, lateVolunteer: false };
        const taskSwapPoint = direction === "offgoing" ? useOffgoingSwapPoint : useSwapPoint;
        tasks.push({
          name: crewMember?.name ?? name, crewMember, role: "PIC", direction, tail,
          aircraftType, swapPoint: taskSwapPoint, homeAirports,
          candidates: [], best: null, warnings,
          ...volFlags,
        });
      }

      // SIC tasks
      for (const [name, direction] of [
        [assignment.oncoming_sic, "oncoming"] as const,
        [assignment.offgoing_sic, "offgoing"] as const,
      ]) {
        if (!name) continue;
        const { crewMember, homeAirports, warnings } = resolveCrewMember(name, "SIC");
        if (homeAirports.length === 0) {
          console.warn(`[SwapOptimizer] No home airports for "${name}" (SIC, ${tail})`);
        }

        const sicVolFlags = direction === "oncoming" ? getVolunteerFlags(name, "SIC") : { earlyVolunteer: false, lateVolunteer: false };

        // If assignment phase proved a SIC swap point, use it directly
        const assignedSicSwapIcao = assignment.oncoming_sic_swap_icao;
        if (direction === "oncoming" && assignedSicSwapIcao) {
          const matched = swapPoints.find((sp) => sp.icao.toUpperCase() === assignedSicSwapIcao.toUpperCase());
          if (matched) {
            tasks.push({
              name: crewMember?.name ?? name, crewMember, role: "SIC", direction, tail,
              aircraftType, swapPoint: matched, homeAirports,
              candidates: [], best: null, warnings,
              ...sicVolFlags,
            });
            continue; // skip the default swap point
          }
        }

        // SIC MUST swap at the same airport as PIC — no split swaps allowed.
        const sicSwapPoint = direction === "offgoing"
          ? useOffgoingSwapPoint
          : useSwapPoint;

        tasks.push({
          name: crewMember?.name ?? name, crewMember, role: "SIC", direction, tail,
          aircraftType, swapPoint: sicSwapPoint, homeAirports,
          candidates: [], best: null, warnings,
          ...sicVolFlags,
        });
      }

      // Run optimizer
      const result = optimizeTail(tasks, aliases, commercialFlights, swapDate, byTail.get(tail), offgoingDeadlines);
      return { tasks, result };
    }

    // ── Try primary swap point, then retry alternatives on timing violation or unattended gap ──
    let { tasks: tailTasks, result: optimizeResult } = buildAndOptimizeTasks(picSwapPoint);

    // Retry if there's a departure timing violation OR an unattended gap.
    // Timing violations apply to before_live/between_legs (hard departure constraint).
    // Unattended gaps apply to after_live/idle (offgoing leaves before oncoming arrives).
    const needsRetry = optimizeResult.timingViolation || optimizeResult.unattendedGap;

    if (needsRetry && swapPoints.length > 1) {
      const primaryPosition = picSwapPoint.position;
      const hasDepartureConstraint = primaryPosition === "before_live" || primaryPosition === "between_legs";
      const hasUnattendedGap = optimizeResult.unattendedGap;

      // Retry on EITHER departure constraint violation OR unattended gap
      if (hasDepartureConstraint || hasUnattendedGap) {
        const reason = hasDepartureConstraint
          ? `timing violation, crew arrives ${Math.round(optimizeResult.violationGapMs / 60_000)}min after deadline`
          : `unattended gap of ${Math.round(optimizeResult.unattendedGapMs / 60_000)}min`;
        console.log(
          `[SwapPointRetry] ${tail}: ${reason} at ${toIata(picSwapPoint.icao)} (${primaryPosition}). Trying alternatives...`
        );

        // Build alternative list from ALL swapPoints, not just swapPointScores.
        // Some swap points may not have been scored (e.g., assignedPicSwapIcao was set,
        // or commercialFlights was null), but they're still valid retry candidates.
        const alternativeSpList = swapPoints
          .filter((sp) => sp.icao !== picSwapPoint.icao)
          .map((sp) => {
            // Look up ease score if available, otherwise use 0 (unscored — still try it)
            const scoreEntry = swapPointScores.find((s) => s.icao === sp.icao);
            return { sp, ease: scoreEntry?.ease ?? 0, position: sp.position };
          })
          .sort((a, b) => b.ease - a.ease);

        // Combined badness metric: timing violation gap + unattended gap
        const currentBadness = optimizeResult.violationGapMs + optimizeResult.unattendedGapMs;

        // Track the best result (least violation) in case all fail
        let bestBadness = currentBadness;
        let bestTasks = tailTasks;
        let bestResult = optimizeResult;
        let bestSwapPoint = picSwapPoint;
        let solved = false;

        for (const alt of alternativeSpList) {
          const altSp = alt.sp;

          const { tasks: altTasks, result: altResult } = buildAndOptimizeTasks(altSp);

          if (!altResult.timingViolation && !altResult.unattendedGap) {
            // This alternative swap point works — no violations at all
            console.log(
              `[SwapPointRetry] ${tail}: SOLVED at ${toIata(altSp.icao)} (${alt.position}) — ` +
              `no timing violation, no unattended gap, ease=${alt.ease}`
            );
            tailTasks = altTasks;
            optimizeResult = altResult;
            picSwapPoint = altSp; // update for debug tracking
            solved = true;

            // Update swap point debug to reflect the new selection
            for (const s of swapPointScores) s.selected = false;
            const newSelected = swapPointScores.find((s) => s.icao === altSp.icao);
            if (newSelected) newSelected.selected = true;
            break;
          }

          // Track least-bad option (combined timing + unattended badness)
          const altBadness = altResult.violationGapMs + altResult.unattendedGapMs;
          if (altBadness < bestBadness) {
            bestBadness = altBadness;
            bestTasks = altTasks;
            bestResult = altResult;
            bestSwapPoint = altSp;
          }
        }

        if (!solved) {
          // ALL swap points have violations — use the least-bad one
          if (bestSwapPoint !== picSwapPoint) {
            console.log(
              `[SwapPointRetry] ${tail}: all swap points have violations. ` +
              `Using least-bad: ${toIata(bestSwapPoint.icao)} (badness=${Math.round(bestBadness / 60_000)}min)`
            );
            tailTasks = bestTasks;
            optimizeResult = bestResult;
            picSwapPoint = bestSwapPoint;

            for (const s of swapPointScores) s.selected = false;
            const newSelected = swapPointScores.find((s) => s.icao === bestSwapPoint.icao);
            if (newSelected) newSelected.selected = true;
          }

          // Mark as UNSOLVABLE — force crew with timing violations to travel_type "none"
          // Only for departure-constrained swap points (before_live / between_legs)
          if (optimizeResult.timingViolation) {
            const depSp = tailTasks[0]?.swapPoint;
            const depTime = depSp
              ? ((depSp.position === "between_legs" && depSp.window_end) ? depSp.window_end : depSp.time)
              : null;
            const depStr = depTime
              ? new Date(depTime).toISOString().slice(11, 16) + "Z"
              : "unknown";

            for (const task of tailTasks) {
              if (task.direction !== "oncoming") continue;
              const sp = task.swapPoint;
              if (sp.position !== "before_live" && sp.position !== "between_legs") continue;

              const taskDepTime = (sp.position === "between_legs" && sp.window_end) ? sp.window_end : sp.time;
              const deadlineMs = new Date(taskDepTime).getTime() - ms(FBO_ARRIVAL_BUFFER);
              const arrivalMs = task.best?.fboArrivalTime?.getTime();

              if (!task.best || task.best.type === "none" || (arrivalMs && arrivalMs > deadlineMs)) {
                const arrStr = arrivalMs
                  ? new Date(arrivalMs).toISOString().slice(11, 16) + "Z"
                  : "no transport";
                const unsolvableMsg = `UNSOLVABLE: No swap point allows ${task.role} to arrive before aircraft departs ${depStr}. ` +
                  `Best option: arrives ${arrStr}. All ${swapPoints.length} swap points tried. Manual intervention required.`;
                task.warnings = [unsolvableMsg]; // Replace any lesser warnings
                task.best = {
                  type: "none", flightNumber: null, depTime: null, arrTime: null,
                  from: "", to: "", cost: 0, durationMin: 0, isDirect: false,
                  isBudgetCarrier: false, hubConnection: false, connectionCount: 0,
                  offer: null, drive: null, fboArrivalTime: null, fboLeaveTime: null,
                  dutyOnTime: null, score: 0, backups: [],
                };
                console.log(`[SwapPointRetry] ${tail} ${task.role}: ${unsolvableMsg}`);
              }
            }
          }

          // Mark unattended gap warnings for after_live/idle positions
          if (optimizeResult.unattendedGap) {
            for (const task of tailTasks) {
              if (task.direction !== "oncoming") continue;
              const sp = task.swapPoint;
              if (sp.position !== "after_live" && sp.position !== "idle") continue;

              const onArriveMs = task.best?.fboArrivalTime?.getTime();
              const offTask = tailTasks.find((t) => t.direction === "offgoing" && t.role === task.role);
              const offLeaveMs = offTask?.best?.fboLeaveTime?.getTime()
                ?? offTask?.best?.depTime?.getTime();

              if (onArriveMs && offLeaveMs && (onArriveMs - offLeaveMs) > HANDOFF_BUFFER_MINUTES * 60_000) {
                const gapMin = Math.round((onArriveMs - offLeaveMs) / 60_000);
                const unsolvableMsg = `UNSOLVABLE: Aircraft unattended for ${gapMin}min at ${toIata(sp.icao)}. ` +
                  `All ${swapPoints.length} swap points tried. Manual intervention required.`;
                task.warnings.push(unsolvableMsg);
                if (offTask) offTask.warnings.push(unsolvableMsg);
                console.log(`[SwapPointRetry] ${tail} ${task.role}: ${unsolvableMsg}`);
              }
            }
          }
        }
      }
    }

    allTasks.push(...tailTasks);

    // Emit placeholder rows for unassigned oncoming slots
    // So every tail appears in the output — unassigned slots show "needs flights"
    for (const [slotName, role] of [
      ["oncoming_pic", "PIC"] as const,
      ["oncoming_sic", "SIC"] as const,
    ]) {
      if (!assignment[slotName]) {
        allTasks.push({
          name: `[UNASSIGNED ${role}]`,
          crewMember: null,
          role,
          direction: "oncoming" as const,
          tail,
          aircraftType,
          swapPoint: swapPoints[0],
          homeAirports: [],
          candidates: [],
          best: null,
          warnings: [`No ${role} assigned — run Optimize + Flights`],
          earlyVolunteer: false,
          lateVolunteer: false,
        });
      }
    }
  }

  // ── Staggered arrivals check ──────────────────────────────────────────
  // Group oncoming PICs by swap airport (one per tail) — only compare across tails.
  // Same-tail PIC+SIC arriving close together is expected and not worth warning about.
  // Stagger warnings removed — not actionable enough to warrant noise in the plan.

  // ── Helper: generate transport notes — method + ground transport only ────
  // No routes/connections, no cross-crew sharing references.
  function generateTransportNote(best: TransportCandidate | null, task: CrewTask): string | null {
    if (!best || best.type === "none") return null;
    const swapLoc = toIata(task.swapPoint.icao);
    const parts: string[] = [];

    if (task.direction === "oncoming") {
      // Ground transport to FBO + arrival time
      if (best.type === "commercial" && best.to !== swapLoc) {
        parts.push(`Uber ${best.to}→${swapLoc}`);
      } else if (best.type === "rental_car") {
        const driveMin = best.durationMin ?? 0;
        const hrs = Math.floor(driveMin / 60);
        const mins = driveMin % 60;
        const driveStr = mins > 0 ? `${hrs}h${String(mins).padStart(2, "0")}m` : `${hrs}h`;
        parts.push(`Drive, ~${driveStr}`);
      } else if (best.type === "uber") {
        parts.push(`Uber to ${swapLoc}`);
      }
      if (best.fboArrivalTime) {
        const tz = getAirportTimezone(task.swapPoint.icao) ?? "America/New_York";
        const localStr = best.fboArrivalTime.toLocaleTimeString("en-US", {
          timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false,
        });
        parts.push(`on site by ${localStr}L`);
      }
    } else {
      // Offgoing: just ground transport method
      if (best.type === "commercial" && best.from !== swapLoc) {
        parts.push(`Uber to ${best.from}`);
      } else if (best.type === "rental_car") {
        const driveMin = best.durationMin ?? 0;
        const hrs = Math.floor(driveMin / 60);
        const mins = driveMin % 60;
        const driveStr = mins > 0 ? `${hrs}h${String(mins).padStart(2, "0")}m` : `${hrs}h`;
        parts.push(`Drive home, ~${driveStr}`);
      } else if (best.type === "uber") {
        parts.push(`Uber home`);
      }
    }
    return parts.length > 0 ? parts.join(", ") : null;
  }

  // ── Emit rows for staying crew (2nd rotation — no transport needed) ────
  const stayingNames = new Set((stayingCrew ?? []).map((s) => s.name));

  for (const stay of (stayingCrew ?? [])) {
    const crewMember = crewRoster.find((c) => c.name === stay.name) ?? null;
    const aircraftType = crewMember?.aircraft_types[0] ?? "unknown";
    const { swapPoints } = extractSwapPoints(stay.tail, byTail, swapDate);
    const swapLoc = swapPoints[0] ? toIata(swapPoints[0].icao) : null;

    // Remove staying crew from swap assignments so they don't get transport planned
    const assignment = swapAssignments?.[stay.tail];
    if (assignment) {
      if (assignment.offgoing_pic === stay.name) assignment.offgoing_pic = null;
      if (assignment.offgoing_sic === stay.name) assignment.offgoing_sic = null;
      if (assignment.oncoming_pic === stay.name) assignment.oncoming_pic = null;
      if (assignment.oncoming_sic === stay.name) assignment.oncoming_sic = null;
    }

    // Emit a "staying" row — no transport needed
    allTasks.push({
      name: stay.name,
      crewMember,
      role: stay.role,
      direction: "oncoming",
      tail: stay.tail,
      aircraftType,
      swapPoint: swapPoints[0] ?? { icao: "", time: new Date(), position: "idle", isAdjacentLive: false },
      homeAirports: crewMember?.home_airports ?? [],
      candidates: [],
      best: {
        type: "none",
        flightNumber: null,
        depTime: null,
        arrTime: null,
        from: swapLoc ?? "",
        to: swapLoc ?? "",
        cost: 0,
        durationMin: 0,
        isDirect: false,
        isBudgetCarrier: false,
        hubConnection: false,
        connectionCount: 0,
        offer: null,
        drive: null,
        fboArrivalTime: null,
        fboLeaveTime: null,
        dutyOnTime: null,
        score: 100,
        backups: [],
      },
      warnings: [],
    });
  }

  // ── Convert tasks to CrewSwapRow[] ─────────────────────────────────────
  const rows: CrewSwapRow[] = allTasks.map((task) => {
    const best = task.best;
    const altFlights = task.candidates
      .filter((c) => c !== best && c.type === "commercial")
      .slice(0, 3)
      .map((c) => ({
        flight_number: c.flightNumber ?? "",
        dep: c.depTime?.toISOString() ?? "",
        arr: c.arrTime?.toISOString() ?? "",
        price: String(Math.round(c.cost)),
      }));

    const backupStr = best?.backups?.[0]?.flightNumber ?? null;

    return {
      name: task.name,
      home_airports: task.homeAirports,
      role: task.role,
      direction: task.direction,
      aircraft_type: task.aircraftType,
      tail_number: task.tail,
      swap_location: toIata(task.swapPoint.icao),
      all_swap_points: extractSwapPoints(task.tail, byTail, swapDate).swapPoints.map((sp) => toIata(sp.icao)),
      travel_type: best?.type ?? "none",
      flight_number: best?.flightNumber ?? null,
      departure_time: best?.depTime?.toISOString() ?? null,
      arrival_time: best?.arrTime?.toISOString() ?? null,
      travel_from: best?.from ?? null,
      travel_to: best?.to ?? null,
      cost_estimate: best ? Math.round(best.cost) : null,
      duration_minutes: best?.durationMin ?? null,
      available_time: best?.fboArrivalTime?.toISOString() ?? null,
      duty_on_time: best?.dutyOnTime?.toISOString() ?? null,
      duty_off_time: (() => {
        if (task.direction === "oncoming") {
          // Oncoming duty ends: last leg arrival on swap day + DUTY_OFF_AFTER_LAST_LEG
          const tailLegs = byTail.get(task.tail) ?? [];
          const swapDayLegs = tailLegs.filter((f) => f.scheduled_departure.slice(0, 10) === swapDate);
          const lastLeg = swapDayLegs[swapDayLegs.length - 1];
          if (lastLeg?.scheduled_arrival) {
            return new Date(new Date(lastLeg.scheduled_arrival).getTime() + ms(DUTY_OFF_AFTER_LAST_LEG)).toISOString();
          }
          return null;
        }
        // Offgoing duty ends: arrival home (commercial landing or drive arrival)
        if (best?.arrTime) {
          return new Date(best.arrTime.getTime() + ms(DUTY_OFF_AFTER_LAST_LEG)).toISOString();
        }
        return null;
      })(),
      is_checkairman: task.crewMember?.is_checkairman ?? false,
      checkairman_types: task.crewMember?.checkairman_types ?? [],
      is_skillbridge: task.crewMember?.is_skillbridge ?? false,
      grade: task.crewMember?.grade ?? 3,
      volunteer_status: (() => {
        if (stayingNames.has(task.name)) return null;
        if (task.crewMember?.is_skillbridge) {
          if (task.earlyVolunteer) return "Early Vol ($1500)";
          return "SkillBridge (no bonus)";
        }
        if (task.earlyVolunteer) return `Early Vol ($${task.role === "PIC" ? EARLY_LATE_BONUS_PIC : EARLY_LATE_BONUS_SIC})`;
        if (task.lateVolunteer) return `Late Vol ($${task.role === "PIC" ? EARLY_LATE_BONUS_PIC : EARLY_LATE_BONUS_SIC})`;
        return null;
      })(),
      notes: stayingNames.has(task.name)
        ? "Stays on aircraft — 2nd rotation"
        : task.name.startsWith("[UNASSIGNED")
          ? `Needs crew — run Optimize + Flights`
          : best?.type === "none"
            ? task.direction === "oncoming"
              ? `No viable transport from ${task.homeAirports[0] ?? "?"} to ${toIata(task.swapPoint.icao)}`
              : `No viable transport from ${toIata(task.swapPoint.icao)} to ${task.homeAirports[0] ?? "?"}`
            : generateTransportNote(best, task),
      warnings: (() => {
        const w = [...task.warnings];
        // Flag offgoing commercial flights departing < 90 min after last leg lands
        if (task.direction === "offgoing" && best?.type === "commercial" && best.depTime &&
            (task.swapPoint.position === "after_live" || task.swapPoint.position === "between_legs")) {
          const gapMin = (best.depTime.getTime() - task.swapPoint.time.getTime()) / 60_000;
          if (gapMin < MIN_OFFGOING_COMMERCIAL_BUFFER) {
            w.push(`Tight departure: flight departs ${Math.round(gapMin)}min after last leg lands (minimum ${MIN_OFFGOING_COMMERCIAL_BUFFER}min recommended)`);
          }
        }
        return w;
      })(),
      drive_estimate: best?.drive ?? null,
      flight_offer: best?.offer ?? null,
      alt_flights: altFlights,
      backup_flight: backupStr,
      score: best?.score ?? 0,
      confirmed: false,
    };
  });

  // Sort: oncoming PIC, oncoming SIC, offgoing PIC, offgoing SIC
  const sectionOrder = (r: CrewSwapRow) => {
    if (r.direction === "oncoming" && r.role === "PIC") return 0;
    if (r.direction === "oncoming" && r.role === "SIC") return 1;
    if (r.direction === "offgoing" && r.role === "PIC") return 2;
    return 3;
  };
  rows.sort((a, b) => sectionOrder(a) - sectionOrder(b) || a.name.localeCompare(b.name));

  const totalCost = rows.reduce((s, r) => s + (r.cost_estimate ?? 0), 0);
  // Score only counts rows with actual transport — "none" rows are tracked separately
  const solvedRows = rows.filter((r) => r.travel_type !== "none");
  const unsolvedRows = rows.filter((r) => r.travel_type === "none");
  const avgScore = solvedRows.length > 0
    ? Math.round(solvedRows.reduce((s, r) => s + r.score, 0) / solvedRows.length)
    : 0;

  if (unsolvedRows.length > 0) {
    const needsFlightCount = unsolvedRows.filter((r) => r.direction === "oncoming").length;
    const otherUnsolved = unsolvedRows.length - needsFlightCount;
    if (needsFlightCount > 0) {
      globalWarnings.push(`${needsFlightCount} oncoming crew need commercial flights — run Optimize + Flights`);
    }
    if (otherUnsolved > 0) {
      globalWarnings.push(`${otherUnsolved} offgoing crew have no viable transport — arrange manually`);
    }
  }

  return {
    swap_date: swapDate,
    rows,
    warnings: globalWarnings,
    total_cost: totalCost,
    plan_score: avgScore,
    solved_count: solvedRows.length,
    unsolved_count: unsolvedRows.length,
    swap_point_debug: Object.keys(swapPointDebug).length > 0 ? swapPointDebug : undefined,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// CREW ASSIGNMENT: Assign oncoming crew from pool to tails
// ═══════════════════════════════════════════════════════════════════════════════

export type OncomingPoolEntry = {
  name: string;
  aircraft_type: string;
  home_airports: string[];
  is_checkairman: boolean;
  is_skillbridge: boolean;
  early_volunteer: boolean;
  late_volunteer: boolean;
  standby_volunteer: boolean;
  notes: string | null;
};

export type OncomingPool = {
  pic: OncomingPoolEntry[];
  sic: OncomingPoolEntry[];
};

/** Determine where a tail will be on swap day */
function determineSwapLocation(
  tail: string,
  flights: FlightLeg[],
  swapDate: string,
): { icao: string; time: Date } | null {
  const tailFlights = flights.filter((f) => f.tail_number === tail);
  tailFlights.sort((a, b) => new Date(a.scheduled_departure).getTime() - new Date(b.scheduled_departure).getTime());

  const wedLegs = tailFlights.filter((f) => f.scheduled_departure.slice(0, 10) === swapDate);
  const liveWedLegs = wedLegs.filter((f) => isLiveType(f.flight_type));

  if (liveWedLegs.length > 0) {
    return { icao: liveWedLegs[0].departure_icao, time: new Date(liveWedLegs[0].scheduled_departure) };
  }
  if (wedLegs.length > 0) {
    return { icao: wedLegs[0].departure_icao, time: new Date(wedLegs[0].scheduled_departure) };
  }

  const priorLegs = tailFlights.filter(
    (f) => new Date(f.scheduled_departure).getTime() < new Date(swapDate).getTime(),
  );
  const lastPrior = priorLegs[priorLegs.length - 1];
  if (lastPrior?.arrival_icao) {
    return { icao: lastPrior.arrival_icao, time: new Date(`${swapDate}T12:00:00Z`) };
  }

  return null;
}

/** Check if crew member is qualified for an aircraft type */
function isQualified(crewAircraftType: string, tailAircraftType: string): boolean {
  if (tailAircraftType === "unknown" || crewAircraftType === "unknown") return true;
  if (crewAircraftType === "dual") return true; // dual-qualified flies anything
  if (tailAircraftType === "dual") return true; // dual-type aircraft accepts anyone
  return crewAircraftType === tailAircraftType;
}

// ═══════════════════════════════════════════════════════════════════════════════
// TRANSPORT-FIRST ASSIGNMENT (v4)
// ═══════════════════════════════════════════════════════════════════════════════

type FeasibilityEntry = {
  crewName: string;
  tail: string;
  viable: boolean;
  bestScore: number;
  bestCost: number;       // oncoming cost
  offgoingCost: number;   // cheapest offgoing route from this swap airport
  totalCost: number;      // oncoming + offgoing combined
  bestType: string;
  candidateCount: number;
  rank: number; // weighted blend of total cost + reliability + proximity (lower = better)
  bestSwapIcao: string;   // which swap point produced the best result
  minDriveMiles: number;  // shortest home→swap distance (for fallback tiebreak)
};

/** Tracks why a specific crew member was rejected for a specific tail */
type RejectionReason = "type_mismatch" | "intl_restricted" | "no_route" | "route_score_zero";

type FeasibilityRejection = {
  crewName: string;
  tail: string;
  reason: RejectionReason;
};

type FeasibilityMatrixResult = {
  matrix: FeasibilityEntry[];
  rejections: FeasibilityRejection[];
};

/** Build a feasibility matrix: for every crew × tail, determine which assignments
 *  are viable. When preComputedRoutes is provided, uses cached route data from
 *  pilot_routes table (instant). Otherwise falls back to runtime evaluation
 *  (buildCandidates + scoreCandidate). */
function buildFeasibilityMatrix(params: {
  pool: OncomingPoolEntry[];
  role: "PIC" | "SIC";
  tails: string[];
  byTail: Map<string, FlightLeg[]>;
  swapDate: string;
  aliases: AirportAlias[];
  commercialFlights?: Map<string, FlightOffer[]>;
  crewRoster: CrewMember[];
  tailAircraftType: Map<string, string>;
  preComputedRoutes?: Map<string, PilotRoute[]>;  // crewMemberId → oncoming routes
  preComputedOffgoing?: Map<string, PilotRoute[]>;  // crewMemberId → offgoing routes
  offgoingDeadlines?: OncomingDeadline[];  // offgoing departure deadlines per tail+role
  picSwapPoints?: Map<string, string>;  // tail → PIC swap ICAO (for SIC same-swap-point preference)
  relaxation?: boolean;  // when true, use relaxed constraints (expanded drive limits, reduced buffers)
  swapPointFallback?: boolean;  // when true, PIC tries ALL swap points (not just best)
}): FeasibilityMatrixResult {
  const { pool, role, tails, byTail, swapDate, aliases, commercialFlights, crewRoster, tailAircraftType, preComputedRoutes, preComputedOffgoing, offgoingDeadlines, picSwapPoints, relaxation, swapPointFallback } = params;
  const effectiveRentalMax = relaxation ? RELAXED_RENTAL_MAX_MINUTES : RENTAL_MAX_MINUTES;
  const matrix: FeasibilityEntry[] = [];
  const rejections: FeasibilityRejection[] = [];

  // Cache buildCandidates results by homeAirports+swapPointIcao.
  // Many crew share the same home airport, so candidates are identical — skip recomputing.
  const candidateCache = new Map<string, TransportCandidate[]>();

  for (const tail of tails) {
    const { swapPoints } = extractSwapPoints(tail, byTail, swapDate);
    if (swapPoints.length === 0) continue;

    // Determine the FBO airports this tail can swap at
    const tailSwapIcaos = new Set(swapPoints.map((sp) => sp.icao.toUpperCase()));

    // SIC tries all swap points (can swap at intermediate airports).
    // PIC: in drive-only mode, try ALL swap points (commercial accessibility irrelevant).
    // With flights, pick BEST swap point using the same timing-aware ease formula as
    // buildSwapPlan — ensures the feasibility matrix evaluates the same point that
    // will actually be used for transport planning.
    let swapPointsToTry = swapPoints;
    // HARD RULE: prefer domestic after_live ONLY when alternative is international
    if (role === "PIC") {
      const hasIntlOption3 = swapPoints.some(sp => {
        const upper = sp.icao.toUpperCase();
        return !upper.startsWith("K") && !upper.startsWith("CY");
      });
      if (hasIntlOption3) {
        const domesticAfterLive3 = swapPoints.find(sp => {
          if (sp.position !== "after_live") return false;
          const upper = sp.icao.toUpperCase();
          return upper.startsWith("K") || upper.startsWith("CY");
        });
        if (domesticAfterLive3) swapPointsToTry = [domesticAfterLive3];
      }
    }
    if (role === "PIC" && swapPointsToTry.length > 1 && (commercialFlights || preComputedRoutes) && !swapPointFallback) {
      let bestSp = swapPointsToTry[0];
      let bestEase = -Infinity;
      for (const sp of swapPoints) {
        const commAirports = findAllCommercialAirports(sp.icao, aliases);
        const selfCommercial = isCommercialAirport(sp.icao);
        let minDrive = Infinity;
        for (const c of commAirports) {
          if (c.toUpperCase() === sp.icao.toUpperCase()) { minDrive = 0; break; }
          const d = estimateDriveTime(sp.icao, c);
          if (d) minDrive = Math.min(minDrive, d.estimated_drive_minutes);
        }
        const isInternational = commAirports.every((c) => {
          const u = c.toUpperCase();
          if (TERRITORY_AIRPORTS.has(u)) return true;
          return !u.startsWith("K") && !u.startsWith("CY") && !u.startsWith("Y");
        });
        // Timing penalty: same formula as buildSwapPlan's swap point picker.
        // For between_legs, use window_end (next departure) — the actual crew deadline.
        let timingPenalty = 0;
        if (sp.position === "after_live" || sp.position === "between_legs") {
          const tz = getAirportTimezone(sp.icao) ?? "America/New_York";
          const refTime = (sp.position === "between_legs" && sp.window_end) ? sp.window_end : sp.time;
          const localHour = parseFloat(
            new Date(refTime).toLocaleString("en-US", { hour: "numeric", hour12: false, timeZone: tz })
          );
          const hoursAfterNoon = Math.max(0, localHour - 12);
          timingPenalty = Math.min(150, hoursAfterNoon * 12);
        }
        // Crew-proximity bonus: how close is the oncoming pool to this swap point?
        // Prevents picking remote airports (e.g. SJU) when all crew live on the mainland.
        let totalProximity = 0;
        let proximityCount = 0;
        for (const p of pool) {
          for (const home of p.home_airports) {
            for (const comm of commAirports) {
              const d = estimateDriveTime(toIcao(home), comm);
              if (d) {
                totalProximity += Math.min(d.straight_line_miles, 2000);
                proximityCount++;
                break; // closest commercial airport is enough
              }
            }
          }
        }
        const avgMiles = proximityCount > 0 ? totalProximity / proximityCount : 1000;
        // Bonus: 0mi avg = +120, 500mi avg = +60, 1000mi+ = 0
        const proximityBonus = Math.max(0, 120 - (avgMiles / 1000) * 120);

        const afterLiveBonus = sp.position === "after_live" ? 80 : 0;

        // Flight-existence check: if the commercial flight map has ZERO flights
        // to this swap airport from ANY crew home, heavily penalize this swap point.
        // Prevents selecting airports with no cached flights (e.g., SBA with 0 flights).
        let hasAnyFlightsToSwap = false;
        if (commercialFlights) {
          const destIatas = commAirports.map((c) => toIata(c));
          for (const p of pool) {
            for (const home of p.home_airports) {
              const homeIata = toIata(toIcao(home));
              const homeIcao = toIcao(home);
              const homeSearchIatas = [homeIata];
              if (!isCommercialAirport(homeIcao)) {
                const nearbyComm = findAllCommercialAirports(homeIcao, aliases);
                for (const nc of nearbyComm) homeSearchIatas.push(toIata(nc));
              }
              for (const oi of homeSearchIatas) {
                for (const di of destIatas) {
                  if (lookupFlights(commercialFlights, oi, di, swapDate).length > 0) {
                    hasAnyFlightsToSwap = true; break;
                  }
                }
                if (hasAnyFlightsToSwap) break;
              }
              if (hasAnyFlightsToSwap) break;
            }
            if (hasAnyFlightsToSwap) break;
          }
        }
        const noFlightsPenalty = hasAnyFlightsToSwap ? 0 : -300;

        const ease = -(minDrive === Infinity ? 999 : minDrive) + (selfCommercial ? 30 : 0)
          + commAirports.length * 2 - (isInternational ? 500 : 0) - timingPenalty + proximityBonus + afterLiveBonus + noFlightsPenalty;
        if (ease > bestEase) { bestEase = ease; bestSp = sp; }
      }
      swapPointsToTry = [bestSp];
    }

    // SIC MUST use PIC's swap point — no split swaps allowed.
    // PIC and SIC always swap at the same airport.
    if (role === "SIC" && picSwapPoints) {
      const picSp = picSwapPoints.get(tail);
      if (picSp) {
        const matched = swapPoints.find((sp) => sp.icao.toUpperCase() === picSp.toUpperCase());
        if (matched) {
          swapPointsToTry = [matched]; // SIC locked to PIC's swap point
        }
      }
    }

    const acType = tailAircraftType.get(tail) ?? "unknown";

    for (const poolEntry of pool) {
      if (!isQualified(poolEntry.aircraft_type, acType)) {
        matrix.push({ crewName: poolEntry.name, tail, viable: false, bestScore: 0, bestCost: 999, offgoingCost: 0, totalCost: 999, bestType: "none", candidateCount: 0, rank: 999, bestSwapIcao: "", minDriveMiles: 9999 });
        rejections.push({ crewName: poolEntry.name, tail, reason: "type_mismatch" });
        continue;
      }

      // Find or create a CrewMember from the roster for this pool entry
      const crewMember = findCrewByName(crewRoster, poolEntry.name, role);

      // ── Per-crew restrictions (e.g., no_international) ─────────────────
      if (crewMember?.restrictions?.no_international) {
        // Check if this tail has any international legs on swap day
        const tailLegs = byTail.get(tail) ?? [];
        const wedStr = swapDate;
        const hasIntlLeg = tailLegs.some((leg) => {
          if (!leg.scheduled_departure?.startsWith(wedStr)) return false;
          const dep = leg.departure_icao?.toUpperCase() ?? "";
          const arr = leg.arrival_icao?.toUpperCase() ?? "";
          // International = not starting with K (US) or C (Canada) and not territory
          const isIntl = (icao: string) => !icao.startsWith("K") && !icao.startsWith("CY") && !TERRITORY_AIRPORTS.has(icao);
          return isIntl(dep) || isIntl(arr);
        });
        if (hasIntlLeg) {
          matrix.push({ crewName: poolEntry.name, tail, viable: false, bestScore: 0, bestCost: 999, offgoingCost: 0, totalCost: 999, bestType: "none", candidateCount: 0, rank: 999, bestSwapIcao: "", minDriveMiles: 9999 });
          rejections.push({ crewName: poolEntry.name, tail, reason: "intl_restricted" });
          continue;
        }
      }
      const homeAirports = crewMember?.home_airports?.length ? crewMember.home_airports : poolEntry.home_airports;

      if (homeAirports.length === 0) {
        console.warn(`[FeasMatrix] ${poolEntry.name} has NO home airports (pool: ${poolEntry.home_airports.length}, roster: ${crewMember?.home_airports?.length ?? 0})`);
      }

      // ── PRE-COMPUTED ROUTES PATH (instant) ──────────────────────────────
      // Only use pre-computed path if this crew member actually HAS routes.
      // Otherwise fall through to runtime buildCandidates evaluation.
      if (preComputedRoutes && crewMember?.id && preComputedRoutes.has(crewMember.id)) {
        const crewRoutes = preComputedRoutes.get(crewMember.id)!;

        // Filter routes to destinations matching this tail's swap airports
        const relevantRoutes = crewRoutes.filter((r) =>
          tailSwapIcaos.has(r.destination_icao.toUpperCase()),
        );

        const viableRoutes = relevantRoutes.filter((r) => r.score > 0);
        const best = viableRoutes.sort((a, b) => b.score - a.score)[0] ?? null;
        const viable = viableRoutes.length > 0;

        const bestSwapIcao = best?.destination_icao ?? (swapPoints[0]?.icao ?? "");

        // Compute proximity
        let minDriveMin = 999;
        let minDriveMiles = 9999;
        for (const home of homeAirports) {
          const drive = estimateDriveTime(toIcao(home), bestSwapIcao);
          if (drive) {
            if (drive.estimated_drive_minutes < minDriveMin) minDriveMin = drive.estimated_drive_minutes;
            if (drive.straight_line_miles < minDriveMiles) minDriveMiles = drive.straight_line_miles;
          }
        }

        let entryCost = viable ? best!.cost_estimate : 999;
        // Add early/late volunteer bonus to cost
        if ((poolEntry.early_volunteer || poolEntry.late_volunteer) && !poolEntry.is_skillbridge) {
          const bonus = role === "PIC" ? EARLY_LATE_BONUS_PIC : EARLY_LATE_BONUS_SIC;
          if (viable) entryCost += bonus;
        }

        // Look up cheapest offgoing route from this swap airport back home
        let offgoingCost = 0;
        if (preComputedOffgoing && crewMember?.id) {
          const offRoutes = preComputedOffgoing.get(crewMember.id) ?? [];
          const offRelevant = offRoutes
            .filter((r) => tailSwapIcaos.has(r.destination_icao.toUpperCase()) && r.score > 0)
            .sort((a, b) => a.cost_estimate - b.cost_estimate);
          offgoingCost = offRelevant[0]?.cost_estimate ?? 0;
        }
        const totalCost = entryCost + offgoingCost;

        const entryScore = best?.score ?? 0;

        // Weighted rank uses TOTAL round-trip cost (oncoming + offgoing)
        const crewDiff = getCrewDifficulty(homeAirports);
        const costNorm = Math.min(100, (totalCost / 800) * 50); // scale for round-trip
        const reliabilityNorm = 100 - entryScore;
        const proximityNorm = Math.min(100, (minDriveMin / 300) * 50);
        let rank = costNorm * 0.30 + reliabilityNorm * 0.25 + proximityNorm * 0.30 + crewDiff * 0.15;

        // Checkairman conservation: strongly avoid auto-assigning checkairmen unless needed.
        const crewMemberObj = crewRoster.find((c) => c.name === poolEntry.name && c.role === role);
        if (crewMemberObj?.is_checkairman) {
          rank += 30; // strong avoidance — prefer non-checkairmen unless last resort
          // If checkairman_types is set, block assignment to non-matching tail types
          if (crewMemberObj.checkairman_types.length > 0) {
            const tailTypeNorm = acType.toLowerCase().replace(/[\s_-]/g, "");
            const typesMatch = crewMemberObj.checkairman_types.some(
              (ct) => tailTypeNorm.includes(ct.toLowerCase().replace(/[\s_-]/g, ""))
                || ct.toLowerCase().replace(/[\s_-]/g, "").includes(tailTypeNorm),
            );
            if (!typesMatch) {
              rank += 50; // effectively block wrong-type tail assignment
            }
          }
        }

        // Standby rotation preference: crew who've been on standby a lot deserve an assignment
        const standbyCount = crewRoster.find((c) => c.name === poolEntry.name)?.standby_count ?? 0;
        if (standbyCount >= 3) rank -= 5;  // Strong preference for crew who've been standby 3+ times
        else if (standbyCount >= 1) rank -= 2;  // Mild preference

        // Volunteer preference: crew who volunteered should be preferred
        if (poolEntry.early_volunteer) rank -= 3;  // Volunteers should be used
        if (poolEntry.late_volunteer) rank -= 3;

        // SIC same-swap-point preference: penalize SIC rank when their best swap point
        // differs from the PIC's assigned swap point on this tail. Prevents split swaps.
        if (role === "SIC" && picSwapPoints) {
          const picSp = picSwapPoints.get(tail);
          if (picSp && bestSwapIcao && picSp.toUpperCase() !== bestSwapIcao.toUpperCase()) {
            rank += 15; // strong preference to match PIC's swap point
          }
        }

        if (!viable) {
          // Track why: no relevant routes to this tail's swap points, or all routes scored 0
          rejections.push({
            crewName: poolEntry.name,
            tail,
            reason: relevantRoutes.length === 0 ? "no_route" : "route_score_zero",
          });
        }

        matrix.push({
          crewName: poolEntry.name,
          tail,
          viable,
          bestScore: entryScore,
          bestCost: entryCost,
          offgoingCost,
          totalCost,
          bestType: best?.route_type ?? "none",
          candidateCount: viableRoutes.length,
          rank,
          bestSwapIcao,
          minDriveMiles,
        });
        continue;
      }

      // ── RUNTIME EVALUATION PATH ───────────────────────────────────────
      // Quick viability check first: skip buildCandidates entirely if no
      // flights exist for any home→swap pair in the HasData map AND no
      // ground transport is possible. This avoids ~6000 buildCandidates calls.
      let hasAnyRoute = false;
      const swapIatas = new Set(swapPointsToTry.map((sp) => {
        const comms = findAllCommercialAirports(sp.icao, aliases);
        return comms.map((c) => toIata(c));
      }).flat());

      // Check ground transport first (cheap check)
      for (const home of homeAirports) {
        for (const sp of swapPointsToTry) {
          const drive = estimateDriveTime(toIcao(home), sp.icao);
          if (drive && drive.estimated_drive_minutes <= effectiveRentalMax) {
            hasAnyRoute = true;
            break;
          }
        }
        if (hasAnyRoute) break;
      }

      // Check flight map if no ground route — expand FBO homes to commercial
      if (!hasAnyRoute && commercialFlights) {
        for (const home of homeAirports) {
          const homeIcao = toIcao(home);
          // Expand non-commercial home airports to nearby commercial (same as buildCandidates)
          const homeSearchIatas = [toIata(home)];
          if (!isCommercialAirport(homeIcao)) {
            const nearbyComm = findAllCommercialAirports(homeIcao, aliases);
            for (const nc of nearbyComm) homeSearchIatas.push(toIata(nc));
          }
          for (const originIata of homeSearchIatas) {
            for (const destIata of swapIatas) {
              if (lookupFlights(commercialFlights, originIata, destIata, swapDate).length > 0) {
                hasAnyRoute = true; break;
              }
            }
            if (hasAnyRoute) break;
          }
          if (hasAnyRoute) break;
        }
      }

      if (!hasAnyRoute) {
        // No possible route — skip expensive buildCandidates
        matrix.push({
          crewName: poolEntry.name, tail, viable: false,
          bestScore: 0, bestCost: 999, offgoingCost: 0, totalCost: 999,
          bestType: "none", candidateCount: 0, rank: 100,
          bestSwapIcao: swapPoints[0]?.icao ?? "", minDriveMiles: 9999,
        });
        rejections.push({ crewName: poolEntry.name, tail, reason: "no_route" });
        continue;
      }

      let allCandidates: TransportCandidate[] = [];

      for (const sp of swapPointsToTry) {
        // Cache key: home airports + swap point ICAO (crew at the same home get identical candidates)
        const cacheKey = `${[...homeAirports].sort().join(",")}->${sp.icao}`;
        let spCandidates = candidateCache.get(cacheKey);

        if (!spCandidates) {
          const task: CrewTask = {
            name: poolEntry.name, crewMember, role, direction: "oncoming",
            tail, aircraftType: acType, swapPoint: sp, homeAirports,
            candidates: [], best: null, warnings: [],
            earlyVolunteer: poolEntry.early_volunteer,
            lateVolunteer: poolEntry.late_volunteer,
          };
          spCandidates = buildCandidates(task, aliases, commercialFlights, swapDate, byTail.get(tail));
          candidateCache.set(cacheKey, spCandidates);
        }

        // Clone and score (scores depend on the specific crew member, not just the route)
        const task: CrewTask = {
          name: poolEntry.name, crewMember, role, direction: "oncoming",
          tail, aircraftType: acType, swapPoint: sp, homeAirports,
          candidates: [], best: null, warnings: [],
          earlyVolunteer: poolEntry.early_volunteer,
          lateVolunteer: poolEntry.late_volunteer,
        };
        const scored = spCandidates.map((c) => ({ ...c, score: scoreCandidate(c, task, null) }));
        allCandidates.push(...scored);
      }

      // Deduplicate: keep only the best-scoring version of each candidate
      const candidates = allCandidates;

      // Add early/late volunteer bonus to cost (Skill-Bridge excluded)
      if ((poolEntry.early_volunteer || poolEntry.late_volunteer) && !poolEntry.is_skillbridge) {
        const bonus = role === "PIC" ? EARLY_LATE_BONUS_PIC : EARLY_LATE_BONUS_SIC;
        for (const c of candidates) {
          if (c.type !== "none") c.cost += bonus;
        }
      }

      // Filter by offgoing deadline — same check as optimizeTail Step 2.
      // If offgoing crew must leave by 9am and no oncoming arrives before that, not viable.
      if (offgoingDeadlines) {
        const dl = offgoingDeadlines.find((d) => d.tail === tail && d.role === role);
        if (dl) {
          const deadlineMs = dl.deadline.getTime();
          const meetsDeadline = candidates.filter((c) =>
            c.type !== "none" && c.fboArrivalTime && c.fboArrivalTime.getTime() <= deadlineMs,
          );
          if (meetsDeadline.length > 0) {
            // Keep only candidates that arrive before the offgoing deadline
            const noneCandidate = candidates.find((c) => c.type === "none");
            candidates.length = 0;
            candidates.push(...meetsDeadline);
            if (noneCandidate) candidates.push(noneCandidate);
          } else {
            // No candidate beats the offgoing deadline — penalize but keep them
            // (user can manually coordinate a slightly late handoff)
            for (const c of candidates) {
              if (c.type !== "none") c.score = Math.max(1, c.score - 20);
            }
          }
        }
      }

      // Candidates already scored in the swap-point loop above
      candidates.sort((a, b) => b.score - a.score);

      const best = candidates[0];
      const viable = best ? best.type !== "none" : false;

      // Determine which swap point the best candidate targets.
      // The candidate's "to" is the COMMERCIAL airport (e.g., SFO), but we need the
      // actual swap point ICAO (e.g., KAPC) for buildSwapPlan to match correctly.
      let bestSwapIcao = swapPoints[0]?.icao ?? "";
      if (best?.to) {
        const bestToIcao = toIcao(best.to);
        // Find which swap point this commercial airport serves
        for (const sp of swapPointsToTry) {
          const comms = findAllCommercialAirports(sp.icao, aliases);
          if (comms.some((c) => c.toUpperCase() === bestToIcao.toUpperCase()) || sp.icao.toUpperCase() === bestToIcao.toUpperCase()) {
            bestSwapIcao = sp.icao;
            break;
          }
        }
      }

      // Compute proximity: min drive time from any home airport to the best swap point
      let minDriveMin = 999;
      let minDriveMiles = 9999;
      if (bestSwapIcao) {
        for (const home of homeAirports) {
          const drive = estimateDriveTime(toIcao(home), bestSwapIcao);
          if (drive) {
            if (drive.estimated_drive_minutes < minDriveMin) minDriveMin = drive.estimated_drive_minutes;
            if (drive.straight_line_miles < minDriveMiles) minDriveMiles = drive.straight_line_miles;
          }
        }
      }

      const entryCost = viable ? best!.cost : 999;
      const entryScore = best?.score ?? 0;

      // Look up offgoing cost (runtime path — estimate from drive distance)
      let offgoingCost = 0;
      if (viable && minDriveMiles < 9999) {
        // Rough estimate: offgoing mirrors oncoming ground cost
        offgoingCost = minDriveMin <= 60
          ? Math.max(25, Math.round(minDriveMiles * 2.0))  // uber
          : 80 + Math.round(minDriveMiles * 0.50);          // rental
      }
      const totalCost = entryCost + offgoingCost;

      const costNorm = Math.min(100, (totalCost / 800) * 50);
      const reliabilityNorm = 100 - entryScore;
      const proximityNorm = Math.min(100, (minDriveMin / 300) * 50);
      const crewDiff = getCrewDifficulty(homeAirports);
      let rank = costNorm * 0.30 + reliabilityNorm * 0.25 + proximityNorm * 0.30 + crewDiff * 0.15;

      // Checkairman conservation (same as pre-computed path)
      const crewMemberObj2 = crewRoster.find((c) => c.name === poolEntry.name && c.role === role);
      if (crewMemberObj2?.is_checkairman) {
        rank += 30; // strong avoidance — prefer non-checkairmen unless last resort
        // If checkairman_types is set, block assignment to non-matching tail types
        if (crewMemberObj2.checkairman_types.length > 0) {
          const tailTypeNorm = acType.toLowerCase().replace(/[\s_-]/g, "");
          const typesMatch = crewMemberObj2.checkairman_types.some(
            (ct) => tailTypeNorm.includes(ct.toLowerCase().replace(/[\s_-]/g, ""))
              || ct.toLowerCase().replace(/[\s_-]/g, "").includes(tailTypeNorm),
          );
          if (!typesMatch) {
            rank += 50; // effectively block wrong-type tail assignment
          }
        }
      }

      // Standby rotation preference (same as pre-computed path)
      const standbyCount2 = crewRoster.find((c) => c.name === poolEntry.name)?.standby_count ?? 0;
      if (standbyCount2 >= 3) rank -= 5;  // Strong preference for crew who've been standby 3+ times
      else if (standbyCount2 >= 1) rank -= 2;  // Mild preference

      // Volunteer preference (same as pre-computed path)
      if (poolEntry.early_volunteer) rank -= 3;  // Volunteers should be used
      if (poolEntry.late_volunteer) rank -= 3;

      // SIC same-swap-point preference (same as pre-computed path)
      if (role === "SIC" && picSwapPoints) {
        const picSp = picSwapPoints.get(tail);
        const sicBestSwap = best?.to ? toIcao(best.to) : (swapPoints[0]?.icao ?? "");
        if (picSp && sicBestSwap && picSp.toUpperCase() !== sicBestSwap.toUpperCase()) {
          rank += 15;
        }
      }

      if (!viable) {
        // Had routes but all candidates scored poorly (runtime path)
        rejections.push({ crewName: poolEntry.name, tail, reason: "route_score_zero" });
      }

      matrix.push({
        crewName: poolEntry.name,
        tail,
        viable,
        bestScore: entryScore,
        bestCost: entryCost,
        offgoingCost,
        totalCost,
        bestType: best?.type ?? "none",
        candidateCount: candidates.filter((c) => c.type !== "none").length,
        rank,
        bestSwapIcao,
        minDriveMiles,
      });
    }
  }

  const viableCount = matrix.filter((m) => m.viable).length;
  const totalCombos = matrix.length;
  const uniqueTails = new Set(matrix.filter((m) => m.viable).map((m) => m.tail)).size;
  const uniqueCrew = new Set(matrix.filter((m) => m.viable).map((m) => m.crewName)).size;
  console.log(`[FeasMatrix] ${role}: ${viableCount}/${totalCombos} viable combos, ${uniqueTails} tails w/viable crew, ${uniqueCrew} crew w/viable tails`);

  // Log constrained CREW (1-2 viable tails) — these get assigned first
  const viableByCrew = new Map<string, FeasibilityEntry[]>();
  for (const m of matrix.filter((e) => e.viable)) {
    if (!viableByCrew.has(m.crewName)) viableByCrew.set(m.crewName, []);
    viableByCrew.get(m.crewName)!.push(m);
  }
  for (const [crew, entries] of viableByCrew) {
    if (entries.length <= 2) {
      const tailList = entries.map((e) => `${e.tail}(${e.bestType} $${Math.round(e.bestCost)}+$${Math.round(e.offgoingCost)}=$${Math.round(e.totalCost)} rank=${e.rank.toFixed(1)})`).join(", ");
      console.log(`[FeasMatrix] CONSTRAINED ${role} crew ${crew}: only ${entries.length} viable tails — ${tailList}`);
    }
  }

  // Also log constrained tails (1-2 viable crew)
  const viableByTail = new Map<string, FeasibilityEntry[]>();
  for (const m of matrix.filter((e) => e.viable)) {
    if (!viableByTail.has(m.tail)) viableByTail.set(m.tail, []);
    viableByTail.get(m.tail)!.push(m);
  }
  for (const [tail, entries] of viableByTail) {
    if (entries.length <= 2) {
      const crewList = entries.map((e) => `${e.crewName}(${e.bestType} $${Math.round(e.totalCost)} rank=${e.rank.toFixed(1)} ${Math.round(e.minDriveMiles)}mi)`).join(", ");
      console.log(`[FeasMatrix] CONSTRAINED ${role} tail ${tail}: only ${entries.length} viable crew — ${crewList}`);
    }
  }

  // ── Diagnostic summary: tails with 0 viable crew ────────────────────────
  const allTailsInMatrix = new Set(matrix.map((m) => m.tail));
  for (const tail of allTailsInMatrix) {
    const tailViable = viableByTail.get(tail);
    if (!tailViable || tailViable.length === 0) {
      const tailRejections = rejections.filter((r) => r.tail === tail);
      const typeMismatch = tailRejections.filter((r) => r.reason === "type_mismatch").length;
      const intlRestricted = tailRejections.filter((r) => r.reason === "intl_restricted").length;
      const noRoute = tailRejections.filter((r) => r.reason === "no_route").length;
      const routeScoreZero = tailRejections.filter((r) => r.reason === "route_score_zero").length;
      const totalChecked = matrix.filter((m) => m.tail === tail).length;
      console.log(
        `[FeasMatrix] ZERO VIABLE ${role} for ${tail}: ` +
        `${totalChecked} crew checked — ` +
        `${typeMismatch} type_mismatch, ${intlRestricted} intl_restricted, ` +
        `${noRoute} no_route, ${routeScoreZero} route_score_zero`
      );
    }
  }

  return { matrix, rejections };
}

/**
 * Assign oncoming crew from pool to tails using TRANSPORT-FIRST approach.
 * Instead of estimating costs with a heuristic, we run the full transport
 * evaluation (buildCandidates + scoring) for every crew × tail combination,
 * then assign based on proven feasibility.
 */
export function assignOncomingCrew(params: {
  swapAssignments: Record<string, SwapAssignment>;
  oncomingPool: OncomingPool;
  crewRoster: CrewMember[];
  flights: FlightLeg[];
  swapDate: string;
  aliases?: AirportAlias[];
  commercialFlights?: Map<string, FlightOffer[]>;
  preComputedRoutes?: Map<string, PilotRoute[]>;
  preComputedOffgoing?: Map<string, PilotRoute[]>;
  excludeTails?: Set<string>;
  offgoingDeadlines?: OncomingDeadline[];
  relaxation?: boolean;
  constraints?: SwapConstraint[];
  /** When set, only force_pair constraints matching this day (or day-agnostic) are applied */
  currentSwapDay?: string;
}): {
  assignments: Record<string, SwapAssignment>;
  standby: { pic: string[]; sic: string[] };
  details: { name: string; tail: string; cost: number; reason: string }[];
  rejections: FeasibilityRejection[];
} {
  const { swapAssignments, oncomingPool, crewRoster, flights, swapDate, aliases = [], commercialFlights, preComputedRoutes, preComputedOffgoing, excludeTails, offgoingDeadlines, relaxation, constraints, currentSwapDay } = params;
  const result: Record<string, SwapAssignment> = JSON.parse(JSON.stringify(swapAssignments));
  const details: { name: string; tail: string; cost: number; reason: string }[] = [];
  const allRejections: FeasibilityRejection[] = [];

  // Group flights by tail (needed for extractSwapPoints)
  const byTail = new Map<string, FlightLeg[]>();
  for (const f of flights) {
    if (!f.tail_number) continue;
    if (!byTail.has(f.tail_number)) byTail.set(f.tail_number, []);
    byTail.get(f.tail_number)!.push(f);
  }
  for (const [, legs] of byTail) {
    legs.sort((a, b) => new Date(a.scheduled_departure).getTime() - new Date(b.scheduled_departure).getTime());
  }

  // Determine aircraft types for all tails — check offgoing, oncoming, and flight legs
  const tailAircraftType = new Map<string, string>();
  for (const tail of Object.keys(result)) {
    const sa = result[tail];
    // Try all assigned crew names to find aircraft type
    const names = [sa.offgoing_pic, sa.offgoing_sic, sa.oncoming_pic, sa.oncoming_sic].filter(Boolean) as string[];
    for (const nm of names) {
      const crew = findCrewByName(crewRoster, nm, "PIC") ?? findCrewByName(crewRoster, nm, "SIC");
      if (crew?.aircraft_types[0]) {
        tailAircraftType.set(tail, crew.aircraft_types[0]);
        break;
      }
    }
    // Fallback: check PIC/SIC from flight legs for this tail
    if (!tailAircraftType.has(tail)) {
      const legs = byTail.get(tail) ?? [];
      for (const leg of legs) {
        const legCrew = (leg.pic ? findCrewByName(crewRoster, leg.pic, "PIC") : null) ??
                        (leg.sic ? findCrewByName(crewRoster, leg.sic, "SIC") : null);
        if (legCrew?.aircraft_types[0]) {
          tailAircraftType.set(tail, legCrew.aircraft_types[0]);
          break;
        }
      }
    }
  }

  // ── Apply constraints: pre-fill forced assignments BEFORE bipartite matching ──
  const forcedPicNames = new Set<string>();
  const forcedSicNames = new Set<string>();
  const forceFleetFilter = new Map<string, string>(); // crew_name → aircraft_type
  const forcePairs: { crew_a: string; crew_b: string; reason?: string }[] = [];

  if (constraints && constraints.length > 0) {
    for (const c of constraints) {
      if (c.type === "force_tail") {
        // Skip day-specific constraints that don't match the current swap day
        if (c.day && currentSwapDay && c.day !== currentSwapDay) {
          console.log(`[Constraint] force_tail: "${c.crew_name}" → ${c.tail} SKIPPED (day=${c.day}, current=${currentSwapDay})`);
          continue;
        }
        const crewMember = crewRoster.find((cr) => cr.name === c.crew_name);
        if (!crewMember) {
          console.log(`[Constraint] force_tail: crew "${c.crew_name}" not found in roster — skipping`);
          continue;
        }
        if (!result[c.tail]) {
          console.log(`[Constraint] force_tail: tail "${c.tail}" not in swap assignments — skipping`);
          continue;
        }
        const field: "oncoming_pic" | "oncoming_sic" = crewMember.role === "PIC" ? "oncoming_pic" : "oncoming_sic";
        // Clear any existing assignment for this crew from other tails
        for (const [tail, sa] of Object.entries(result)) {
          if (sa[field] === c.crew_name && tail !== c.tail) sa[field] = null;
        }
        result[c.tail][field] = c.crew_name;
        if (crewMember.role === "PIC") forcedPicNames.add(c.crew_name);
        else forcedSicNames.add(c.crew_name);
        const reason = `FORCED to ${c.tail}${c.day ? ` (${c.day})` : ""}${c.reason ? ` (${c.reason})` : ""}`;
        details.push({ name: c.crew_name, tail: c.tail, cost: 0, reason });
        console.log(`[Constraint] force_tail: ${crewMember.role} "${c.crew_name}" → ${c.tail}${c.day ? ` (${c.day})` : ""}${c.reason ? ` (${c.reason})` : ""}`);
      } else if (c.type === "force_fleet") {
        // Skip day-specific constraints that don't match the current swap day
        if (c.day && currentSwapDay && c.day !== currentSwapDay) {
          console.log(`[Constraint] force_fleet: "${c.crew_name}" → ${c.aircraft_type} SKIPPED (day=${c.day}, current=${currentSwapDay})`);
          continue;
        }
        forceFleetFilter.set(c.crew_name, c.aircraft_type);
        console.log(`[Constraint] force_fleet: "${c.crew_name}" locked to ${c.aircraft_type}${c.day ? ` (${c.day})` : ""}${c.reason ? ` (${c.reason})` : ""}`);
      } else if (c.type === "force_pair") {
        // Skip day-specific pairs that don't match the current swap day
        if (c.day && currentSwapDay && c.day !== currentSwapDay) {
          console.log(`[Constraint] force_pair: "${c.crew_a}" + "${c.crew_b}" SKIPPED (day=${c.day}, current=${currentSwapDay})`);
          continue;
        }
        forcePairs.push({ crew_a: c.crew_a, crew_b: c.crew_b, reason: c.reason });
        console.log(`[Constraint] force_pair: "${c.crew_a}" + "${c.crew_b}"${c.day ? ` (${c.day})` : ""}${c.reason ? ` (${c.reason})` : ""}`);
      }
    }
  }

  // Filter pools to exclude force_tail crew (already assigned)
  const filteredPicPool = oncomingPool.pic.filter((p) => !forcedPicNames.has(p.name));
  const filteredSicPool = oncomingPool.sic.filter((p) => !forcedSicNames.has(p.name));

  // Assign PICs then SICs using feasibility matrix
  const picRejections = assignRoleWithMatrix("oncoming_pic", filteredPicPool, "PIC", result, byTail, swapDate, aliases, commercialFlights, crewRoster, tailAircraftType, details, preComputedRoutes, preComputedOffgoing, excludeTails, offgoingDeadlines, undefined, relaxation, undefined, forceFleetFilter);
  allRejections.push(...picRejections);

  // PIC swap point fallback: if any PIC tails are unsolved (no viable crew at the
  // "best" swap point), retry with ALL swap points. This handles cases like N555FX
  // where TPA (ease=-55) was picked but has a 7 AM departure — APC (ease=-92) is
  // reachable but wasn't tried because PIC normally only tries the best swap point.
  const unsolvedPicTails = Object.keys(result).filter((tail) =>
    !result[tail].oncoming_pic && !excludeTails?.has(tail)
  );
  if (unsolvedPicTails.length > 0) {
    console.log(`[SwapPointFallback] ${unsolvedPicTails.length} PIC tails unsolved — retrying with ALL swap points: ${unsolvedPicTails.join(", ")}`);
    const fallbackRejections = assignRoleWithMatrix(
      "oncoming_pic", filteredPicPool, "PIC", result, byTail, swapDate, aliases,
      commercialFlights, crewRoster, tailAircraftType, details, preComputedRoutes,
      preComputedOffgoing, new Set([...Object.keys(result).filter(t => result[t].oncoming_pic), ...(excludeTails ?? [])]),
      offgoingDeadlines, undefined, relaxation, true,  // swapPointFallback = true
      forceFleetFilter,
    );
    allRejections.push(...fallbackRejections);
  }

  // ── Apply force_pair constraints: lock paired crew onto the same tail ──
  // After PIC assignment, if crew_a (PIC) is assigned, force crew_b (SIC) to same tail.
  // Also handles the reverse: if crew_b is a PIC, force crew_a (SIC) to their tail.
  for (const pair of forcePairs) {
    // Find which one is assigned as PIC
    let picTail: string | null = null;
    let sicName: string | null = null;
    for (const [tail, sa] of Object.entries(result)) {
      if (sa.oncoming_pic === pair.crew_a) { picTail = tail; sicName = pair.crew_b; break; }
      if (sa.oncoming_pic === pair.crew_b) { picTail = tail; sicName = pair.crew_a; break; }
    }
    if (!picTail || !sicName) {
      console.log(`[Constraint] force_pair: neither "${pair.crew_a}" nor "${pair.crew_b}" assigned as PIC — skipping`);
      continue;
    }
    // Remove SIC from wherever they're currently assigned
    for (const [, sa] of Object.entries(result)) {
      if (sa.oncoming_sic === sicName) sa.oncoming_sic = null;
    }
    result[picTail].oncoming_sic = sicName;
    forcedSicNames.add(sicName);
    const reason = `FORCED pair with ${result[picTail].oncoming_pic}${pair.reason ? ` (${pair.reason})` : ""}`;
    details.push({ name: sicName, tail: picTail, cost: 0, reason });
    console.log(`[Constraint] force_pair: SIC "${sicName}" → ${picTail} with PIC "${result[picTail].oncoming_pic}"${pair.reason ? ` (${pair.reason})` : ""}`);
  }

  // Re-filter SIC pool after force_pair (may have added to forcedSicNames)
  const finalSicPool = filteredSicPool.filter((p) => !forcedSicNames.has(p.name));

  // Build PIC swap point map for SIC same-swap-point preference
  const picSwapPoints = new Map<string, string>();
  for (const [tail, sa] of Object.entries(result)) {
    if (sa.oncoming_pic_swap_icao) picSwapPoints.set(tail, sa.oncoming_pic_swap_icao);
  }

  const sicRejections = assignRoleWithMatrix("oncoming_sic", finalSicPool, "SIC", result, byTail, swapDate, aliases, commercialFlights, crewRoster, tailAircraftType, details, preComputedRoutes, preComputedOffgoing, excludeTails, offgoingDeadlines, picSwapPoints, relaxation, undefined, forceFleetFilter);
  allRejections.push(...sicRejections);

  // Remaining pool → standby
  // SkillBridge SICs go first for forced standby, then sort by standby_count (lowest first)
  const assignedNames = new Set(details.map((d) => d.name));
  const unassignedPics = oncomingPool.pic.filter((p) => !assignedNames.has(p.name));
  const unassignedSics = oncomingPool.sic.filter((p) => !assignedNames.has(p.name));

  // Sort SICs: SkillBridge first, then by standby_count ascending (rotate through all crew)
  unassignedSics.sort((a, b) => {
    // SkillBridge always goes first for forced standby
    if (a.is_skillbridge && !b.is_skillbridge) return -1;
    if (!a.is_skillbridge && b.is_skillbridge) return 1;
    // Then by standby count (fewer standbys = higher priority for next standby)
    const aCount = crewRoster.find((c) => c.name === a.name)?.standby_count ?? 0;
    const bCount = crewRoster.find((c) => c.name === b.name)?.standby_count ?? 0;
    return aCount - bCount;
  });

  // PICs: sort by standby_count ascending (rotate through all)
  unassignedPics.sort((a, b) => {
    const aCount = crewRoster.find((c) => c.name === a.name)?.standby_count ?? 0;
    const bCount = crewRoster.find((c) => c.name === b.name)?.standby_count ?? 0;
    return aCount - bCount;
  });

  const standby = {
    pic: unassignedPics.map((p) => p.name),
    sic: unassignedSics.map((p) => p.name),
  };

  return { assignments: result, standby, details, rejections: allRejections };
}

/**
 * Two-pass optimizer: first try normal Wednesday-only candidates, then pull
 * early/late volunteers only for tails that can't be solved.
 * Saves $1500/PIC and $1000/SIC bonuses by using volunteers sparingly.
 */
export function twoPassAssignAndOptimize(params: {
  swapAssignments: Record<string, SwapAssignment>;
  oncomingPool: OncomingPool;
  crewRoster: CrewMember[];
  flights: FlightLeg[];
  swapDate: string;
  aliases: AirportAlias[];
  commercialFlights?: Map<string, FlightOffer[]>;
  preComputedRoutes?: Map<string, PilotRoute[]>;
  preComputedOffgoing?: Map<string, PilotRoute[]>;
  excludeTails?: Set<string>;
  offgoingDeadlines?: OncomingDeadline[];
  constraints?: SwapConstraint[];
  /** When set, only force_pair constraints matching this day (or day-agnostic) are applied */
  currentSwapDay?: string;
}): {
  result: SwapPlanResult;
  assignmentResult: ReturnType<typeof assignOncomingCrew>;
  twoPassStats: TwoPassStats;
} {
  const { swapAssignments, oncomingPool, crewRoster, flights, swapDate, aliases, commercialFlights, preComputedRoutes, preComputedOffgoing, excludeTails, offgoingDeadlines, constraints, currentSwapDay } = params;

  // ── Pass 1: Use FULL pool (volunteers included) ──────────────────────
  // Previously excluded early/late volunteers from Pass 1 to save bonuses,
  // but this gutted the pool by ~50% when many crew are volunteers, causing
  // far worse results. Now we use the full pool and track which assignments
  // used volunteers so we can compute bonus costs accurately.
  const normalPool = oncomingPool;

  const pass1Assignment = assignOncomingCrew({
    swapAssignments,
    oncomingPool: normalPool,
    crewRoster,
    flights,
    swapDate,
    aliases,
    commercialFlights,
    preComputedRoutes,
    preComputedOffgoing,
    excludeTails,
    offgoingDeadlines,
    constraints,
    currentSwapDay,
  });

  const pass1Result = buildSwapPlan({
    flights, crewRoster, aliases, swapDate, commercialFlights,
    swapAssignments: pass1Assignment.assignments,
    oncomingPool: normalPool,
    strategy: "offgoing_first",
  });

  const pass1Solved = pass1Result.solved_count;
  const pass1Unsolved = pass1Result.unsolved_count;
  const pass1Cost = pass1Result.total_cost;

  // ── Identify unsolvable tails from Pass 1 ────────────────────────────
  const unsolvedRows = pass1Result.rows.filter((r) => r.travel_type === "none");
  const unsolvedTails = new Set(unsolvedRows.map((r) => r.tail_number));

  // If everything solved in pass 1, return early — no bonuses needed
  if (unsolvedTails.size === 0) {
    const stats: TwoPassStats = {
      pass1_solved: pass1Solved,
      pass1_unsolved: 0,
      pass1_cost: pass1Cost,
      pass2_solved: 0,
      pass2_volunteers_used: [],
      pass2_bonus_cost: 0,
      pass3_solved: 0,
      pass3_standby_used: [],
      pass3_relaxation: false,
      feedback_loop_solved: 0,
      feedback_loop_iterations: 0,
      feedback_loop_swaps: [],
      total_cost: pass1Cost,
    };
    return {
      result: { ...pass1Result, two_pass: stats },
      assignmentResult: pass1Assignment,
      twoPassStats: stats,
    };
  }

  // ── Pass 2: Volunteer bonus tracking ─────────────────────────────────
  // Since Pass 1 now uses the full pool (including volunteers), Pass 2 doesn't
  // re-run assignment. Instead, we just identify which Pass 1 assignments used
  // paid (non-SkillBridge) early/late volunteers so we can compute bonus costs.
  console.log(`[Two-Pass] Pass 1: ${pass1Solved} solved, ${pass1Unsolved} unsolved (${[...unsolvedTails].join(", ")})`);

  const volunteerNames = new Set<string>();
  for (const p of oncomingPool.pic) {
    if ((p.early_volunteer || p.late_volunteer) && !p.is_skillbridge) volunteerNames.add(p.name);
  }
  for (const p of oncomingPool.sic) {
    if ((p.early_volunteer || p.late_volunteer) && !p.is_skillbridge) volunteerNames.add(p.name);
  }

  // Pass 2 is now a no-op (same pool). Reuse pass 1 results directly.
  const fullPool = normalPool;
  const pass2Assignment = pass1Assignment;
  const pass2Assignments = pass1Assignment.assignments;

  // Merge pass 2 results into pass 1: only replace unsolved tails
  // Since Pass 1 now uses full pool, mergedAssignments = pass1 assignments
  const mergedAssignments = { ...pass1Assignment.assignments };

  // Identify which assigned crew are paid volunteers (for bonus tracking)
  const volunteersUsed: TwoPassStats["pass2_volunteers_used"] = [];
  for (const [tail, sa] of Object.entries(mergedAssignments)) {
    if (sa.oncoming_pic && volunteerNames.has(sa.oncoming_pic)) {
      const entry = oncomingPool.pic.find((p) => p.name === sa.oncoming_pic);
      volunteersUsed.push({
        name: sa.oncoming_pic, role: "PIC", tail,
        type: entry?.early_volunteer ? "early" : "late",
      });
    }
    if (sa.oncoming_sic && volunteerNames.has(sa.oncoming_sic)) {
      const entry = oncomingPool.sic.find((p) => p.name === sa.oncoming_sic);
      volunteersUsed.push({
        name: sa.oncoming_sic, role: "SIC", tail,
        type: entry?.early_volunteer ? "early" : "late",
      });
    }
  }

  // Compute bonus cost
  const bonusCost = volunteersUsed.reduce((sum, v) => {
    if (v.role === "PIC") return sum + EARLY_LATE_BONUS_PIC;
    return sum + EARLY_LATE_BONUS_SIC;
  }, 0);

  // Run transport optimizer after pass 2 merges
  const pass2Result = buildSwapPlan({
    flights, crewRoster, aliases, swapDate, commercialFlights,
    swapAssignments: mergedAssignments,
    oncomingPool: fullPool,
    strategy: "offgoing_first",
  });

  const pass2NewlySolved = pass1Unsolved - pass2Result.unsolved_count;

  // Merge standby from both passes
  let mergedStandby = {
    pic: pass2Assignment.standby.pic,
    sic: pass2Assignment.standby.sic,
  };

  console.log(`[Two-Pass] Pass 2: ${pass2NewlySolved} additional tails solved, ${volunteersUsed.length} volunteers used, $${bonusCost} bonus cost`);

  // ── Pass 3: Standby backfill with relaxed constraints ──────────────────
  // Standby crew are currently wasted on unsolved tails. Use them with
  // progressively relaxed constraints (expanded drive limits, reduced buffers).
  const pass2UnsolvedRows = pass2Result.rows.filter((r) => r.travel_type === "none");
  const pass2UnsolvedTails = new Set(pass2UnsolvedRows.map((r) => r.tail_number));
  let pass3Solved = 0;
  const pass3StandbyUsed: { name: string; role: "PIC" | "SIC"; tail: string }[] = [];
  let finalAssignments = mergedAssignments;
  let finalResult = pass2Result;
  let allDetails = [...pass1Assignment.details, ...pass2Assignment.details];
  let pass3Rejections: FeasibilityRejection[] = [];

  if (pass2UnsolvedTails.size > 0 && (mergedStandby.pic.length > 0 || mergedStandby.sic.length > 0)) {
    console.log(`[Pass 3] ${pass2UnsolvedTails.size} tails still unsolved ([${[...pass2UnsolvedTails].join(", ")}]). Trying ${mergedStandby.pic.length} standby PICs + ${mergedStandby.sic.length} standby SICs with relaxed constraints...`);

    // Build standby pool entries from standby names
    const standbyPicPool: OncomingPoolEntry[] = mergedStandby.pic.map((name) => {
      const crew = crewRoster.find((c) => c.name === name);
      return {
        name,
        aircraft_type: crew?.aircraft_types[0] ?? "unknown",
        home_airports: crew?.home_airports ?? [],
        is_skillbridge: crew?.is_skillbridge ?? false,
      } as OncomingPoolEntry;
    });
    const standbySicPool: OncomingPoolEntry[] = mergedStandby.sic.map((name) => {
      const crew = crewRoster.find((c) => c.name === name);
      return {
        name,
        aircraft_type: crew?.aircraft_types[0] ?? "unknown",
        home_airports: crew?.home_airports ?? [],
        is_skillbridge: crew?.is_skillbridge ?? false,
      } as OncomingPoolEntry;
    });

    // Combine standby + full pool (already assigned crew won't match needing tails)
    const pass3Pool: OncomingPool = {
      pic: [...standbyPicPool, ...fullPool.pic],
      sic: [...standbySicPool, ...fullPool.sic],
    };

    // Build pass 3 assignments — start from pass 2 but clear unsolved oncoming slots
    const pass3Assignments: Record<string, SwapAssignment> = JSON.parse(JSON.stringify(mergedAssignments));
    for (const tail of pass2UnsolvedTails) {
      if (pass3Assignments[tail]) {
        const unsolvedPic = pass2UnsolvedRows.some((r) => r.tail_number === tail && r.direction === "oncoming" && r.role === "PIC");
        const unsolvedSic = pass2UnsolvedRows.some((r) => r.tail_number === tail && r.direction === "oncoming" && r.role === "SIC");
        if (unsolvedPic) pass3Assignments[tail].oncoming_pic = null;
        if (unsolvedSic) pass3Assignments[tail].oncoming_sic = null;
      }
    }

    // Run assignment with RELAXED constraints (expanded drive limits, reduced buffers)
    const pass3Assignment = assignOncomingCrew({
      swapAssignments: pass3Assignments,
      oncomingPool: pass3Pool,
      crewRoster,
      flights,
      swapDate,
      aliases,
      commercialFlights,
      preComputedRoutes,
      preComputedOffgoing,
      excludeTails,
      offgoingDeadlines,
      relaxation: true,  // ← use relaxed constraints
    });

    // Merge pass 3 results: only update unsolved tails
    const pass3Merged = { ...mergedAssignments };
    for (const tail of pass2UnsolvedTails) {
      if (pass3Assignment.assignments[tail]) {
        const p3 = pass3Assignment.assignments[tail];
        const prev = pass3Merged[tail];

        if (p3.oncoming_pic && !prev.oncoming_pic) {
          pass3Merged[tail] = { ...prev, oncoming_pic: p3.oncoming_pic, oncoming_pic_swap_icao: p3.oncoming_pic_swap_icao };
          pass3StandbyUsed.push({ name: p3.oncoming_pic, role: "PIC", tail });
        }
        if (p3.oncoming_sic && !pass3Merged[tail].oncoming_sic) {
          pass3Merged[tail] = { ...pass3Merged[tail], oncoming_sic: p3.oncoming_sic, oncoming_sic_swap_icao: p3.oncoming_sic_swap_icao };
          pass3StandbyUsed.push({ name: p3.oncoming_sic, role: "SIC", tail });
        }
      }
    }

    // Run final transport plan with pass 3 merged assignments
    const pass3Result = buildSwapPlan({
      flights, crewRoster, aliases, swapDate, commercialFlights,
      swapAssignments: pass3Merged,
      oncomingPool: pass3Pool,
      strategy: "offgoing_first",
    });

    pass3Solved = pass2Result.unsolved_count - pass3Result.unsolved_count;
    finalAssignments = pass3Merged;
    finalResult = pass3Result;
    allDetails = [...allDetails, ...pass3Assignment.details];
    pass3Rejections = pass3Assignment.rejections;

    // Update standby — remove crew that were used in pass 3
    const usedNames = new Set(pass3StandbyUsed.map((s) => s.name));
    mergedStandby = {
      pic: pass3Assignment.standby.pic.filter((n) => !usedNames.has(n)),
      sic: pass3Assignment.standby.sic.filter((n) => !usedNames.has(n)),
    };

    console.log(`[Pass 3] ${pass3Solved} additional solved via standby backfill (${pass3StandbyUsed.length} standby crew used)`);

    // Add pass 3 warnings
    for (const s of pass3StandbyUsed) {
      finalResult.warnings.push(`${s.name} (${s.role}) pulled from standby for ${s.tail} [relaxed constraints]`);
    }
  }

  // Add volunteer bonus warnings
  for (const v of volunteersUsed) {
    const bonus = v.role === "PIC" ? EARLY_LATE_BONUS_PIC : EARLY_LATE_BONUS_SIC;
    finalResult.warnings.push(`${v.name} (${v.role}) used as ${v.type} volunteer on ${v.tail} — $${bonus} bonus`);
  }

  // ── Cleanup: clear assignments where transport planner found no viable route,
  // OR where crew arrives after the aircraft departs their swap airport ──────
  // The feasibility matrix may have marked crew as viable, but buildSwapPlan's
  // stricter timing checks (swap point retry, FBO arrival buffer) rejected them.
  // Also catches after_live assignments where crew arrives too late for subsequent legs.
  // Clear these so they show as properly unassigned and the feedback loop can try.

  // Build a map of earliest departure from each swap airport per tail
  const byTailForCleanup = new Map<string, FlightLeg[]>();
  for (const f of flights) {
    if (!f.tail_number) continue;
    if (!byTailForCleanup.has(f.tail_number)) byTailForCleanup.set(f.tail_number, []);
    byTailForCleanup.get(f.tail_number)!.push(f);
  }

  const unsolvableRows = finalResult.rows.filter((r) => {
    if (r.direction !== "oncoming" || r.name.startsWith("[UNASSIGNED")) return false;
    // Case 1: no transport found
    if (r.travel_type === "none") return true;
    // Case 2: crew arrives after the aircraft departs their swap airport
    const availTime = r.available_time ?? r.arrival_time;
    if (!availTime || !r.swap_location) return false;
    const availMs = new Date(availTime).getTime();
    const swapIcao = r.swap_location.length === 3 ? `K${r.swap_location}` : r.swap_location;
    const tailLegs = byTailForCleanup.get(r.tail_number) ?? [];
    const wedStr = swapDate;
    // Find earliest departure from swap airport on swap day (skip overnight legs before 6am)
    const depsFromSwap = tailLegs
      .filter((f) => f.departure_icao === swapIcao && f.scheduled_departure?.startsWith(wedStr))
      .map((f) => new Date(f.scheduled_departure).getTime())
      .filter((t) => new Date(t).getUTCHours() >= 6 || new Date(t).getHours() >= 6)
      .sort((a, b) => a - b);
    if (depsFromSwap.length > 0 && availMs > depsFromSwap[0]) {
      return true; // crew arrives after aircraft departs
    }
    return false;
  });
  if (unsolvableRows.length > 0) {
    for (const row of unsolvableRows) {
      const sa = finalAssignments[row.tail_number];
      if (!sa) continue;
      const field = row.role === "PIC" ? "oncoming_pic" : "oncoming_sic";
      if (sa[field] === row.name) {
        console.log(`[Cleanup] Clearing unsolvable ${row.role} ${row.name} from ${row.tail_number} — transport planner found no viable route`);
        sa[field] = null;
      }
    }
    // Rebuild final result with cleared assignments
    finalResult = buildSwapPlan({
      flights, crewRoster, aliases, swapDate, commercialFlights,
      swapAssignments: finalAssignments,
      oncomingPool: fullPool,
      strategy: "offgoing_first",
    });
    // Re-add warnings
    for (const v of volunteersUsed) {
      const bonus = v.role === "PIC" ? EARLY_LATE_BONUS_PIC : EARLY_LATE_BONUS_SIC;
      finalResult.warnings.push(`${v.name} (${v.role}) used as ${v.type} volunteer on ${v.tail} — $${bonus} bonus`);
    }
    for (const s of pass3StandbyUsed) {
      finalResult.warnings.push(`${s.name} (${s.role}) pulled from standby for ${s.tail} [relaxed constraints]`);
    }
    console.log(`[Cleanup] Cleared ${unsolvableRows.length} unsolvable assignments — rebuilt plan`);
  }

  // ── Pass 4: Feedback Loop — iterative reassignment for unsolved tails ────
  // If tails remain unsolved, try stealing assigned crew (especially hub crew
  // with easy Uber assignments) to solve harder tails, as long as the vacated
  // tail can be backfilled. Only accepts swaps that increase total solved count.
  let feedbackLoopSolved = 0;
  let feedbackLoopIterations = 0;
  let feedbackLoopSwaps: TwoPassStats["feedback_loop_swaps"] = [];

  const feedbackUnsolved = finalResult.rows.filter((r) => r.travel_type === "none" && r.direction === "oncoming");
  if (feedbackUnsolved.length > 0) {
    console.log(`[FeedbackLoop] ${feedbackUnsolved.length} oncoming slots still unsolved after Pass 3 — starting feedback loop...`);

    const feedbackResult = runFeedbackLoop({
      assignments: finalAssignments,
      oncomingPool: fullPool,
      crewRoster,
      flights,
      swapDate,
      aliases,
      commercialFlights,
      preComputedRoutes,
      preComputedOffgoing,
      offgoingDeadlines,
      excludeTails,
      standby: mergedStandby,
    });

    feedbackLoopSolved = feedbackResult.solved;
    feedbackLoopIterations = feedbackResult.iterations;
    feedbackLoopSwaps = feedbackResult.swaps;

    if (feedbackResult.solved > 0) {
      // Rebuild the final result with updated assignments
      finalAssignments = feedbackResult.assignments;
      mergedStandby = feedbackResult.standby;

      finalResult = buildSwapPlan({
        flights, crewRoster, aliases, swapDate, commercialFlights,
        swapAssignments: finalAssignments,
        oncomingPool: fullPool,
        strategy: "offgoing_first",
      });

      // Re-add all previous warnings
      for (const v of volunteersUsed) {
        const bonus = v.role === "PIC" ? EARLY_LATE_BONUS_PIC : EARLY_LATE_BONUS_SIC;
        finalResult.warnings.push(`${v.name} (${v.role}) used as ${v.type} volunteer on ${v.tail} — $${bonus} bonus`);
      }
      for (const s of pass3StandbyUsed) {
        finalResult.warnings.push(`${s.name} (${s.role}) pulled from standby for ${s.tail} [relaxed constraints]`);
      }
      // Add feedback loop warnings
      finalResult.warnings.push(...feedbackResult.warnings);

      console.log(`[FeedbackLoop] Complete: ${feedbackLoopSolved} additional solved, ${feedbackLoopIterations} iteration(s), new solved=${finalResult.solved_count} unsolved=${finalResult.unsolved_count}`);
    } else {
      console.log(`[FeedbackLoop] No improvements found — all unsolved tails are genuinely stuck`);
    }
  }

  // ── Improvement 4: Missing flight pairs diagnostic ──────────────────────
  // For still-unsolved oncoming crew, identify specific flight cache gaps
  const stillUnsolved = finalResult.rows.filter((r) => r.travel_type === "none");
  if (stillUnsolved.length > 0) {
    const missingPairs: { origin: string; destination: string; crew: string; tail: string }[] = [];
    for (const row of stillUnsolved) {
      const crew = crewRoster.find((c) => c.name === row.name);
      if (!crew?.home_airports?.length) continue;
      const tailLegs = flights.filter((f) => f.tail_number === row.tail_number);
      const swapIcaos = new Set<string>();
      for (const leg of tailLegs) {
        if (leg.departure_icao) swapIcaos.add(leg.departure_icao);
        if (leg.arrival_icao) swapIcaos.add(leg.arrival_icao);
      }
      for (const home of crew.home_airports) {
        const homeIata = home.length <= 3 ? home : home.substring(1);
        for (const swapIcao of swapIcaos) {
          const swapIata = swapIcao.length === 4 && swapIcao.startsWith("K") ? swapIcao.substring(1) : swapIcao;
          // Find the commercial airports for this swap point
          const comms = findAllCommercialAirports(swapIcao, aliases);
          for (const comm of comms) {
            const commIata = comm.length === 4 && comm.startsWith("K") ? comm.substring(1) : comm;
            if (homeIata !== commIata) {
              if (row.direction === "offgoing") {
                // Offgoing: swap → home (crew needs to get home after the swap)
                missingPairs.push({ origin: commIata, destination: homeIata, crew: row.name, tail: row.tail_number });
              } else {
                // Oncoming: home → swap (crew needs to get to the swap point)
                missingPairs.push({ origin: homeIata, destination: commIata, crew: row.name, tail: row.tail_number });
              }
            }
          }
        }
      }
    }
    // Deduplicate by origin+destination
    const seen = new Set<string>();
    finalResult.missing_flight_pairs = missingPairs.filter((p) => {
      const key = `${p.origin}->${p.destination}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    if (finalResult.missing_flight_pairs.length > 0) {
      console.log(`[FlightGaps] ${finalResult.missing_flight_pairs.length} missing flight pairs identified for ${stillUnsolved.length} unsolved crew`);
    }
  }

  // ── Build diagnostics for unsolved crew/tails ────────────────────────────
  // Collect all rejections from all passes (latest pass has the most complete data)
  const allRejections: FeasibilityRejection[] = [
    ...pass1Assignment.rejections,
    ...pass2Assignment.rejections,
    ...pass3Rejections,
  ];

  // Build tail aircraft type map for diagnostics
  const diagTailAircraftType = new Map<string, string>();
  const diagByTail = new Map<string, FlightLeg[]>();
  for (const f of flights) {
    if (!f.tail_number) continue;
    if (!diagByTail.has(f.tail_number)) diagByTail.set(f.tail_number, []);
    diagByTail.get(f.tail_number)!.push(f);
  }
  for (const tail of Object.keys(finalAssignments)) {
    const sa = finalAssignments[tail];
    const names = [sa.offgoing_pic, sa.offgoing_sic, sa.oncoming_pic, sa.oncoming_sic].filter(Boolean) as string[];
    for (const nm of names) {
      const crew = crewRoster.find((c) => (c.name === nm || c.jetinsight_name === nm));
      if (crew?.aircraft_types[0]) {
        diagTailAircraftType.set(tail, crew.aircraft_types[0]);
        break;
      }
    }
  }

  const finalUnsolved = finalResult.rows.filter((r) => r.travel_type === "none");
  let diagnostics: SwapPlanResult["diagnostics"];

  if (finalUnsolved.length > 0) {
    // Unsolved tails: for each unsolved row, summarize rejection reasons
    const unsolvedTailDiags: NonNullable<SwapPlanResult["diagnostics"]>["unsolved_tails"] = [];
    for (const row of finalUnsolved) {
      if (row.direction !== "oncoming") continue; // offgoing diagnostics less relevant
      const tailRejections = allRejections.filter((r) => r.tail === row.tail_number);
      // Deduplicate by crewName (take latest rejection per crew member)
      const byCrewName = new Map<string, FeasibilityRejection>();
      for (const r of tailRejections) byCrewName.set(r.crewName, r);
      const dedupedRejections = Array.from(byCrewName.values());

      const typeMismatch = dedupedRejections.filter((r) => r.reason === "type_mismatch").length;
      const intlRestricted = dedupedRejections.filter((r) => r.reason === "intl_restricted").length;
      const noRoute = dedupedRejections.filter((r) => r.reason === "no_route").length;
      const routeScoreZero = dedupedRejections.filter((r) => r.reason === "route_score_zero").length;
      const totalChecked = dedupedRejections.length;

      // Determine primary reason
      let reason = "unknown";
      if (typeMismatch > 0 && typeMismatch === totalChecked) {
        reason = `All ${totalChecked} crew failed aircraft type check (tail type: ${diagTailAircraftType.get(row.tail_number) ?? "unknown"})`;
      } else if (noRoute > 0 && noRoute + typeMismatch === totalChecked) {
        reason = `${typeMismatch} type mismatch + ${noRoute} no transport route available`;
      } else if (totalChecked === 0) {
        reason = "No crew in pool for this role";
      } else {
        const parts: string[] = [];
        if (typeMismatch > 0) parts.push(`${typeMismatch} type mismatch`);
        if (intlRestricted > 0) parts.push(`${intlRestricted} intl restricted`);
        if (noRoute > 0) parts.push(`${noRoute} no route`);
        if (routeScoreZero > 0) parts.push(`${routeScoreZero} route scored zero`);
        reason = parts.join(", ") || "All crew assigned to other tails (supply exhausted)";
      }

      unsolvedTailDiags.push({
        tail: row.tail_number,
        role: row.role,
        reason,
        type_mismatch_count: typeMismatch,
        no_route_count: noRoute,
        intl_restricted_count: intlRestricted,
        route_score_zero_count: routeScoreZero,
        total_crew_checked: totalChecked,
      });
    }

    // Unsolved crew: for each oncoming pool member not assigned, show why
    const assignedNames = new Set(allDetails.map((d) => d.name));
    const allPoolMembers = [...oncomingPool.pic.map(p => ({ ...p, role: "PIC" as const })), ...oncomingPool.sic.map(p => ({ ...p, role: "SIC" as const }))];
    const unsolvedCrewDiags: NonNullable<SwapPlanResult["diagnostics"]>["unsolved_crew"] = [];
    for (const poolMember of allPoolMembers) {
      if (assignedNames.has(poolMember.name)) continue;
      const crewRejections = allRejections.filter((r) => r.crewName === poolMember.name);
      // Deduplicate by tail
      const byTailMap = new Map<string, FeasibilityRejection>();
      for (const r of crewRejections) byTailMap.set(r.tail, r);
      const dedupedRejections = Array.from(byTailMap.values());

      unsolvedCrewDiags.push({
        name: poolMember.name,
        role: poolMember.role,
        tails_checked: dedupedRejections.length,
        type_mismatch_tails: dedupedRejections.filter((r) => r.reason === "type_mismatch").map((r) => r.tail),
        intl_restricted_tails: dedupedRejections.filter((r) => r.reason === "intl_restricted").map((r) => r.tail),
        no_route_tails: dedupedRejections.filter((r) => r.reason === "no_route").map((r) => r.tail),
        route_score_zero_tails: dedupedRejections.filter((r) => r.reason === "route_score_zero").map((r) => r.tail),
      });
    }

    // Type mismatch blockers: tails where ALL rejections are type mismatch
    const typeMismatchBlockers: NonNullable<SwapPlanResult["diagnostics"]>["type_mismatch_blockers"] = [];
    for (const diag of unsolvedTailDiags) {
      if (diag.type_mismatch_count > 0 && diag.type_mismatch_count === diag.total_crew_checked) {
        const tailType = diagTailAircraftType.get(diag.tail) ?? "unknown";
        // Collect what aircraft types were available in the pool for this role
        const poolForRole = diag.role === "PIC" ? oncomingPool.pic : oncomingPool.sic;
        const crewTypes = [...new Set(poolForRole.map((p) => p.aircraft_type))];
        typeMismatchBlockers.push({
          tail: diag.tail,
          role: diag.role,
          tail_type: tailType,
          crew_types_available: crewTypes,
        });
      }
    }

    diagnostics = {
      unsolved_tails: unsolvedTailDiags,
      unsolved_crew: unsolvedCrewDiags,
      type_mismatch_blockers: typeMismatchBlockers,
    };

    // Log summary
    console.log(`[Diagnostics] ${unsolvedTailDiags.length} unsolved tail slots, ${unsolvedCrewDiags.length} unsolved crew members`);
    for (const d of unsolvedTailDiags) {
      console.log(`[Diagnostics] Tail ${d.tail} ${d.role}: ${d.reason}`);
    }
    if (typeMismatchBlockers.length > 0) {
      console.log(`[Diagnostics] ${typeMismatchBlockers.length} tails blocked purely by type mismatch — cross-type assignment could help`);
    }
  }

  const stats: TwoPassStats = {
    pass1_solved: pass1Solved,
    pass1_unsolved: pass1Unsolved,
    pass1_cost: pass1Cost,
    pass2_solved: pass2NewlySolved,
    pass2_volunteers_used: volunteersUsed,
    pass2_bonus_cost: bonusCost,
    pass3_solved: pass3Solved,
    pass3_standby_used: pass3StandbyUsed,
    pass3_relaxation: pass3Solved > 0,
    feedback_loop_solved: feedbackLoopSolved,
    feedback_loop_iterations: feedbackLoopIterations,
    feedback_loop_swaps: feedbackLoopSwaps,
    total_cost: finalResult.total_cost + bonusCost,
  };

  return {
    result: { ...finalResult, two_pass: stats, diagnostics },
    assignmentResult: { assignments: finalAssignments, standby: mergedStandby, details: allDetails, rejections: allRejections },
    twoPassStats: stats,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// FEEDBACK LOOP — Iterative reassignment for unsolved tails
// ═══════════════════════════════════════════════════════════════════════════════
//
// After all passes, unsolved tails may exist because:
// 1. The chosen swap point is unreachable by remaining crew
// 2. Hub crew were assigned locally (Uber) but could solve harder tails
// 3. Kuhn's matching ran within a fixed swap-point selection
//
// The feedback loop tries to "steal" assigned crew to solve unsolved tails,
// but ONLY when the vacated tail can be backfilled — net solved count must increase.

function runFeedbackLoop(params: {
  assignments: Record<string, SwapAssignment>;
  oncomingPool: OncomingPool;
  crewRoster: CrewMember[];
  flights: FlightLeg[];
  swapDate: string;
  aliases: AirportAlias[];
  commercialFlights?: Map<string, FlightOffer[]>;
  preComputedRoutes?: Map<string, PilotRoute[]>;
  preComputedOffgoing?: Map<string, PilotRoute[]>;
  offgoingDeadlines?: OncomingDeadline[];
  excludeTails?: Set<string>;
  standby: { pic: string[]; sic: string[] };
}): {
  assignments: Record<string, SwapAssignment>;
  solved: number;
  iterations: number;
  swaps: TwoPassStats["feedback_loop_swaps"];
  standby: { pic: string[]; sic: string[] };
  warnings: string[];
} {
  const { oncomingPool, crewRoster, flights, swapDate, aliases, commercialFlights, preComputedRoutes, preComputedOffgoing, offgoingDeadlines, excludeTails } = params;
  let assignments = JSON.parse(JSON.stringify(params.assignments)) as Record<string, SwapAssignment>;
  let standby = { pic: [...params.standby.pic], sic: [...params.standby.sic] };
  const swaps: TwoPassStats["feedback_loop_swaps"] = [];
  const warnings: string[] = [];
  const MAX_ITERATIONS = 5;
  let totalNewSolved = 0;

  // Group flights by tail
  const byTail = new Map<string, FlightLeg[]>();
  for (const f of flights) {
    if (!f.tail_number) continue;
    if (!byTail.has(f.tail_number)) byTail.set(f.tail_number, []);
    byTail.get(f.tail_number)!.push(f);
  }
  for (const [, legs] of byTail) {
    legs.sort((a, b) => new Date(a.scheduled_departure).getTime() - new Date(b.scheduled_departure).getTime());
  }

  // Build aircraft type map
  const tailAircraftType = new Map<string, string>();
  for (const tail of Object.keys(assignments)) {
    const sa = assignments[tail];
    const names = [sa.offgoing_pic, sa.offgoing_sic, sa.oncoming_pic, sa.oncoming_sic].filter(Boolean) as string[];
    for (const nm of names) {
      const crew = findCrewByName(crewRoster, nm, "PIC") ?? findCrewByName(crewRoster, nm, "SIC");
      if (crew?.aircraft_types[0]) {
        tailAircraftType.set(tail, crew.aircraft_types[0]);
        break;
      }
    }
  }

  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    // Find unsolved oncoming slots
    const unsolvedSlots: { tail: string; field: "oncoming_pic" | "oncoming_sic"; role: "PIC" | "SIC" }[] = [];
    for (const [tail, sa] of Object.entries(assignments)) {
      if (excludeTails?.has(tail)) continue;
      if (!sa.oncoming_pic) unsolvedSlots.push({ tail, field: "oncoming_pic", role: "PIC" });
      if (!sa.oncoming_sic) unsolvedSlots.push({ tail, field: "oncoming_sic", role: "SIC" });
    }

    if (unsolvedSlots.length === 0) break;

    let improved = false;

    for (const slot of unsolvedSlots) {
      // Determine pool for this role
      const pool = slot.role === "PIC" ? oncomingPool.pic : oncomingPool.sic;

      // Find all currently-assigned crew for this role across all tails
      const assignedCrewTails = new Map<string, string>(); // crewName → tail
      for (const [tail, sa] of Object.entries(assignments)) {
        const name = sa[slot.field];
        if (name) assignedCrewTails.set(name, tail);
      }

      // Build feasibility for all assigned crew against the UNSOLVED tail
      // using swapPointFallback=true so ALL swap points are tried
      const assignedPool = pool.filter((p) => assignedCrewTails.has(p.name));
      if (assignedPool.length === 0) continue;

      const { matrix: stealMatrix } = buildFeasibilityMatrix({
        pool: assignedPool,
        role: slot.role,
        tails: [slot.tail],
        byTail,
        swapDate,
        aliases,
        commercialFlights,
        crewRoster,
        tailAircraftType,
        preComputedRoutes,
        preComputedOffgoing,
        offgoingDeadlines,
        swapPointFallback: true, // try ALL swap points
      });

      // Get viable options sorted by rank (best first)
      const viableStealOptions = stealMatrix
        .filter((m) => m.viable && m.tail === slot.tail)
        .sort((a, b) => a.rank - b.rank);

      if (viableStealOptions.length === 0) continue;

      // For each steal candidate, check if the vacated tail can be backfilled
      let bestSwap: {
        crewToSteal: string;
        fromTail: string;
        stealSwapIcao: string;
        stealRank: number;
        backfillCrew: string;
        backfillSwapIcao: string;
        backfillRank: number;
      } | null = null;

      for (const stealOpt of viableStealOptions) {
        const fromTail = assignedCrewTails.get(stealOpt.crewName);
        if (!fromTail || excludeTails?.has(fromTail)) continue;

        // Build backfill pool: unassigned crew + standby (excluding the crew we're stealing)
        const standbyForRole = slot.role === "PIC" ? standby.pic : standby.sic;
        const assignedNames = new Set(assignedCrewTails.keys());
        const backfillPool: OncomingPoolEntry[] = [
          ...pool.filter((p) => !assignedNames.has(p.name)),
          ...standbyForRole.map((name) => {
            const crew = crewRoster.find((c) => c.name === name);
            return {
              name,
              aircraft_type: crew?.aircraft_types[0] ?? "unknown",
              home_airports: crew?.home_airports ?? [],
              is_skillbridge: crew?.is_skillbridge ?? false,
            } as OncomingPoolEntry;
          }),
        ];

        if (backfillPool.length === 0) continue;

        // Check feasibility of backfill candidates for the vacated tail
        // Use swapPointFallback=true so ALL swap points are tried for backfill too
        const { matrix: backfillMatrix } = buildFeasibilityMatrix({
          pool: backfillPool,
          role: slot.role,
          tails: [fromTail],
          byTail,
          swapDate,
          aliases,
          commercialFlights,
          crewRoster,
          tailAircraftType,
          preComputedRoutes,
          preComputedOffgoing,
          offgoingDeadlines,
          swapPointFallback: true,
        });

        const viableBackfills = backfillMatrix
          .filter((m) => m.viable && m.tail === fromTail)
          .sort((a, b) => a.rank - b.rank);

        if (viableBackfills.length === 0) continue;

        // Found a viable swap+backfill! Pick the best backfill option.
        const bestBackfill = viableBackfills[0];
        const combinedRank = stealOpt.rank + bestBackfill.rank;

        if (!bestSwap || combinedRank < bestSwap.stealRank + bestSwap.backfillRank) {
          bestSwap = {
            crewToSteal: stealOpt.crewName,
            fromTail,
            stealSwapIcao: stealOpt.bestSwapIcao,
            stealRank: stealOpt.rank,
            backfillCrew: bestBackfill.crewName,
            backfillSwapIcao: bestBackfill.bestSwapIcao,
            backfillRank: bestBackfill.rank,
          };
        }
      }

      // Execute the best swap if found
      if (bestSwap) {
        const { crewToSteal, fromTail, stealSwapIcao, backfillCrew, backfillSwapIcao } = bestSwap;
        const swapField = slot.field === "oncoming_pic" ? "oncoming_pic_swap_icao" : "oncoming_sic_swap_icao";

        // Move crew to unsolved tail
        assignments[fromTail][slot.field] = null;
        assignments[slot.tail][slot.field] = crewToSteal;
        assignments[slot.tail][swapField] = stealSwapIcao;

        // Backfill vacated tail
        assignments[fromTail][slot.field] = backfillCrew;
        assignments[fromTail][swapField] = backfillSwapIcao;

        // Update standby lists (remove backfill crew if they came from standby)
        standby.pic = standby.pic.filter((n) => n !== backfillCrew);
        standby.sic = standby.sic.filter((n) => n !== backfillCrew);

        totalNewSolved++;
        improved = true;

        const stealIata = toIata(stealSwapIcao);
        swaps.push({
          crew_moved: crewToSteal,
          role: slot.role,
          from_tail: fromTail,
          to_tail: slot.tail,
          backfilled_by: backfillCrew,
          new_swap_point: stealIata,
        });

        console.log(`[FeedbackLoop] iter=${iter + 1}: Moved ${slot.role} ${crewToSteal} from ${fromTail} → ${slot.tail} @ ${stealIata}, backfilled by ${backfillCrew}`);
        warnings.push(`${crewToSteal} (${slot.role}) reassigned from ${fromTail} to ${slot.tail} @ ${stealIata} [feedback loop], ${backfillCrew} backfills ${fromTail}`);

        break; // restart iteration loop to re-evaluate with new state
      }
    }

    if (!improved) {
      console.log(`[FeedbackLoop] No more improvements found after ${iter + 1} iteration(s)`);
      break;
    }
  }

  if (totalNewSolved > 0) {
    console.log(`[FeedbackLoop] Solved ${totalNewSolved} additional tail(s) via reassignment`);
  }

  return {
    assignments,
    solved: totalNewSolved,
    iterations: swaps.length > 0 ? swaps.length : 0,
    swaps,
    standby,
    warnings,
  };
}

function assignRoleWithMatrix(
  field: "oncoming_pic" | "oncoming_sic",
  pool: OncomingPoolEntry[],
  role: "PIC" | "SIC",
  result: Record<string, SwapAssignment>,
  byTail: Map<string, FlightLeg[]>,
  swapDate: string,
  aliases: AirportAlias[],
  commercialFlights: Map<string, FlightOffer[]> | undefined,
  crewRoster: CrewMember[],
  tailAircraftType: Map<string, string>,
  details: { name: string; tail: string; cost: number; reason: string }[],
  preComputedRoutes?: Map<string, PilotRoute[]>,
  preComputedOffgoing?: Map<string, PilotRoute[]>,
  excludeTails?: Set<string>,
  offgoingDeadlines?: OncomingDeadline[],
  picSwapPoints?: Map<string, string>,
  relaxation?: boolean,
  swapPointFallback?: boolean,  // when true, PIC tries ALL swap points (not just best)
  forceFleetFilter?: Map<string, string>,  // crew_name → aircraft_type (from force_fleet constraints)
): FeasibilityRejection[] {
  const needingTails = Object.keys(result).filter((tail) => !result[tail][field] && !excludeTails?.has(tail));
  if (needingTails.length === 0 || pool.length === 0) return [];

  // Build full feasibility matrix — uses pre-computed routes when available
  const { matrix, rejections: matrixRejections } = buildFeasibilityMatrix({
    pool,
    role,
    tails: needingTails,
    byTail,
    swapDate,
    aliases,
    commercialFlights,
    crewRoster,
    tailAircraftType,
    preComputedRoutes,
    preComputedOffgoing,
    offgoingDeadlines,
    picSwapPoints,
    relaxation,
    swapPointFallback,
  });

  // Only consider viable options (where real transport exists)
  let viableOptions = matrix.filter((m) => m.viable);

  // ── Apply force_fleet constraints: set rank = Infinity for non-matching tails ──
  if (forceFleetFilter && forceFleetFilter.size > 0) {
    for (const opt of viableOptions) {
      const requiredType = forceFleetFilter.get(opt.crewName);
      if (!requiredType) continue;
      const tailType = tailAircraftType.get(opt.tail) ?? "unknown";
      if (tailType !== "unknown" && tailType !== requiredType && requiredType !== "dual") {
        opt.rank = Infinity;
        opt.viable = false;
        console.log(`[Constraint] force_fleet: ${opt.crewName} rejected for ${opt.tail} (tail=${tailType}, required=${requiredType})`);
      }
    }
    // Re-filter after force_fleet
    viableOptions = viableOptions.filter((m) => m.viable);
  }

  // ── Grade-based pairing enforcement (sum >= 4) ─────────────────────────
  // When assigning SICs, penalize (don't block) pairings where PIC + SIC grade < 4.
  // Hard-blocking left tails unsolved when the only available SIC was low-grade.
  if (role === "SIC") {
    const MIN_GRADE_SUM = 4;
    for (const opt of viableOptions) {
      const sicCrew = crewRoster.find((c) => c.name === opt.crewName && c.role === "SIC");
      const sicGrade = sicCrew?.grade ?? 3;
      const picName = result[opt.tail]?.oncoming_pic;
      if (!picName) continue;
      const picCrew = crewRoster.find((c) => c.name === picName && c.role === "PIC");
      const picGrade = picCrew?.grade ?? 3;
      if (sicGrade + picGrade < MIN_GRADE_SUM) {
        opt.rank += 25; // Strong penalty instead of hard block
        console.log(`[GradeCheck] Penalized ${opt.crewName} (SIC grade ${sicGrade}) + ${picName} (PIC grade ${picGrade}) = ${sicGrade + picGrade} < ${MIN_GRADE_SUM}`);
      }
    }
  }

  // Count viable tails per crew AND viable crew per tail
  const viableTailsPerCrew = new Map<string, number>();
  const viableCrewPerTail = new Map<string, number>();
  for (const opt of viableOptions) {
    viableTailsPerCrew.set(opt.crewName, (viableTailsPerCrew.get(opt.crewName) ?? 0) + 1);
    viableCrewPerTail.set(opt.tail, (viableCrewPerTail.get(opt.tail) ?? 0) + 1);
  }

  // ── Maximum bipartite matching (Kuhn's algorithm) ─────────────────────
  // Greedy can't backtrack: if it assigns a flexible crew to an easy tail,
  // a hard tail with only that crew available ends up empty. Maximum matching
  // finds augmenting paths — chains of swaps that free up crew for hard tails.
  // This maximizes SOLVED COUNT, then we optimize cost within the matching.

  // Build adjacency: tail → viable crew (sorted by rank — best options first)
  const tailAdj = new Map<string, FeasibilityEntry[]>();
  for (const opt of viableOptions) {
    if (!tailAdj.has(opt.tail)) tailAdj.set(opt.tail, []);
    tailAdj.get(opt.tail)!.push(opt);
  }
  // Sort each tail's crew by rank (lower = better) so augmenting prefers cheap assignments
  for (const [, entries] of tailAdj) {
    entries.sort((a, b) => a.rank - b.rank);
  }

  // Kuhn's algorithm: for each tail, try to find an augmenting path
  const crewToTail = new Map<string, string>();  // crew → matched tail
  const tailToCrew = new Map<string, string>();   // tail → matched crew

  function augment(tail: string, visited: Set<string>): boolean {
    const adj = tailAdj.get(tail) ?? [];
    for (const opt of adj) {
      if (visited.has(opt.crewName)) continue;
      visited.add(opt.crewName);
      const currentTail = crewToTail.get(opt.crewName);
      // If crew is unmatched, or we can reroute their current match
      if (!currentTail || augment(currentTail, visited)) {
        crewToTail.set(opt.crewName, tail);
        tailToCrew.set(tail, opt.crewName);
        return true;
      }
    }
    return false;
  }

  // Process most-constrained tails first (fewest viable crew) for better cost optimization
  const sortedTails = [...needingTails].sort((a, b) =>
    (viableCrewPerTail.get(a) ?? 0) - (viableCrewPerTail.get(b) ?? 0)
  );
  for (const tail of sortedTails) {
    augment(tail, new Set());
  }

  const matchCount = tailToCrew.size;
  console.log(`[FeasMatrix] ${role}: ${viableOptions.length}/${matrix.length} viable combos, ` +
    `${new Set(viableOptions.map(v => v.tail)).size} tails w/viable crew, ` +
    `${new Set(viableOptions.map(v => v.crewName)).size} crew w/viable tails — ` +
    `matched ${matchCount} (max bipartite matching)`);

  // Apply the matching
  const swapField = field === "oncoming_pic" ? "oncoming_pic_swap_icao" : "oncoming_sic_swap_icao";
  for (const [tail, crewName] of tailToCrew) {
    const opt = viableOptions.find((v) => v.crewName === crewName && v.tail === tail);
    if (!opt) continue;

    result[tail][field] = crewName;
    if (opt.bestSwapIcao) result[tail][swapField] = opt.bestSwapIcao;

    const loc = extractSwapPoints(tail, byTail, swapDate).swapPoints[0];
    const crewConstraint = viableTailsPerCrew.get(crewName) ?? 0;
    const tailConstraint = viableCrewPerTail.get(tail) ?? 0;
    const swapIata = opt.bestSwapIcao ? toIata(opt.bestSwapIcao) : (loc ? toIata(loc.icao) : "?");
    const driveMi = opt.minDriveMiles < 9999 ? `${Math.round(opt.minDriveMiles)}mi` : "?mi";
    const constrainedTag = crewConstraint <= 2 ? " [CREW-CONSTRAINED]" : (tailConstraint <= 2 ? " [TAIL-CONSTRAINED]" : "");
    const offStr = opt.offgoingCost > 0 ? ` +$${Math.round(opt.offgoingCost)} offgoing` : "";
    const reason = `${opt.bestType} $${Math.round(opt.bestCost)}${offStr} (total $${Math.round(opt.totalCost)}) score=${opt.bestScore} to ${swapIata} | proximity=${driveMi} rank=${opt.rank.toFixed(1)} (crew→${crewConstraint} tails, tail→${tailConstraint} crew)${constrainedTag}`;
    console.log(`[Assignment] ${role} ${crewName} → ${tail} @ ${swapIata}: ${reason}`);

    details.push({
      name: crewName,
      tail,
      cost: Math.round(opt.totalCost),
      reason,
    });
  }

  return matrixRejections;
}

// ─── Helper: get flight searches for ALL pool crew × ALL swap locations ───────

/** Generate search pairs for the ENTIRE oncoming pool to ALL swap locations.
 *  This runs BEFORE assignment so the optimizer has real flight data. */
export function getPoolFlightSearches(params: {
  oncomingPool: OncomingPool;
  aliases: AirportAlias[];
  swapAssignments: Record<string, SwapAssignment>;
  flights: FlightLeg[];
  swapDate: string;
}): { origin: string; destination: string; date: string }[] {
  const { oncomingPool, aliases, swapAssignments, flights, swapDate } = params;
  const pairs = new Set<string>();

  // Collect ALL unique swap locations from tails
  const swapCommAirports = new Set<string>();
  for (const tail of Object.keys(swapAssignments)) {
    const loc = determineSwapLocation(tail, flights, swapDate);
    if (!loc) continue;
    for (const comm of findAllCommercialAirports(loc.icao, aliases)) {
      swapCommAirports.add(toIata(comm));
    }
  }

  // For each pool member, generate home → swap location pairs
  const allPoolMembers = [...oncomingPool.pic, ...oncomingPool.sic];
  for (const crew of allPoolMembers) {
    for (const home of crew.home_airports) {
      const homeIata = toIata(home);
      for (const comm of swapCommAirports) {
        if (homeIata !== comm) {
          pairs.add(`${homeIata}-${comm}`);
        }
      }
    }
  }

  return Array.from(pairs).map((p) => {
    const [origin, destination] = p.split("-");
    return { origin, destination, date: swapDate };
  });
}

// ─── Helper: get flight searches for assigned crew (after assignment) ─────────

export function getRequiredFlightSearches(params: {
  crewRoster: CrewMember[];
  aliases: AirportAlias[];
  swapAssignments: Record<string, SwapAssignment>;
  flights: FlightLeg[];
  swapDate: string;
}): { origin: string; destination: string; date: string }[] {
  const { crewRoster, aliases, swapAssignments, flights, swapDate } = params;
  const pairs = new Set<string>();

  const byTail = new Map<string, FlightLeg[]>();
  for (const f of flights) {
    if (!f.tail_number) continue;
    if (!byTail.has(f.tail_number)) byTail.set(f.tail_number, []);
    byTail.get(f.tail_number)!.push(f);
  }

  for (const [tail, assignment] of Object.entries(swapAssignments)) {
    const legs = byTail.get(tail) ?? [];
    const wedLegs = legs.filter((f) => f.scheduled_departure.slice(0, 10) === swapDate);
    const priorLegs = legs.filter(
      (f) => new Date(f.scheduled_departure).getTime() < new Date(swapDate).getTime(),
    );
    const lastPrior = priorLegs[priorLegs.length - 1];
    const overnightAirport = lastPrior?.arrival_icao ?? wedLegs[0]?.departure_icao ?? null;

    // Key airports for this tail
    const swapAirports: string[] = [];
    if (wedLegs.length > 0) {
      swapAirports.push(wedLegs[0].departure_icao);
      swapAirports.push(wedLegs[wedLegs.length - 1].arrival_icao);
    } else if (overnightAirport) {
      swapAirports.push(overnightAirport);
    }

    const commAirports = new Set<string>();
    for (const apt of swapAirports) {
      for (const comm of findAllCommercialAirports(apt, aliases)) {
        commAirports.add(toIata(comm));
      }
    }

    // For each crew member, get their home airports
    const crewNames = [
      assignment.oncoming_pic, assignment.oncoming_sic,
      assignment.offgoing_pic, assignment.offgoing_sic,
    ].filter(Boolean) as string[];

    for (const name of crewNames) {
      let member = findCrewByName(crewRoster, name, "PIC") ?? findCrewByName(crewRoster, name, "SIC");
      if (!member) {
        // Last resort: search by last name
        const norm = name.trim().toLowerCase().replace(/\s+/g, " ");
        const parts = norm.includes(",")
          ? norm.split(",").map((p: string) => p.trim()).reverse()
          : norm.split(" ");
        const lastName = parts[parts.length - 1];
        member = crewRoster.find((c) => {
          const cParts = c.name.trim().toLowerCase().replace(/\s+/g, " ").split(" ");
          return cParts[cParts.length - 1] === lastName;
        }) ?? null;
      }
      if (!member) continue;

      for (const home of member.home_airports) {
        const homeIata = toIata(home);
        for (const comm of commAirports) {
          if (homeIata !== comm) {
            pairs.add(`${homeIata}-${comm}`);
            pairs.add(`${comm}-${homeIata}`);
          }
        }
      }
    }
  }

  return Array.from(pairs).map((p) => {
    const [origin, destination] = p.split("-");
    return { origin, destination, date: swapDate };
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// PUBLIC SWAP POINT EXTRACTION (for API use)
// ═══════════════════════════════════════════════════════════════════════════════

export type SwapPointInfo = {
  icao: string;
  time: Date;
  position: "before_live" | "after_live" | "between_legs" | "idle";
  isAdjacentLive: boolean;
};

/**
 * Public wrapper around extractSwapPoints for API use.
 */
export function extractSwapPointsPublic(
  tail: string,
  byTail: Map<string, FlightLeg[]>,
  swapDate: string,
): { swapPoints: SwapPointInfo[]; overnightAirport: string | null; aircraftType: string } {
  return extractSwapPoints(tail, byTail, swapDate);
}

// ═══════════════════════════════════════════════════════════════════════════════
// OFFGOING-FIRST ALGORITHM (Phase 5)
// ═══════════════════════════════════════════════════════════════════════════════

export type OffgoingPlan = {
  name: string;
  tail: string;
  role: "PIC" | "SIC";
  swapPoint: string;
  transport: TransportCandidate | null;
  deadline: Date | null;
};

export type OncomingDeadline = {
  tail: string;
  role: "PIC" | "SIC";
  swapPoint: string;
  deadline: Date;
  offgoingName: string;
  offgoingFlight: string | null;
};

export type OffgoingFirstResult = {
  offgoingPlans: OffgoingPlan[];
  deadlines: OncomingDeadline[];
  unsolvable: { tail: string; role: "PIC" | "SIC"; reason: string }[];
};

/**
 * Solve offgoing constraints first, then derive oncoming deadlines.
 * For each tail: find best offgoing transport → compute deadline → filter oncoming candidates.
 */
export function solveOffgoingFirst(params: {
  flights: FlightLeg[];
  crewRoster: CrewMember[];
  aliases: AirportAlias[];
  swapDate: string;
  commercialFlights?: Map<string, FlightOffer[]>;
  swapAssignments: Record<string, SwapAssignment>;
}): OffgoingFirstResult {
  const { flights, crewRoster, aliases, swapDate, commercialFlights, swapAssignments } = params;

  const byTail = new Map<string, FlightLeg[]>();
  for (const f of flights) {
    if (!f.tail_number) continue;
    if (!byTail.has(f.tail_number)) byTail.set(f.tail_number, []);
    byTail.get(f.tail_number)!.push(f);
  }

  const offgoingPlans: OffgoingPlan[] = [];
  const deadlines: OncomingDeadline[] = [];
  const unsolvable: { tail: string; role: "PIC" | "SIC"; reason: string }[] = [];

  for (const [tail, assignment] of Object.entries(swapAssignments)) {
    const { swapPoints } = extractSwapPoints(tail, byTail, swapDate);
    if (swapPoints.length === 0) {
      unsolvable.push({ tail, role: "PIC", reason: "No swap points found" });
      continue;
    }

    // HARD RULE: prefer domestic after_live ONLY when the alternative is international.
    // When both options are domestic, let the scoring formula decide.
    let swapPoint = swapPoints[0];
    const hasInternationalOption = swapPoints.some(sp => {
      const upper = sp.icao.toUpperCase();
      return !upper.startsWith("K") && !upper.startsWith("CY");
    });
    if (hasInternationalOption) {
      const domesticAfterLive = swapPoints.find(sp => {
        if (sp.position !== "after_live") return false;
        const upper = sp.icao.toUpperCase();
        return upper.startsWith("K") || upper.startsWith("CY");
      });
      if (domesticAfterLive) {
        swapPoint = domesticAfterLive;
        console.log(`[SwapPoint] ${tail}: forced domestic after_live ${toIata(domesticAfterLive.icao)} over international ${toIata(swapPoints[0].icao)}`);
      }
    }
    if (swapPoints.length > 1 && swapPoint === swapPoints[0]) {
      let bestEase = -Infinity;
      for (const sp of swapPoints) {
        const commAirports = findAllCommercialAirports(sp.icao, aliases);
        const selfCommercial = isCommercialAirport(sp.icao);
        let minDrive = Infinity;
        for (const c of commAirports) {
          if (c.toUpperCase() === sp.icao.toUpperCase()) { minDrive = 0; break; }
          const d = estimateDriveTime(sp.icao, c);
          if (d) minDrive = Math.min(minDrive, d.estimated_drive_minutes);
        }
        if (minDrive === Infinity) minDrive = 999;
        const isInternational = commAirports.every((c) => {
          const upper = c.toUpperCase();
          if (TERRITORY_AIRPORTS.has(upper)) return true;
          return !upper.startsWith("K") && !upper.startsWith("CY") && !upper.startsWith("Y");
        });
        let timingPenalty = 0;
        if (sp.position === "after_live" || sp.position === "between_legs") {
          const tz = getAirportTimezone(sp.icao) ?? "America/New_York";
          const refTime = (sp.position === "between_legs" && sp.window_end) ? sp.window_end : sp.time;
          const localHour = parseFloat(
            new Date(refTime).toLocaleString("en-US", { hour: "numeric", hour12: false, timeZone: tz })
          );
          const hoursAfterNoon = Math.max(0, localHour - 12);
          timingPenalty = Math.min(150, hoursAfterNoon * 12);
        }
        const afterLiveBonus = sp.position === "after_live" ? 80 : 0;
        const ease = -minDrive + (selfCommercial ? 30 : 0) + commAirports.length * 2
          - (isInternational ? 500 : 0) - timingPenalty + afterLiveBonus;
        if (ease > bestEase) { bestEase = ease; swapPoint = sp; }
      }
    }

    for (const [offName, role] of [
      [assignment.offgoing_pic, "PIC"] as const,
      [assignment.offgoing_sic, "SIC"] as const,
    ]) {
      if (!offName) continue;

      const crewMember = findCrewByName(crewRoster, offName, role);
      if (!crewMember) {
        offgoingPlans.push({ name: offName, tail, role, swapPoint: swapPoint.icao, transport: null, deadline: null });
        continue;
      }

      const task: CrewTask = {
        name: offName,
        crewMember,
        role,
        direction: "offgoing",
        tail,
        aircraftType: crewMember.aircraft_types[0] ?? "unknown",
        swapPoint,
        homeAirports: crewMember.home_airports,
        candidates: [],
        best: null,
        warnings: [],
      };

      task.candidates = buildCandidates(task, aliases, commercialFlights, swapDate);
      for (const c of task.candidates) {
        c.score = scoreCandidate(c, task, null);
      }
      // Pick the candidate with the LATEST fboLeaveTime — maximizes the oncoming window.
      // Previously we picked the best-scored (earliest departure), creating impossibly
      // tight deadlines like 8:45am that no oncoming crew can meet. The offgoing crew
      // takes a later flight home, giving oncoming all day to arrive.
      const viableCandidates = task.candidates.filter((c) => c.type !== "none");
      viableCandidates.sort((a, b) => {
        const aLeave = (a.fboLeaveTime ?? a.depTime)?.getTime() ?? 0;
        const bLeave = (b.fboLeaveTime ?? b.depTime)?.getTime() ?? 0;
        return bLeave - aLeave; // latest first
      });
      task.best = viableCandidates[0] ?? task.candidates[0] ?? null;

      const best = task.best;
      let deadline: Date | null = null;

      // Use fboLeaveTime (when crew physically leaves FBO) — tighter than depTime
      const offgoingLeave = best?.fboLeaveTime ?? best?.depTime;
      if (offgoingLeave) {
        deadline = new Date(offgoingLeave.getTime() - HANDOFF_BUFFER_MINUTES * 60_000);
      }

      offgoingPlans.push({
        name: offName, tail, role,
        swapPoint: swapPoint.icao, transport: best, deadline,
      });

      if (deadline) {
        deadlines.push({
          tail, role, swapPoint: swapPoint.icao, deadline,
          offgoingName: offName, offgoingFlight: best?.flightNumber ?? null,
        });
      } else {
        // Offgoing has no viable transport — do NOT create a deadline.
        // No deadline = no filter on oncoming candidates, which is the least
        // restrictive option (oncoming can arrive at any time).
        unsolvable.push({
          tail, role,
          reason: `No viable transport for offgoing ${offName} from ${swapPoint.icao}`,
        });
      }
    }
  }

  return { offgoingPlans, deadlines, unsolvable };
}
// force rebuild 1774884943
