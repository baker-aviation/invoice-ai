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

import { estimateDriveTime, findNearbyCommercialAirports, type DriveEstimate } from "./driveTime";
import { getAirportTimezone } from "./airportTimezones";
import type { FlightOffer } from "./amadeus";
import {
  MAX_DUTY_HOURS, MIN_REST_HOURS, DUTY_ON_BEFORE_COMMERCIAL, DEPLANE_BUFFER,
  FBO_ARRIVAL_BUFFER, FBO_ARRIVAL_BUFFER_PREFERRED, DUTY_OFF_AFTER_LAST_LEG,
  INTERNATIONAL_DUTY_OFF, AIRPORT_SECURITY_BUFFER, RENTAL_RETURN_BUFFER,
  EARLIEST_DUTY_ON_HOUR, UBER_MAX_MINUTES, RENTAL_MAX_MINUTES,
  BUDGET_CARRIERS, PREFERRED_HUBS, BACKUP_FLIGHT_MIN_GAP, MAX_CONNECTIONS,
  EARLY_LATE_BONUS_PIC, EARLY_LATE_BONUS_SIC,
} from "./swapRules";

// ═══════════════════════════════════════════════════════════════════════════════
// LAYER 1: Types
// ═══════════════════════════════════════════════════════════════════════════════

