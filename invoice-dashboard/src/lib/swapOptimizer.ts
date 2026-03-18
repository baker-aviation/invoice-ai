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
  MAX_DUTY_HOURS, DUTY_ON_BEFORE_COMMERCIAL, DEPLANE_BUFFER,
  FBO_ARRIVAL_BUFFER, FBO_ARRIVAL_BUFFER_PREFERRED, DUTY_OFF_AFTER_LAST_LEG,
  INTERNATIONAL_DUTY_OFF, AIRPORT_SECURITY_BUFFER, RENTAL_RETURN_BUFFER,
  EARLIEST_DUTY_ON_HOUR, UBER_MAX_MINUTES, RENTAL_MAX_MINUTES,
  BUDGET_CARRIERS, PREFERRED_HUBS, BACKUP_FLIGHT_MIN_GAP, MAX_CONNECTIONS,
  EARLY_LATE_BONUS_PIC, EARLY_LATE_BONUS_SIC,
  RENTAL_HANDOFF_FUEL_COST, STAGGER_MIN_GAP_HOURS, HANDOFF_BUFFER_MINUTES,
  TEB_PENALTY_AIRPORTS, TEB_OFFGOING_PENALTY, TEB_ONCOMING_PENALTY,
} from "./swapRules";

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
  is_skillbridge: boolean;
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
  is_skillbridge: boolean;
  volunteer_status: string | null;
  notes: string | null;
  warnings: string[];
  drive_estimate: DriveEstimate | null;
  flight_offer: FlightOffer | null;
  alt_flights: { flight_number: string; dep: string; arr: string; price: string }[];
  backup_flight: string | null;
  score: number;
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
};

export type TwoPassStats = {
  pass1_solved: number;
  pass1_unsolved: number;
  pass1_cost: number;
  pass2_solved: number;
  pass2_volunteers_used: { name: string; role: "PIC" | "SIC"; tail: string; type: "early" | "late" }[];
  pass2_bonus_cost: number;
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

function ms(minutes: number): number { return minutes * 60_000; }

/** Get local hour at an airport for a UTC timestamp */
function getLocalHour(utcDate: Date, icao: string): number {
  const tz = getAirportTimezone(icao) ?? "America/New_York";
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hour: "numeric", hour12: false,
  }).formatToParts(utcDate);
  return parseInt(parts.find(p => p.type === "hour")?.value ?? "12");
}

/** Get midnight local at an airport on the NEXT day after dateStr (i.e. end of that day) */
function midnightUtc(icao: string, dateStr: string): Date {
  const tz = getAirportTimezone(icao) ?? "America/New_York";
  // We need to find UTC time for midnight local on the day AFTER dateStr
  // (midnight = end of Wednesday = start of Thursday)
  const nextDay = new Date(dateStr);
  nextDay.setDate(nextDay.getDate() + 1);
  const ndStr = nextDay.toISOString().slice(0, 10);

  // Get timezone offset at that local midnight
  const refDate = new Date(`${ndStr}T00:00:00Z`);
  const utcStr = refDate.toLocaleString("en-US", { timeZone: "UTC" });
  const localStr = refDate.toLocaleString("en-US", { timeZone: tz });
  const offsetMs = new Date(utcStr).getTime() - new Date(localStr).getTime();
  return new Date(refDate.getTime() + offsetMs);
}

/** Duty-on time for commercial flight from home airport */
function dutyOnForCommercial(flightDepTime: Date): Date {
  return new Date(flightDepTime.getTime() - ms(DUTY_ON_BEFORE_COMMERCIAL));
}

/** Duty-on with drive to non-home airport first */
function dutyOnWithDrive(driveStartTime: Date): Date {
  return driveStartTime;
}

/** Duty-off for offgoing crew */
function dutyOff(lastLegArrival: Date, isInternational: boolean): Date {
  const buffer = isInternational ? INTERNATIONAL_DUTY_OFF : DUTY_OFF_AFTER_LAST_LEG;
  return new Date(lastLegArrival.getTime() + ms(buffer));
}