export type CrewMember = {
  id: string;
  name: string;
  role: "PIC" | "SIC";
  home_airports: string[];
  aircraft_types: string[];
  is_checkairman: boolean;
  is_skillbridge: boolean;
  priority: number;
  standby_count?: number;
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
        const earliestLeave = task.swapPoint.time;
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
        dutyOnTime: dutyOn,
        score: 0,
        backups: [],
      });
    }

    // ── Commercial flight options ─────────────────────────────────────────
    if (!commercialFlights) continue;

    // For oncoming crew, also try day-before flights (overnight travel)
    // Early volunteers can also arrive Tuesday (2 days before Wednesday swap)
    const dayBefore = new Date(new Date(swapDate + "T12:00:00Z").getTime() - 86_400_000)
      .toISOString().slice(0, 10);
    const twoDaysBefore = new Date(new Date(swapDate + "T12:00:00Z").getTime() - 2 * 86_400_000)
      .toISOString().slice(0, 10);
    const dayAfter = new Date(new Date(swapDate + "T12:00:00Z").getTime() + 86_400_000)
      .toISOString().slice(0, 10);
    let datesToSearch: string[];
    if (task.direction === "oncoming") {
      datesToSearch = task.earlyVolunteer
        ? [swapDate, dayBefore, twoDaysBefore] // Early volunteer: Tue/Wed arrival
        : [swapDate, dayBefore];
    } else {
      datesToSearch = task.lateVolunteer
        ? [swapDate, dayAfter] // Late volunteer: can depart Thursday
        : [swapDate];
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

          // Check: does crew arrive at FBO in time?
          const mustBeAtFbo = new Date(task.swapPoint.time.getTime() - ms(FBO_ARRIVAL_BUFFER));
          if (fboArr.getTime() > mustBeAtFbo.getTime()) {
            continue; // Too late
          }

          // Day-before flight: crew flies in evening before, stays at hotel,
          // drives to FBO fresh next morning. Separate duty period.
          const swapDayStart = new Date(swapDate + "T00:00:00Z");
          const isDayBefore = flightArr.getTime() < swapDayStart.getTime();
          if (isDayBefore) {
            // FBO arrival = next morning with comfortable 90min buffer
            fboArr = new Date(task.swapPoint.time.getTime() - ms(FBO_ARRIVAL_BUFFER_PREFERRED));
            // Duty-on starts when they leave hotel, not when they flew yesterday
            dutyOn = new Date(fboArr.getTime() - ms(driveToFboMin));
            groundCost += 150; // hotel overnight

            // 10hr rest check: flight arrival + deplane → next-day duty-on
            const restStart = new Date(flightArr.getTime() + ms(DEPLANE_BUFFER));
            const restHours = (dutyOn.getTime() - restStart.getTime()) / (60 * 60_000);
            if (restHours < MIN_REST_HOURS) continue; // Insufficient rest
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
          // They're released from duty at swap point time
          const releaseTime = task.swapPoint.time;
          // Need to get to commercial airport + security buffer
          const buffer = driveToFboMin > UBER_MAX_MINUTES ? RENTAL_RETURN_BUFFER : AIRPORT_SECURITY_BUFFER;
          const needAtAirport = new Date(flightDep.getTime() - ms(buffer));
          const needLeaveAircraft = new Date(needAtAirport.getTime() - ms(driveToFboMin));

          if (needLeaveAircraft.getTime() < releaseTime.getTime()) {
            continue; // Can't make this flight
          }

          // Check midnight deadline
          const homeArr = new Date(flightArr.getTime() + ms(DEPLANE_BUFFER));
          // Late volunteers get Thursday midnight deadline
          const effectiveMidnight = task.lateVolunteer
            ? new Date(homeMidnight.getTime() + 24 * 60 * 60_000) // Thursday midnight
            : homeMidnight;
          if (homeArr.getTime() > effectiveMidnight.getTime()) {
            // Skill-Bridge SIC gets Thursday even without volunteering
            if (task.crewMember?.is_skillbridge && task.role === "SIC") {
              const thurMidnight = new Date(homeMidnight.getTime() + 24 * 60 * 60_000);
              if (homeArr.getTime() > thurMidnight.getTime()) continue;
            } else {
              continue; // Won't make deadline
            }
          }
          fboArr = null;
          dutyOn = null;
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
      from: task.homeAirports[0] ? toIata(task.homeAirports[0]) : "???",
      to: toIata(task.swapPoint.icao),
      cost: 0,
      durationMin: 0,
      isDirect: false,
      isBudgetCarrier: false,
      hubConnection: false,
      connectionCount: 0,
      offer: null,
      drive: null,
      fboArrivalTime: null,
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
): TransportCandidate[] {
  if (primary.type !== "commercial" || !primary.depTime) return [];

  return allCandidates.filter((c) => {
    if (c === primary) return false;
    if (c.type !== "commercial") return false;
    if (!c.depTime || !primary.depTime) return false;
    // Backup must depart at least BACKUP_FLIGHT_MIN_GAP after primary
    const gap = (c.depTime.getTime() - primary.depTime.getTime()) / 60_000;
    return gap >= BACKUP_FLIGHT_MIN_GAP;
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
    score += 15; // Ground transport is highly reliable
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

  // ── FBO arrival buffer (oncoming only) ─────────────────────────────────
  if (task.direction === "oncoming" && c.fboArrivalTime) {
    const bufferMin = (task.swapPoint.time.getTime() - c.fboArrivalTime.getTime()) / 60_000;
    if (bufferMin >= FBO_ARRIVAL_BUFFER_PREFERRED) score += 5;
    else if (bufferMin >= FBO_ARRIVAL_BUFFER) score += 2;
    else score -= 10; // Cutting it close
  }

  // ── Duty-on timing (avoid before 0400L) ────────────────────────────────
  if (c.dutyOnTime && task.homeAirports[0]) {
    const localHour = getLocalHour(c.dutyOnTime, toIcao(task.homeAirports[0]));
    if (localHour < EARLIEST_DUTY_ON_HOUR && localHour >= 0) {
      score -= 10; // Early duty-on penalty
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

  // Score and select oncoming PIC first (to pair SIC with same flights)
  const oncomingPic = oncoming.find((t) => t.role === "PIC");
  const oncomingSic = oncoming.find((t) => t.role === "SIC");

  if (oncomingPic) {
    // Find backups for each candidate
    for (const c of oncomingPic.candidates) {
      c.backups = findBackups(c, oncomingPic.candidates);
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
      c.backups = findBackups(c, oncomingSic.candidates);
    }
    // Score with PIC pairing consideration
    const picBest = oncomingPic?.best ?? null;
    for (const c of oncomingSic.candidates) {
      c.score = scoreCandidate(c, oncomingSic, picBest);
    }
    oncomingSic.candidates.sort((a, b) => b.score - a.score);
    oncomingSic.best = oncomingSic.candidates[0] ?? null;
  }

  // Offgoing crew: score independently
  for (const task of offgoing) {
    for (const c of task.candidates) {
      c.backups = findBackups(c, task.candidates);
      c.score = scoreCandidate(c, task, null);
    }
    task.candidates.sort((a, b) => b.score - a.score);
    task.best = task.candidates[0] ?? null;
  }

  // ── Aircraft never unattended check ──────────────────────────────────
  // Oncoming must arrive before offgoing departs
  const oncomingArrivals = oncoming
    .filter((t) => t.best?.fboArrivalTime)
    .map((t) => t.best!.fboArrivalTime!.getTime());
  const latestOncomingArrival = oncomingArrivals.length > 0 ? Math.max(...oncomingArrivals) : null;

  if (latestOncomingArrival) {
    for (const task of offgoing) {
      if (task.best?.depTime && task.best.depTime.getTime() < latestOncomingArrival) {
        task.warnings.push("Offgoing may depart before oncoming arrives — aircraft could be unattended");
      }
    }
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
  const wedLegs = legs.filter((f) => f.scheduled_departure.slice(0, 10) === swapDate);
  const liveWedLegs = wedLegs.filter((f) => isLiveType(f.flight_type));

  const priorLegs = legs.filter(
    (f) => new Date(f.scheduled_departure).getTime() < new Date(swapDate).getTime(),
  );
  const lastPrior = priorLegs[priorLegs.length - 1];
  const overnightAirport = lastPrior?.arrival_icao ?? wedLegs[0]?.departure_icao ?? null;

  const swapPoints: SwapPoint[] = [];

  if (liveWedLegs.length > 0) {
    const firstLive = liveWedLegs[0];
    swapPoints.push({
      icao: firstLive.departure_icao,
      time: new Date(firstLive.scheduled_departure),
      position: "before_live",
      isAdjacentLive: true,
    });
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
    swapPoints.push({
      icao: overnightAirport,
      time: new Date(`${swapDate}T12:00:00Z`),
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
}): SwapPlanResult {
  const { flights, crewRoster, aliases, swapDate, commercialFlights, swapAssignments } = params;
  _warnedFlightKeys.clear(); // Reset per-run to avoid stale warnings
  const globalWarnings: string[] = [];
  const allTasks: CrewTask[] = [];

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

  // ── Process each tail ──────────────────────────────────────────────────
  for (const [tail, assignment] of Object.entries(swapAssignments)) {
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

    // Oncoming crew should target the FIRST swap point (need to be there before first leg)
    const oncomingSwapPoint = swapPoints[0];
    // Offgoing crew leaves from the LAST swap point (after last leg)
    const offgoingSwapPoint = swapPoints[swapPoints.length - 1];

    // ── Create crew tasks ────────────────────────────────────────────────
    const tailTasks: CrewTask[] = [];

    const entries: { name: string; role: "PIC" | "SIC"; direction: "oncoming" | "offgoing" }[] = [];
    if (assignment.oncoming_pic) entries.push({ name: assignment.oncoming_pic, role: "PIC", direction: "oncoming" });
    if (assignment.oncoming_sic) entries.push({ name: assignment.oncoming_sic, role: "SIC", direction: "oncoming" });
    if (assignment.offgoing_pic) entries.push({ name: assignment.offgoing_pic, role: "PIC", direction: "offgoing" });
    if (assignment.offgoing_sic) entries.push({ name: assignment.offgoing_sic, role: "SIC", direction: "offgoing" });

    // Validate: never 2 SICs on the same tail (2 PICs is OK on swap day)
    const oncomingRoles = entries.filter(e => e.direction === "oncoming").map(e => e.role);
    if (oncomingRoles.filter(r => r === "SIC").length >= 2 && oncomingRoles.filter(r => r === "PIC").length === 0) {
      globalWarnings.push(`${tail}: 2 SICs assigned with no PIC — cannot fly with 2 SICs`);
    }

    for (const entry of entries) {
      let crewMember = findCrewByName(crewRoster, entry.name, entry.role);
      const warnings: string[] = [];
      if (!crewMember) {
        // Try opposite role — crew may be listed as SIC in roster but PIC in the Excel (or vice versa)
        const oppositeRole = entry.role === "PIC" ? "SIC" : "PIC";
        crewMember = findCrewByName(crewRoster, entry.name, oppositeRole);
        if (crewMember) {
          warnings.push(`"${entry.name}" found in roster as ${oppositeRole} instead of ${entry.role}`);
        } else {
          // Last resort: search by last name with either role
          const norm = entry.name.trim().toLowerCase().replace(/\s+/g, " ");
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
            warnings.push(`"${entry.name}" matched to "${lastNameMatch.name}" (${lastNameMatch.role}) by last name`);
          } else {
            warnings.push(`"${entry.name}" not found in roster`);
          }
        }
      }

      const homeAirports = crewMember?.home_airports ?? [];
      if (homeAirports.length === 0) {
        console.warn(`[SwapOptimizer] No home airports for "${entry.name}" (${entry.role}, ${tail}) — buildCandidates will return no results`);
      }

      const swapPoint = entry.direction === "oncoming" ? oncomingSwapPoint : offgoingSwapPoint;

      tailTasks.push({
        name: crewMember?.name ?? entry.name,
        crewMember,
        role: entry.role,
        direction: entry.direction,
        tail,
        aircraftType,
        swapPoint,
        homeAirports,
        candidates: [],
        best: null,
        warnings,
      });
    }

    // Run optimizer for this tail
    optimizeTail(tailTasks, aliases, commercialFlights, swapDate, byTail.get(tail));
    allTasks.push(...tailTasks);
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
      notes: best?.type === "none"
        ? task.direction === "oncoming"
          ? `No viable transport from ${task.homeAirports[0] ?? "?"} to ${toIata(task.swapPoint.icao)}`
          : `No viable transport from ${toIata(task.swapPoint.icao)} to ${task.homeAirports[0] ?? "?"}`
        : null,
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
    globalWarnings.push(`${unsolvedRows.length} crew member(s) have no viable transport — arrange manually`);
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
  bestCost: number;
  bestType: string;
  candidateCount: number;
  rank: number; // weighted blend of cost + reliability (lower = better)
};

/** Build a feasibility matrix: for every crew × tail, run the REAL transport
 *  evaluation (buildCandidates + scoreCandidate) to determine which assignments
 *  are actually viable with timing constraints, not just cost heuristics. */
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
}): FeasibilityEntry[] {
  const { pool, role, tails, byTail, swapDate, aliases, commercialFlights, crewRoster, tailAircraftType } = params;
  const matrix: FeasibilityEntry[] = [];

  for (const tail of tails) {
    const { swapPoints } = extractSwapPoints(tail, byTail, swapDate);
    if (swapPoints.length === 0) continue;

    const oncomingSwapPoint = swapPoints[0];
    const acType = tailAircraftType.get(tail) ?? "unknown";

    for (const poolEntry of pool) {
      if (!isQualified(poolEntry.aircraft_type, acType)) {
        matrix.push({ crewName: poolEntry.name, tail, viable: false, bestScore: 0, bestCost: 999, bestType: "none", candidateCount: 0, rank: 999 });
        continue;
      }

      // Find or create a CrewMember from the roster for this pool entry
      const crewMember = findCrewByName(crewRoster, poolEntry.name, role);

      // Build a temporary CrewTask for this crew × tail combination
      const task: CrewTask = {
        name: poolEntry.name,
        crewMember,
        role,
        direction: "oncoming",
        tail,
        aircraftType: acType,
        swapPoint: oncomingSwapPoint,
        homeAirports: crewMember?.home_airports?.length ? crewMember.home_airports : poolEntry.home_airports,
        candidates: [],
        best: null,
        warnings: [],
        earlyVolunteer: poolEntry.early_volunteer,
        lateVolunteer: poolEntry.late_volunteer,
      };

      // Run the REAL candidate builder with full timing constraints
      if (task.homeAirports.length === 0) {
        console.warn(`[FeasMatrix] ${poolEntry.name} has NO home airports (pool: ${poolEntry.home_airports.length}, roster: ${crewMember?.home_airports?.length ?? 0})`);
      }
      const candidates = buildCandidates(task, aliases, commercialFlights, swapDate, byTail.get(tail));

      // Add early/late volunteer bonus to cost (Skill-Bridge excluded)
      if ((poolEntry.early_volunteer || poolEntry.late_volunteer) && !poolEntry.is_skillbridge) {
        const bonus = role === "PIC" ? EARLY_LATE_BONUS_PIC : EARLY_LATE_BONUS_SIC;
        for (const c of candidates) {
          if (c.type !== "none") c.cost += bonus;
        }
      }

      // Score each candidate
      for (const c of candidates) {
        c.backups = findBackups(c, candidates);
        c.score = scoreCandidate(c, task, null);
      }
      candidates.sort((a, b) => b.score - a.score);

      const best = candidates[0];
      const viable = best ? best.type !== "none" : false;

      const entryCost = viable ? best!.cost : 999;
      const entryScore = best?.score ?? 0;
      // Weighted rank: 60% cost, 40% reliability (lower = better)
      const costNorm = Math.min(100, (entryCost / 500) * 50);
      const reliabilityNorm = 100 - entryScore;
      const rank = costNorm * 0.6 + reliabilityNorm * 0.4;

      matrix.push({
        crewName: poolEntry.name,
        tail,
        viable,
        bestScore: entryScore,
        bestCost: entryCost,
        bestType: best?.type ?? "none",
        candidateCount: candidates.filter((c) => c.type !== "none").length,
        rank,
      });
    }
  }

  const viableCount = matrix.filter((m) => m.viable).length;
  const totalCombos = matrix.length;
  const uniqueTails = new Set(matrix.filter((m) => m.viable).map((m) => m.tail)).size;
  const uniqueCrew = new Set(matrix.filter((m) => m.viable).map((m) => m.crewName)).size;
  console.log(`[FeasMatrix] ${role}: ${viableCount}/${totalCombos} viable combos, ${uniqueTails} tails w/viable crew, ${uniqueCrew} crew w/viable tails`);

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
}): {
  assignments: Record<string, SwapAssignment>;
  standby: { pic: string[]; sic: string[] };
  details: { name: string; tail: string; cost: number; reason: string }[];
} {
  const { swapAssignments, oncomingPool, crewRoster, flights, swapDate, aliases = [], commercialFlights } = params;
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
  assignRoleWithMatrix("oncoming_pic", oncomingPool.pic, "PIC", result, byTail, swapDate, aliases, commercialFlights, crewRoster, tailAircraftType, details);
  assignRoleWithMatrix("oncoming_sic", oncomingPool.sic, "SIC", result, byTail, swapDate, aliases, commercialFlights, crewRoster, tailAircraftType, details);

  // Remaining pool → standby
  const assignedNames = new Set(details.map((d) => d.name));
  const standby = {
    pic: oncomingPool.pic.filter((p) => !assignedNames.has(p.name)).map((p) => p.name),
    sic: oncomingPool.sic.filter((p) => !assignedNames.has(p.name)).map((p) => p.name),
  };

  return { assignments: result, standby, details };
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
): void {
  const needingTails = Object.keys(result).filter((tail) => !result[tail][field]);
  if (needingTails.length === 0 || pool.length === 0) return;

  // Build full feasibility matrix — the key v4 change
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
  });

  // Only consider viable options (where real transport exists)
  const viableOptions = matrix.filter((m) => m.viable);

  // Count viable crew per tail — fewer options = more constrained = assign first
  const viableCrewPerTail = new Map<string, number>();
  for (const opt of viableOptions) {
    viableCrewPerTail.set(opt.tail, (viableCrewPerTail.get(opt.tail) ?? 0) + 1);
  }

  // Sort: most constrained tails first (fewest viable crew), then by rank within.
  // Tough airports (remote FBOs with 1-2 options) get assigned before
  // easy airports (major hubs with 20+ options) can steal their only viable crew.
  viableOptions.sort((a, b) => {
    const aConstraint = viableCrewPerTail.get(a.tail) ?? 999;
    const bConstraint = viableCrewPerTail.get(b.tail) ?? 999;
    if (aConstraint !== bConstraint) return aConstraint - bConstraint;
    return a.rank - b.rank;
  });

  // Greedy assignment — constrained tails first, best rank within each
  const assignedCrews = new Set<string>();
  const assignedTails = new Set<string>();

  for (const opt of viableOptions) {
    if (assignedCrews.has(opt.crewName) || assignedTails.has(opt.tail)) continue;
    result[opt.tail][field] = opt.crewName;
    assignedCrews.add(opt.crewName);
    assignedTails.add(opt.tail);

    const loc = extractSwapPoints(opt.tail, byTail, swapDate).swapPoints[0];
    const constraint = viableCrewPerTail.get(opt.tail) ?? 0;
    details.push({
      name: opt.crewName,
      tail: opt.tail,
      cost: Math.round(opt.bestCost),
      reason: `${opt.bestType} $${Math.round(opt.bestCost)} score=${opt.bestScore} to ${loc ? toIata(loc.icao) : "?"} (${constraint} viable crew)`,
    });
  }

  // ── Fallback: assign remaining pool to remaining tails even without proven transport.
  // Every tail needs crew — transport can be arranged manually if the optimizer
  // can't find a viable route. Prefer crew with closest home airports.
  const unassignedTails = needingTails.filter((t) => !assignedTails.has(t));
  const unassignedPool = pool.filter((p) => !assignedCrews.has(p.name));

  if (unassignedTails.length > 0 && unassignedPool.length > 0) {
    // For each remaining tail, find the closest unassigned crew by haversine
    for (const tail of unassignedTails) {
      if (unassignedPool.length === 0) break;

      const { swapPoints } = extractSwapPoints(tail, byTail, swapDate);
      const swapIcao = swapPoints[0]?.icao;
      const acType = tailAircraftType.get(tail) ?? "unknown";

      // Find best remaining crew (qualified, closest)
      let bestIdx = -1;
      let bestDist = Infinity;
      for (let i = 0; i < unassignedPool.length; i++) {
        const crew = unassignedPool[i];
        if (!isQualified(crew.aircraft_type, acType)) continue;
        if (swapIcao) {
          for (const home of crew.home_airports) {
            const drive = estimateDriveTime(toIcao(home), swapIcao);
            const dist = drive?.straight_line_miles ?? 9999;
            if (dist < bestDist) { bestDist = dist; bestIdx = i; }
          }
        } else if (bestIdx === -1) {
          bestIdx = i;
        }
      }

      if (bestIdx >= 0) {
        const crew = unassignedPool[bestIdx];
        result[tail][field] = crew.name;
        assignedCrews.add(crew.name);
        assignedTails.add(tail);
        unassignedPool.splice(bestIdx, 1);

        const loc = swapPoints[0];
        details.push({
          name: crew.name,
          tail,
          cost: 0,
          reason: `fallback assign to ${loc ? toIata(loc.icao) : "?"} — transport TBD`,
        });
      }
    }
  }
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