/** When crew arrives at FBO after commercial flight + deplane + ground transport */
function fboArrivalAfterCommercial(
  flightArrTime: Date,
  driveToFboMin: number,
): Date {
  return new Date(flightArrTime.getTime() + ms(DEPLANE_BUFFER) + ms(driveToFboMin));
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
function checkDutyDay(dutyOn: Date, dutyEnd: Date): { valid: boolean; hours: number } {
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
function findAllCommercialAirports(fboIcao: string, aliases: AirportAlias[]): string[] {
  const upper = fboIcao.toUpperCase();
  const result = new Set<string>();

  // 0. If the FBO itself is a commercial airport (e.g. KIAD, KRDU), include it first.
  //    The nearby-search skips self, so we'd miss it without this check.
  if (isCommercialAirport(upper)) result.add(upper);

  // 1. Check alias table (preferred first)
  const matching = aliases.filter((a) => a.fbo_icao.toUpperCase() === upper);
  const sorted = [...matching].sort((a, b) => (b.preferred ? 1 : 0) - (a.preferred ? 1 : 0));
  for (const a of sorted) result.add(a.commercial_icao);

  // 2. Find nearby commercial airports within 30 miles
  const nearby = findNearbyCommercialAirports(upper, 30);
  for (const n of nearby) {
    if (!result.has(n.icao)) result.add(n.icao);
  }

  // 3. Fallback: if nothing found, use the FBO code itself
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

function toIata(icao: string): string {
  if (ICAO_IATA[icao]) return ICAO_IATA[icao];
  return icao.length === 4 && icao.startsWith("K") ? icao.slice(1) : icao;
}

function toIcao(code: string): string {
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

  // Determine deadline/target times
  const homeMidnight = task.homeAirports[0]
    ? midnightUtc(toIcao(task.homeAirports[0]), swapDate)
    : midnightUtc(swapIcao, swapDate);

  // Oncoming hard deadline: 1800L at the swap airport (offgoing crew holds until then)
  // The ideal is arriving before the first leg, but it's a scoring preference, not a hard cutoff.
  let oncomingHardDeadline: Date | null = null;
  if (task.direction === "oncoming") {
    const tz = getAirportTimezone(swapIcao) ?? "America/New_York";
    const sixPmLocal = new Date(`${swapDate}T18:00:00`);
    const utcStr = sixPmLocal.toLocaleString("en-US", { timeZone: "UTC" });
    const localStr = sixPmLocal.toLocaleString("en-US", { timeZone: tz });
    const offsetMs = new Date(utcStr).getTime() - new Date(localStr).getTime();
    oncomingHardDeadline = new Date(sixPmLocal.getTime() + offsetMs);
  }

  // Estimate duty-end for oncoming crew: last leg arrival + off-duty buffer
  // For offgoing crew: duty-end = when they arrive home (checked per-candidate)
  let oncomingDutyEnd: Date | null = null;
  if (task.direction === "oncoming" && tailLegs) {
    const wedLegs = tailLegs.filter((f) => f.scheduled_departure.slice(0, 10) === swapDate);
    const lastLeg = wedLegs[wedLegs.length - 1];
    if (lastLeg?.scheduled_arrival) {
      oncomingDutyEnd = dutyOff(new Date(lastLeg.scheduled_arrival), false);
    } else if (lastLeg) {
      // No arrival time — estimate 3hr flight + off-duty buffer
      oncomingDutyEnd = new Date(new Date(lastLeg.scheduled_departure).getTime() + ms(180) + ms(DUTY_OFF_AFTER_LAST_LEG));
    } else {
      // No legs — estimate duty ends at 2200L (conservative for unscheduled tails)
      const tz = getAirportTimezone(swapIcao) ?? "America/New_York";
      const refDate = new Date(`${swapDate}T22:00:00`);
      const utcStr = refDate.toLocaleString("en-US", { timeZone: "UTC" });
      const localStr = refDate.toLocaleString("en-US", { timeZone: tz });
      const offsetMs = new Date(utcStr).getTime() - new Date(localStr).getTime();
      oncomingDutyEnd = new Date(refDate.getTime() + offsetMs);
    }
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
        // Work backwards from when they need to be at FBO
        const mustBeAtFbo = new Date(task.swapPoint.time.getTime() - ms(FBO_ARRIVAL_BUFFER));
        arrTime = mustBeAtFbo;
        depTime = new Date(arrTime.getTime() - ms(driveMin));
        fboArr = arrTime;
        // Duty-on: for Uber < 1hr from home, no adjustment. Otherwise, start of drive.
        dutyOn = type === "uber" ? fboArr : depTime;

        // 14hr duty day check: duty-on through estimated end of flying day
        if (oncomingDutyEnd && dutyOn) {
          const { valid } = checkDutyDay(dutyOn, oncomingDutyEnd);
          if (!valid) continue; // Exceeds 14hr duty day
        }
      } else {
        // Offgoing: leaving the aircraft, driving home
        // For before_live/idle, use early morning — Step 2 constraint adjusts real timing
        let earliestLeave = task.swapPoint.time;
        if (task.swapPoint.position === "before_live" || task.swapPoint.position === "idle") {
          const tz = getAirportTimezone(task.swapPoint.icao) ?? "America/New_York";
          const earlyLocal = new Date(`${swapDate}T05:00:00`);
          const utcStr = earlyLocal.toLocaleString("en-US", { timeZone: "UTC" });
          const localStr = earlyLocal.toLocaleString("en-US", { timeZone: tz });
          const offsetMs = new Date(utcStr).getTime() - new Date(localStr).getTime();
          earliestLeave = new Date(earlyLocal.getTime() + offsetMs);
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
    if (task.lateVolunteer) {
      const dayAfter = new Date(swapDate);
      dayAfter.setDate(dayAfter.getDate() + 1);
      datesToSearch.push(dayAfter.toISOString().slice(0, 10));
    }

    for (const commApt of commAirports) {
      const commIata = toIata(commApt);
      const driveToFbo = estimateDriveTime(
        task.direction === "oncoming" ? toIcao(commIata) : swapIcao,
        task.direction === "oncoming" ? swapIcao : toIcao(commIata),
      );
      const driveToFboMin = driveToFbo?.estimated_drive_minutes ?? 0;

      let originIata: string;
      let destIata: string;
      if (task.direction === "oncoming") {
        originIata = homeIata;
        destIata = commIata;
      } else {
        originIata = commIata;
        destIata = homeIata;
      }

      for (const searchDate of datesToSearch) {
      const offers = lookupFlights(commercialFlights, originIata, destIata, searchDate);

      for (const offer of offers) {
        const segs = offer.itineraries[0]?.segments ?? [];
        if (segs.length === 0) continue;

        // Reject 2+ connections
        if (segs.length - 1 > MAX_CONNECTIONS) continue;

        const firstSeg = segs[0];
        const lastSeg = segs[segs.length - 1];
        const flightDep = new Date(firstSeg.departure.at);
        const flightArr = new Date(lastSeg.arrival.at);
        const totalDuration = segs.reduce((s, sg) => s + parseDuration(sg.duration), 0);
        const flightNum = segs.map((s) => `${s.carrierCode}${s.number}`).join("/");
        const isDirect = segs.length === 1;
        const isBudget = segs.some((s) => BUDGET_CARRIERS.includes(s.carrierCode));
        const isHub = segs.length > 1 && segs.some((s) =>
          PREFERRED_HUBS.includes(s.arrival.iataCode) || PREFERRED_HUBS.includes(s.departure.iataCode),
        );

        let fboArr: Date | null = null;
        let dutyOn: Date | null = null;
        const cost = parseFloat(offer.price.total);

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

          // Hard deadline: must arrive at FBO by 1800L (offgoing crew holds until then)
          // Arriving before first leg is a scoring PREFERENCE, not a hard requirement
          if (oncomingHardDeadline && fboArr.getTime() > oncomingHardDeadline.getTime()) {
            continue; // Too late — even offgoing can't hold this long
          }

          // Check: duty-on not before 0400 local
          const localHour = getLocalHour(dutyOn, homeIcao);
          if (localHour < EARLIEST_DUTY_ON_HOUR && localHour >= 0) {
            // Soft penalty, don't reject
          }

          // 14hr duty day check: duty-on through estimated end of flying day
          if (oncomingDutyEnd && dutyOn) {
            const { valid } = checkDutyDay(dutyOn, oncomingDutyEnd);
            if (!valid) continue; // Exceeds 14hr duty day
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
            const earlyLocal = new Date(`${swapDate}T05:00:00`);
            const utcStr = earlyLocal.toLocaleString("en-US", { timeZone: "UTC" });
            const localStr = earlyLocal.toLocaleString("en-US", { timeZone: tz });
            const offsetMs = new Date(utcStr).getTime() - new Date(localStr).getTime();
            releaseTime = new Date(earlyLocal.getTime() + offsetMs);
          }
          // Need to get to commercial airport + security buffer
          const buffer = driveToFboMin > UBER_MAX_MINUTES ? RENTAL_RETURN_BUFFER : AIRPORT_SECURITY_BUFFER;
          const needAtAirport = new Date(flightDep.getTime() - ms(buffer));
          const needLeaveAircraft = new Date(needAtAirport.getTime() - ms(driveToFboMin));

          if (needLeaveAircraft.getTime() < releaseTime.getTime()) {
            continue; // Can't make this flight
          }

          // Check midnight deadline
          const homeArr = new Date(flightArr.getTime() + ms(DEPLANE_BUFFER));
          if (homeArr.getTime() > homeMidnight.getTime()) {
            // Skill-Bridge SIC gets Thursday midnight
            if (task.crewMember?.is_skillbridge && task.role === "SIC") {
              const thurMidnight = new Date(homeMidnight.getTime() + 24 * 60 * 60_000);
              if (homeArr.getTime() > thurMidnight.getTime()) continue;
            } else {
              continue; // Won't make midnight
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
          cost: cost + groundCost,
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

        candidates.push(candidate);
      }
      } // end for searchDate
    } // end for commApt
  } // end for homeApt

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
      const deadline1800 = new Date(`${task.swapPoint.time.toISOString().slice(0, 10)}T18:00:00`);
      const utcStr = deadline1800.toLocaleString("en-US", { timeZone: "UTC" });
      const localStr = deadline1800.toLocaleString("en-US", { timeZone: tz });
      const offsetMs = new Date(utcStr).getTime() - new Date(localStr).getTime();
      const hardDeadline = new Date(deadline1800.getTime() + offsetMs);
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

    // Backup flight availability
    if (c.backups.length >= 2) score += 8;
    else if (c.backups.length === 1) score += 4;
    else score -= 5; // No backup
  }

  // ── FBO arrival timing (oncoming only) ──────────────────────────────
  // Arriving before the first leg is ideal but not required.
  // Offgoing crew holds until oncoming arrives.
  if (task.direction === "oncoming" && c.fboArrivalTime) {
    const bufferMin = (task.swapPoint.time.getTime() - c.fboArrivalTime.getTime()) / 60_000;
    if (bufferMin >= FBO_ARRIVAL_BUFFER_PREFERRED) score += 10; // 90+ min early — ideal
    else if (bufferMin >= FBO_ARRIVAL_BUFFER) score += 7;       // 60+ min early — good
    else if (bufferMin >= 0) score += 3;                         // Before swap point — OK
    else if (bufferMin >= -120) score -= 2;                      // Up to 2hr late — acceptable
    else if (bufferMin >= -240) score -= 5;                      // Up to 4hr late — less ideal
    else score -= 10;                                             // 4+ hr late — poor
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

  // ── Offgoing: prefer later flights (1700-1800L ideal) ──────────────────
  if (task.direction === "offgoing" && c.depTime) {
    const localHour = getLocalHour(c.depTime, task.swapPoint.icao);
    if (localHour >= 17 && localHour <= 18) score += 5;
    else if (localHour >= 15 && localHour <= 20) score += 2;
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

/** For each tail, find the best combination of transport for all crew */
function optimizeTail(
  tasks: CrewTask[],
  aliases: AirportAlias[],
  commercialFlights: Map<string, FlightOffer[]> | undefined,
  swapDate: string,
  tailLegs?: FlightLeg[],
  deadlines?: OncomingDeadline[],
): void {
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
      } else {
        // No oncoming option arrives before offgoing must leave
        onTask.candidates = onTask.candidates.filter((c) => c.type === "none");
        onTask.warnings.push(
          `No oncoming transport arrives before offgoing ${dl.offgoingName} must leave` +
          (dl.offgoingFlight ? ` (${dl.offgoingFlight})` : ""),
        );
      }
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

      // Only keep candidates that pass the timing constraint
      task.candidates = adjusted;
      if (!adjusted.some((c) => c.type !== "none")) {
        // All real transport options depart before oncoming arrives — unsolvable
        task.warnings.push(
          `No offgoing transport available: all options require leaving FBO before oncoming PIC arrives + ${HANDOFF_BUFFER_MINUTES}min handoff`,
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

  // Classify legs by LOCAL date at departure airport, not UTC.
  // A leg departing at 8:30pm ET (00:30 UTC next day) must be treated as the prior day.
  const localDate = (isoStr: string, icao: string): string => {
    const tz = getAirportTimezone(icao) ?? "America/New_York";
    return new Date(isoStr).toLocaleDateString("en-CA", { timeZone: tz }); // YYYY-MM-DD
  };

  const wedLegs = legs.filter((f) => localDate(f.scheduled_departure, f.departure_icao) === swapDate);
  const liveWedLegs = wedLegs.filter((f) => isLiveType(f.flight_type));

  const priorLegs = legs.filter(
    (f) => localDate(f.scheduled_departure, f.departure_icao) < swapDate,
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
      if (leg.arrival_icao && leg.scheduled_arrival) {
        swapPoints.push({
          icao: leg.arrival_icao,
          time: new Date(leg.scheduled_arrival),
          position: "between_legs",
          isAdjacentLive: true,
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

      // Does the FBO itself have commercial service? (self-alias like KASE→KASE)
      const selfCommercial = aliases.some(
        (a) => a.fbo_icao.toUpperCase() === spIcao.toUpperCase()
          && a.commercial_icao.toUpperCase() === spIcao.toUpperCase(),
      );

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
    if (swapPoints.length > 1 && commercialFlights) {
      let bestEase = -Infinity;
      for (const sp of swapPoints) {
        const commAirports = findAllCommercialAirports(sp.icao, aliases);
        const selfCommercial = aliases.some(
          (a) => a.fbo_icao.toUpperCase() === sp.icao.toUpperCase()
            && a.commercial_icao.toUpperCase() === sp.icao.toUpperCase(),
        );
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
          return !upper.startsWith("K") && !upper.startsWith("CY") && !upper.startsWith("Y");
        });

        // Penalty for late arrival at after_live/between_legs swap points.
        // If an aircraft flies KTEB→KPSP at 6pm, the crew arrives PSP at ~11pm —
        // too late for any commercial flights home. Penalize by how late the swap is.
        // "before_live" and "idle" have no timing penalty (crew leaves whenever they want).
        let timingPenalty = 0;
        if (sp.position === "after_live" || sp.position === "between_legs") {
          const tz = getAirportTimezone(sp.icao) ?? "America/New_York";
          const localHour = parseFloat(
            new Date(sp.time).toLocaleString("en-US", { hour: "numeric", hour12: false, timeZone: tz })
          );
          // Penalty ramps up after noon local: 0 at noon, 50 at 6pm, 150 at 10pm+
          const hoursAfterNoon = Math.max(0, localHour - 12);
          timingPenalty = Math.min(150, hoursAfterNoon * 12);
        }

        // Ease score: lower drive = easier, self-commercial = bonus, more options = bonus
        const ease = -minDrive + (selfCommercial ? 30 : 0) + (commAirports.length * 2)
          - (isInternational ? 200 : 0) - timingPenalty;
        if (ease > bestEase) {
          bestEase = ease;
          picSwapPoint = sp;
        }
      }
    }

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

    // ── Create crew tasks ────────────────────────────────────────────────
    const tailTasks: CrewTask[] = [];

    // For idle tails with split swap points (early oncoming / late offgoing),
    // use the first swap point for oncoming and the last for offgoing.
    const isIdleTail = swapPoints.length >= 2 && swapPoints.every((sp) => sp.position === "idle");
    const offgoingSwapPoint = isIdleTail ? swapPoints[swapPoints.length - 1] : picSwapPoint;

    // PIC tasks — at the best-scored swap point
    if (!assignment.oncoming_pic) {
      globalWarnings.push(`${tail}: No oncoming PIC assigned — no qualified crew can reach this aircraft`);
    }
    for (const [name, direction] of [
      [assignment.oncoming_pic, "oncoming"] as const,
      [assignment.offgoing_pic, "offgoing"] as const,
    ]) {
      if (!name) continue;
      const { crewMember, homeAirports, warnings } = resolveCrewMember(name, "PIC");
      if (homeAirports.length === 0) {
        console.warn(`[SwapOptimizer] No home airports for "${name}" (PIC, ${tail})`);
      }
      // Note when PIC swaps at a non-default location (not the first swap point)
      if (picSwapPoint !== swapPoints[0]) {
        warnings.push(`PIC swaps at ${toIata(picSwapPoint.icao)} (${picSwapPoint.position}) — easier commercial access than ${toIata(swapPoints[0].icao)}`);
      }
      const volFlags = direction === "oncoming" ? getVolunteerFlags(name, "PIC") : { earlyVolunteer: false, lateVolunteer: false };
      const taskSwapPoint = direction === "offgoing" ? offgoingSwapPoint : picSwapPoint;
      tailTasks.push({
        name: crewMember?.name ?? name, crewMember, role: "PIC", direction, tail,
        aircraftType, swapPoint: taskSwapPoint, homeAirports,
        candidates: [], best: null, warnings,
        ...volFlags,
      });
    }

    // SIC tasks — try ALL swap points, pick the one with best transport
    if (!assignment.oncoming_sic) {
      globalWarnings.push(`${tail}: No oncoming SIC assigned — no qualified crew can reach this aircraft`);
    }
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

      if (direction === "oncoming" && swapPoints.length > 1) {
        // Try each swap point — run buildCandidates for each, pick the best
        let bestSwapPoint = picSwapPoint; // default to same as PIC
        let bestScore = -1;

        for (const sp of swapPoints) {
          const tempTask: CrewTask = {
            name: crewMember?.name ?? name, crewMember, role: "SIC",
            direction: "oncoming", tail, aircraftType, swapPoint: sp,
            homeAirports, candidates: [], best: null, warnings: [],
            ...sicVolFlags,
          };
          const candidates = buildCandidates(tempTask, aliases, commercialFlights, swapDate, byTail.get(tail));
          for (const c of candidates) {
            c.score = scoreCandidate(c, tempTask, null);
          }
          const topScore = candidates.reduce((max, c) => Math.max(max, c.score), 0);
          if (topScore > bestScore) {
            bestScore = topScore;
            bestSwapPoint = sp;
          }
        }

        if (bestSwapPoint !== picSwapPoint) {
          warnings.push(`SIC swaps at ${toIata(bestSwapPoint.icao)} (after ${bestSwapPoint.position}) — PIC covers SIC seat for earlier legs`);
        }

        tailTasks.push({
          name: crewMember?.name ?? name, crewMember, role: "SIC", direction, tail,
          aircraftType, swapPoint: bestSwapPoint, homeAirports,
          candidates: [], best: null, warnings,
          ...sicVolFlags,
        });
      } else {
        // Offgoing SIC or oncoming SIC with single swap point
        const oncomingSicTask = tailTasks.find((t) => t.role === "SIC" && t.direction === "oncoming");
        const sicSwapPoint = direction === "offgoing"
          ? offgoingSwapPoint  // idle tails: use late swap point for offgoing
          : (oncomingSicTask?.swapPoint ?? picSwapPoint);

        tailTasks.push({
          name: crewMember?.name ?? name, crewMember, role: "SIC", direction, tail,
          aircraftType, swapPoint: sicSwapPoint, homeAirports,
          candidates: [], best: null, warnings,
          ...sicVolFlags,
        });
      }
    }

    // Run optimizer for this tail
    optimizeTail(tailTasks, aliases, commercialFlights, swapDate, byTail.get(tail), offgoingDeadlines);
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
  const oncomingPics = allTasks.filter((t) => t.direction === "oncoming" && t.role === "PIC" && t.best?.fboArrivalTime);
  const byAirport = new Map<string, CrewTask[]>();
  for (const t of oncomingPics) {
    const icao = t.swapPoint.icao;
    if (!byAirport.has(icao)) byAirport.set(icao, []);
    byAirport.get(icao)!.push(t);
  }
  for (const [icao, picTasks] of byAirport) {
    if (picTasks.length < 2) continue;
    picTasks.sort((a, b) => a.best!.fboArrivalTime!.getTime() - b.best!.fboArrivalTime!.getTime());
    for (let i = 1; i < picTasks.length; i++) {
      const prev = picTasks[i - 1];
      const curr = picTasks[i];
      const gapHours = (curr.best!.fboArrivalTime!.getTime() - prev.best!.fboArrivalTime!.getTime()) / (60 * 60_000);
      if (gapHours < STAGGER_MIN_GAP_HOURS) {
        const warnMsg = `${toIata(icao)}: ${prev.tail} and ${curr.tail} oncoming within ${Math.round(gapHours * 60)}min — consider staggering`;
        curr.warnings.push(warnMsg);
        prev.warnings.push(warnMsg);
        globalWarnings.push(warnMsg);
      }
    }
  }

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
      duty_off_time: null,
      is_checkairman: task.crewMember?.is_checkairman ?? false,
      is_skillbridge: task.crewMember?.is_skillbridge ?? false,
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
      warnings: task.warnings,
      drive_estimate: best?.drive ?? null,
      flight_offer: best?.offer ?? null,
      alt_flights: altFlights,
      backup_flight: backupStr,
      score: best?.score ?? 0,
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
}): FeasibilityEntry[] {
  const { pool, role, tails, byTail, swapDate, aliases, commercialFlights, crewRoster, tailAircraftType, preComputedRoutes, preComputedOffgoing } = params;
  const matrix: FeasibilityEntry[] = [];

  for (const tail of tails) {
    const { swapPoints } = extractSwapPoints(tail, byTail, swapDate);
    if (swapPoints.length === 0) continue;

    // Determine the FBO airports this tail can swap at
    const tailSwapIcaos = new Set(swapPoints.map((sp) => sp.icao.toUpperCase()));

    // SIC tries all swap points (can swap at intermediate airports).
    // PIC: in drive-only mode, try ALL swap points (commercial accessibility irrelevant).
    // With flights, pick BEST swap point by commercial accessibility for perf.
    let swapPointsToTry = swapPoints;
    if (role === "PIC" && swapPoints.length > 1 && (commercialFlights || preComputedRoutes)) {
      let bestSp = swapPoints[0];
      let bestEase = -Infinity;
      for (const sp of swapPoints) {
        const commAirports = findAllCommercialAirports(sp.icao, aliases);
        let minDrive = Infinity;
        for (const c of commAirports) {
          if (c.toUpperCase() === sp.icao.toUpperCase()) { minDrive = 0; break; }
          const d = estimateDriveTime(sp.icao, c);
          if (d) minDrive = Math.min(minDrive, d.estimated_drive_minutes);
        }
        const ease = -(minDrive === Infinity ? 999 : minDrive) + commAirports.length * 2;
        if (ease > bestEase) { bestEase = ease; bestSp = sp; }
      }
      swapPointsToTry = [bestSp];
    }
    const acType = tailAircraftType.get(tail) ?? "unknown";

    for (const poolEntry of pool) {
      if (!isQualified(poolEntry.aircraft_type, acType)) {
        matrix.push({ crewName: poolEntry.name, tail, viable: false, bestScore: 0, bestCost: 999, offgoingCost: 0, totalCost: 999, bestType: "none", candidateCount: 0, rank: 999, bestSwapIcao: "", minDriveMiles: 9999 });
        continue;
      }

      // Find or create a CrewMember from the roster for this pool entry
      const crewMember = findCrewByName(crewRoster, poolEntry.name, role);
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
        const rank = costNorm * 0.40 + reliabilityNorm * 0.25 + proximityNorm * 0.20 + crewDiff * 0.15;

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

      // ── RUNTIME EVALUATION PATH (fallback — original buildCandidates) ───
      let allCandidates: TransportCandidate[] = [];

      for (const sp of swapPointsToTry) {
        const task: CrewTask = {
          name: poolEntry.name, crewMember, role, direction: "oncoming",
          tail, aircraftType: acType, swapPoint: sp, homeAirports,
          candidates: [], best: null, warnings: [],
          earlyVolunteer: poolEntry.early_volunteer,
          lateVolunteer: poolEntry.late_volunteer,
        };
        const spCandidates = buildCandidates(task, aliases, commercialFlights, swapDate, byTail.get(tail));
        for (const c of spCandidates) {
          c.score = scoreCandidate(c, task, null);
        }
        allCandidates.push(...spCandidates);
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

      // Candidates already scored in the swap-point loop above
      candidates.sort((a, b) => b.score - a.score);

      const best = candidates[0];
      const viable = best ? best.type !== "none" : false;

      // Determine which swap point the best candidate targets
      const bestSwapIcao = best?.to ? toIcao(best.to) : (swapPoints[0]?.icao ?? "");

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
      const rank = costNorm * 0.45 + reliabilityNorm * 0.3 + proximityNorm * 0.25;

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

  return matrix;
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
}): {
  assignments: Record<string, SwapAssignment>;
  standby: { pic: string[]; sic: string[] };
  details: { name: string; tail: string; cost: number; reason: string }[];
} {
  const { swapAssignments, oncomingPool, crewRoster, flights, swapDate, aliases = [], commercialFlights, preComputedRoutes, preComputedOffgoing, excludeTails } = params;
  const result: Record<string, SwapAssignment> = JSON.parse(JSON.stringify(swapAssignments));
  const details: { name: string; tail: string; cost: number; reason: string }[] = [];

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

  // Assign PICs then SICs using feasibility matrix
  assignRoleWithMatrix("oncoming_pic", oncomingPool.pic, "PIC", result, byTail, swapDate, aliases, commercialFlights, crewRoster, tailAircraftType, details, preComputedRoutes, preComputedOffgoing, excludeTails);
  assignRoleWithMatrix("oncoming_sic", oncomingPool.sic, "SIC", result, byTail, swapDate, aliases, commercialFlights, crewRoster, tailAircraftType, details, preComputedRoutes, preComputedOffgoing, excludeTails);

  // Remaining pool → standby
  const assignedNames = new Set(details.map((d) => d.name));
  const standby = {
    pic: oncomingPool.pic.filter((p) => !assignedNames.has(p.name)).map((p) => p.name),
    sic: oncomingPool.sic.filter((p) => !assignedNames.has(p.name)).map((p) => p.name),
  };

  return { assignments: result, standby, details };
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
}): {
  result: SwapPlanResult;
  assignmentResult: ReturnType<typeof assignOncomingCrew>;
  twoPassStats: TwoPassStats;
} {
  const { swapAssignments, oncomingPool, crewRoster, flights, swapDate, aliases, commercialFlights, preComputedRoutes, preComputedOffgoing, excludeTails } = params;

  // ── Pass 1: Normal Wednesday only (exclude early/late volunteers) ──────
  const normalPool: OncomingPool = {
    pic: oncomingPool.pic.filter((p) => !p.early_volunteer && !p.late_volunteer),
    sic: oncomingPool.sic.filter((p) => !p.early_volunteer && !p.late_volunteer),
  };

  // Also include SkillBridge crew in pass 1 — they can be forced, no bonus
  const skillbridgeEarlyPic = oncomingPool.pic.filter((p) => p.is_skillbridge && (p.early_volunteer || p.late_volunteer));
  const skillbridgeEarlySic = oncomingPool.sic.filter((p) => p.is_skillbridge && (p.early_volunteer || p.late_volunteer));
  normalPool.pic.push(...skillbridgeEarlyPic);
  normalPool.sic.push(...skillbridgeEarlySic);

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
      total_cost: pass1Cost,
    };
    return {
      result: { ...pass1Result, two_pass: stats },
      assignmentResult: pass1Assignment,
      twoPassStats: stats,
    };
  }

  // ── Pass 2: Add early/late volunteers for unsolved tails ──────────────
  console.log(`[Two-Pass] Pass 1: ${pass1Solved} solved, ${pass1Unsolved} unsolved (${[...unsolvedTails].join(", ")}). Running Pass 2 with volunteers...`);

  // Get paid (non-SkillBridge) early/late volunteers
  const volunteerPic = oncomingPool.pic.filter(
    (p) => (p.early_volunteer || p.late_volunteer) && !p.is_skillbridge,
  );
  const volunteerSic = oncomingPool.sic.filter(
    (p) => (p.early_volunteer || p.late_volunteer) && !p.is_skillbridge,
  );

  // Build a new assignment set — start from pass 1 but clear oncoming for unsolved tails
  const pass2Assignments: Record<string, SwapAssignment> = JSON.parse(JSON.stringify(pass1Assignment.assignments));
  for (const tail of unsolvedTails) {
    if (pass2Assignments[tail]) {
      // Only clear oncoming slots that were unsolved
      const unsolvedPic = unsolvedRows.some((r) => r.tail_number === tail && r.direction === "oncoming" && r.role === "PIC");
      const unsolvedSic = unsolvedRows.some((r) => r.tail_number === tail && r.direction === "oncoming" && r.role === "SIC");
      if (unsolvedPic) pass2Assignments[tail].oncoming_pic = null;
      if (unsolvedSic) pass2Assignments[tail].oncoming_sic = null;
    }
  }

  // Run assignment with full pool (volunteers included) but only for unsolved tails
  const fullPool: OncomingPool = {
    pic: [...normalPool.pic, ...volunteerPic],
    sic: [...normalPool.sic, ...volunteerSic],
  };

  const pass2Assignment = assignOncomingCrew({
    swapAssignments: pass2Assignments,
    oncomingPool: fullPool,
    crewRoster,
    flights,
    swapDate,
    aliases,
    commercialFlights,
    preComputedRoutes,
    preComputedOffgoing,
    excludeTails,
  });

  // Merge pass 2 results into pass 1: only replace unsolved tails
  const mergedAssignments = { ...pass1Assignment.assignments };
  const volunteersUsed: TwoPassStats["pass2_volunteers_used"] = [];
  const volunteerNames = new Set([
    ...volunteerPic.map((p) => p.name),
    ...volunteerSic.map((p) => p.name),
  ]);

  for (const tail of unsolvedTails) {
    if (pass2Assignment.assignments[tail]) {
      const p2 = pass2Assignment.assignments[tail];
      const p1 = mergedAssignments[tail];

      if (p2.oncoming_pic && !p1.oncoming_pic) {
        mergedAssignments[tail] = { ...p1, oncoming_pic: p2.oncoming_pic };
        if (volunteerNames.has(p2.oncoming_pic)) {
          const entry = oncomingPool.pic.find((p) => p.name === p2.oncoming_pic);
          volunteersUsed.push({
            name: p2.oncoming_pic, role: "PIC", tail,
            type: entry?.early_volunteer ? "early" : "late",
          });
        }
      }
      if (p2.oncoming_sic && !p1.oncoming_sic) {
        mergedAssignments[tail] = { ...mergedAssignments[tail], oncoming_sic: p2.oncoming_sic };
        if (volunteerNames.has(p2.oncoming_sic)) {
          const entry = oncomingPool.sic.find((p) => p.name === p2.oncoming_sic);
          volunteersUsed.push({
            name: p2.oncoming_sic, role: "SIC", tail,
            type: entry?.early_volunteer ? "early" : "late",
          });
        }
      }
    }
  }

  // Compute bonus cost
  const bonusCost = volunteersUsed.reduce((sum, v) => {
    if (v.role === "PIC") return sum + EARLY_LATE_BONUS_PIC;
    return sum + EARLY_LATE_BONUS_SIC;
  }, 0);

  // Run final transport optimizer with merged assignments
  const finalResult = buildSwapPlan({
    flights, crewRoster, aliases, swapDate, commercialFlights,
    swapAssignments: mergedAssignments,
    oncomingPool: fullPool,
    strategy: "offgoing_first",
  });

  const pass2NewlySolved = pass1Unsolved - finalResult.unsolved_count;

  const stats: TwoPassStats = {
    pass1_solved: pass1Solved,
    pass1_unsolved: pass1Unsolved,
    pass1_cost: pass1Cost,
    pass2_solved: pass2NewlySolved,
    pass2_volunteers_used: volunteersUsed,
    pass2_bonus_cost: bonusCost,
    total_cost: finalResult.total_cost + bonusCost,
  };

  // Add volunteer bonus warnings
  for (const v of volunteersUsed) {
    const bonus = v.role === "PIC" ? EARLY_LATE_BONUS_PIC : EARLY_LATE_BONUS_SIC;
    finalResult.warnings.push(`${v.name} (${v.role}) used as ${v.type} volunteer on ${v.tail} — $${bonus} bonus`);
  }

  // Merge standby from both passes
  const mergedStandby = {
    pic: pass2Assignment.standby.pic,
    sic: pass2Assignment.standby.sic,
  };

  console.log(`[Two-Pass] Pass 2: ${pass2NewlySolved} additional tails solved, ${volunteersUsed.length} volunteers used, $${bonusCost} bonus cost`);

  return {
    result: { ...finalResult, two_pass: stats },
    assignmentResult: { assignments: mergedAssignments, standby: mergedStandby, details: [...pass1Assignment.details, ...pass2Assignment.details] },
    twoPassStats: stats,
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
): void {
  const needingTails = Object.keys(result).filter((tail) => !result[tail][field] && !excludeTails?.has(tail));
  if (needingTails.length === 0 || pool.length === 0) return;

  // Build full feasibility matrix — uses pre-computed routes when available
  const matrix = buildFeasibilityMatrix({
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
  });

  // Only consider viable options (where real transport exists)
  const viableOptions = matrix.filter((m) => m.viable);

  // Count viable tails per crew AND viable crew per tail
  const viableTailsPerCrew = new Map<string, number>();
  const viableCrewPerTail = new Map<string, number>();
  for (const opt of viableOptions) {
    viableTailsPerCrew.set(opt.crewName, (viableTailsPerCrew.get(opt.crewName) ?? 0) + 1);
    viableCrewPerTail.set(opt.tail, (viableCrewPerTail.get(opt.tail) ?? 0) + 1);
  }

  // Sort: CREW-FIRST — most constrained crew first (fewest viable tails).
  // "Mark Smith at TVC can only reach 2 tails — assign him first before
  //  someone at ATL (who can reach 15 tails) steals his only option."
  // Tiebreak: best rank (cost + reliability + proximity blend).
  viableOptions.sort((a, b) => {
    const aCrewConstraint = viableTailsPerCrew.get(a.crewName) ?? 999;
    const bCrewConstraint = viableTailsPerCrew.get(b.crewName) ?? 999;
    if (aCrewConstraint !== bCrewConstraint) return aCrewConstraint - bCrewConstraint;
    // Secondary: if crew equally constrained, prefer the more constrained tail
    const aTailConstraint = viableCrewPerTail.get(a.tail) ?? 999;
    const bTailConstraint = viableCrewPerTail.get(b.tail) ?? 999;
    if (aTailConstraint !== bTailConstraint) return aTailConstraint - bTailConstraint;
    return a.rank - b.rank;
  });

  // Greedy assignment — hardest-to-move crew first, best fit within each
  const assignedCrews = new Set<string>();
  const assignedTails = new Set<string>();

  for (const opt of viableOptions) {
    if (assignedCrews.has(opt.crewName) || assignedTails.has(opt.tail)) continue;
    result[opt.tail][field] = opt.crewName;
    assignedCrews.add(opt.crewName);
    assignedTails.add(opt.tail);

    const loc = extractSwapPoints(opt.tail, byTail, swapDate).swapPoints[0];
    const crewConstraint = viableTailsPerCrew.get(opt.crewName) ?? 0;
    const tailConstraint = viableCrewPerTail.get(opt.tail) ?? 0;
    const swapIata = opt.bestSwapIcao ? toIata(opt.bestSwapIcao) : (loc ? toIata(loc.icao) : "?");
    const driveMi = opt.minDriveMiles < 9999 ? `${Math.round(opt.minDriveMiles)}mi` : "?mi";
    const constrainedTag = crewConstraint <= 2 ? " [CREW-CONSTRAINED]" : (tailConstraint <= 2 ? " [TAIL-CONSTRAINED]" : "");

    // Build alternatives list: other viable tails for this crew, ranked
    const alternatives = viableOptions
      .filter((v) => v.crewName === opt.crewName && v.tail !== opt.tail && !assignedTails.has(v.tail))
      .sort((a, b) => a.rank - b.rank)
      .slice(0, 3)
      .map((v) => `${v.tail}(rank=${v.rank.toFixed(1)})`);
    const altStr = alternatives.length > 0 ? ` alt tails: ${alternatives.join(", ")}` : " (only viable tail)";

    const offStr = opt.offgoingCost > 0 ? ` +$${Math.round(opt.offgoingCost)} offgoing` : "";
    const reason = `${opt.bestType} $${Math.round(opt.bestCost)}${offStr} (total $${Math.round(opt.totalCost)}) score=${opt.bestScore} to ${swapIata} | proximity=${driveMi} rank=${opt.rank.toFixed(1)} (crew→${crewConstraint} tails, tail→${tailConstraint} crew)${constrainedTag}${altStr}`;
    console.log(`[Assignment] ${role} ${opt.crewName} → ${opt.tail} @ ${swapIata}: ${reason}`);

    details.push({
      name: opt.crewName,
      tail: opt.tail,
      cost: Math.round(opt.totalCost),
      reason,
    });
  }

  // No fallback — only assign crew with proven transport.
  // Unassigned tails show up in buildSwapPlan output with clear "needs flights" status.
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

    const swapPoint = swapPoints[0];

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
      task.candidates.sort((a, b) => b.score - a.score);
      task.best = task.candidates[0] ?? null;

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
        unsolvable.push({
          tail, role,
          reason: `No viable transport for offgoing ${offName} from ${swapPoint.icao}`,
        });
      }
    }
  }

  return { offgoingPlans, deadlines, unsolvable };
}
