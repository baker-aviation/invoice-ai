/**
 * Crew Swap Optimizer
 *
 * Given a Wednesday swap day, flight schedule, crew roster, and airport aliases:
 * 1. For each tail, determine where the aircraft will be on Wednesday
 * 2. Identify which crew is going off and which is coming on
 * 3. For each swap, find the best airport and transport options
 * 4. Score and rank swap plans by cost, reliability, and compliance
 */

import { estimateDriveTime, type DriveEstimate } from "./driveTime";
import type { FlightOffer } from "./amadeus";

// ─── Types ───────────────────────────────────────────────────────────────────

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

export type SwapOption = {
  swap_airport: string;           // Where the swap happens (FBO airport)
  commercial_airport: string;     // Nearest commercial airport
  is_live_leg_adjacent: boolean;  // Adjacent to charter/revenue flight
  gap_minutes: number;            // Time available for swap (-1 = no constraint)
  // Transport options for oncoming crew
  oncoming_transport: TransportOption[];
  // Transport options for offgoing crew
  offgoing_transport: TransportOption[];
  // Drive from home to commercial airport
  oncoming_drive: DriveEstimate | null;
  offgoing_drive: DriveEstimate | null;
  // Overall score (higher = better)
  score: number;
  score_breakdown: ScoreBreakdown;
};

export type TransportOption = {
  type: "commercial_flight" | "drive" | "positioning_flight";
  from: string;
  to: string;
  departure_time?: string;
  arrival_time?: string;
  duration_minutes: number;
  cost_estimate: number;
  details: string;
  flight_offer?: FlightOffer;
};

export type ScoreBreakdown = {
  cost: number;          // Lower cost = higher score
  reliability: number;   // More backup options = higher
  convenience: number;   // Shorter travel = higher
  compliance: number;    // Duty day / rest compliance
  fairness: number;      // Standby rotation balance
};

export type TailSwapPlan = {
  tail_number: string;
  swap_date: string;
  aircraft_type: string | null;
  // Current crew going off
  offgoing_pic: CrewMember | null;
  offgoing_sic: CrewMember | null;
  // Incoming crew coming on
  oncoming_pic: CrewMember | null;
  oncoming_sic: CrewMember | null;
  // Wednesday schedule
  wednesday_legs: FlightLeg[];
  // Ranked swap options
  options: SwapOption[];
  // Warnings
  warnings: string[];
};

export type SwapPlanResult = {
  swap_date: string;
  plans: TailSwapPlan[];
  unassigned_crew: CrewMember[];
  warnings: string[];
};

// ─── Constants ───────────────────────────────────────────────────────────────

const LIVE_TYPES = new Set(["charter", "revenue", "owner"]);
const MAX_DUTY_HOURS = 14;
const MIN_REST_HOURS = 10;

// Score weights
const W_COST = 30;
const W_RELIABILITY = 25;
const W_CONVENIENCE = 25;
const W_COMPLIANCE = 15;
const W_FAIRNESS = 5;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function isLiveType(type: string | null): boolean {
  return !!type && LIVE_TYPES.has(type.toLowerCase());
}

function isWednesday(iso: string, wedDate: string): boolean {
  return iso.slice(0, 10) === wedDate;
}

/** Find the commercial airport for an FBO airport using aliases */
function findCommercialAirport(
  fboIcao: string,
  aliases: AirportAlias[],
): string {
  // Check aliases
  const alias = aliases.find(
    (a) => a.fbo_icao.toUpperCase() === fboIcao.toUpperCase() && a.preferred,
  );
  if (alias) return alias.commercial_icao;

  // Fallback: any alias
  const anyAlias = aliases.find(
    (a) => a.fbo_icao.toUpperCase() === fboIcao.toUpperCase(),
  );
  if (anyAlias) return anyAlias.commercial_icao;

  // No alias — assume the airport itself has commercial service
  return fboIcao;
}

/** Find closest home airport for a crew member to a given airport */
function closestHomeAirport(
  crew: CrewMember,
  targetIcao: string,
): { airport: string; drive: DriveEstimate | null } {
  let best: { airport: string; drive: DriveEstimate | null } = {
    airport: crew.home_airports[0] ?? "???",
    drive: null,
  };
  let bestMiles = Infinity;

  for (const home of crew.home_airports) {
    // Add K prefix for ICAO if needed
    const homeIcao = home.length === 3 ? `K${home}` : home;
    const drive = estimateDriveTime(homeIcao, targetIcao);
    if (drive && drive.straight_line_miles < bestMiles) {
      bestMiles = drive.straight_line_miles;
      best = { airport: home, drive };
    }
  }
  return best;
}

/** Normalize a name for fuzzy matching: lowercase, handle "Last, First" → "first last" */
function normalizeName(name: string): string {
  let n = name.trim().toLowerCase();
  // Handle "Last, First" or "Last,First"
  if (n.includes(",")) {
    const parts = n.split(",").map((p) => p.trim());
    if (parts.length === 2) {
      n = `${parts[1]} ${parts[0]}`;
    }
  }
  // Remove extra whitespace
  n = n.replace(/\s+/g, " ");
  return n;
}

/** Find crew member by fuzzy name match */
function findCrewByName(roster: CrewMember[], name: string, role: "PIC" | "SIC"): CrewMember | null {
  const norm = normalizeName(name);

  // 1. Exact normalized match
  const exact = roster.find((c) => c.role === role && normalizeName(c.name) === norm);
  if (exact) return exact;

  // 2. Last name match (for "Williamson" matching "Wesley Williamson")
  const normParts = norm.split(" ");
  const lastName = normParts[normParts.length - 1];
  const lastNameMatches = roster.filter((c) => {
    if (c.role !== role) return false;
    const cParts = normalizeName(c.name).split(" ");
    return cParts[cParts.length - 1] === lastName;
  });
  if (lastNameMatches.length === 1) return lastNameMatches[0];

  // 3. Contains match (either direction)
  const contains = roster.find(
    (c) => c.role === role && (normalizeName(c.name).includes(norm) || norm.includes(normalizeName(c.name))),
  );
  if (contains) return contains;

  return null;
}

/** Check if crew member is qualified for an aircraft type */
function isQualified(crew: CrewMember, aircraftType: string | null): boolean {
  if (!aircraftType || aircraftType === "unknown") return true;
  if (crew.aircraft_types.length === 0) return true;
  return crew.aircraft_types.includes(aircraftType) || crew.aircraft_types.includes("dual");
}

// ─── Score computation ───────────────────────────────────────────────────────

function computeScore(option: SwapOption): { score: number; breakdown: ScoreBreakdown } {
  // Cost score: estimate total transport cost
  const totalCost =
    option.oncoming_transport.reduce((s, t) => s + t.cost_estimate, 0) +
    option.offgoing_transport.reduce((s, t) => s + t.cost_estimate, 0);
  // $0 = 100, $1000+ = 0
  const costScore = Math.max(0, 100 - totalCost / 10);

  // Reliability: live leg adjacency + gap time
  let reliabilityScore = 50;
  if (option.is_live_leg_adjacent) reliabilityScore += 30;
  if (option.gap_minutes > 180) reliabilityScore += 20;
  else if (option.gap_minutes > 120) reliabilityScore += 10;
  reliabilityScore = Math.min(100, reliabilityScore);

  // Convenience: total travel time
  const totalMinutes =
    option.oncoming_transport.reduce((s, t) => s + t.duration_minutes, 0) +
    option.offgoing_transport.reduce((s, t) => s + t.duration_minutes, 0);
  // 0 min = 100, 600+ min = 0
  const convenienceScore = Math.max(0, 100 - totalMinutes / 6);

  // Compliance: gap vs duty day
  const complianceScore = option.gap_minutes >= 120 ? 100 : option.gap_minutes >= 60 ? 70 : 30;

  // Fairness: placeholder (populated by optimizer when assigning crew)
  const fairnessScore = 50;

  const breakdown: ScoreBreakdown = {
    cost: Math.round(costScore),
    reliability: Math.round(reliabilityScore),
    convenience: Math.round(convenienceScore),
    compliance: Math.round(complianceScore),
    fairness: fairnessScore,
  };

  const score =
    (breakdown.cost * W_COST +
      breakdown.reliability * W_RELIABILITY +
      breakdown.convenience * W_CONVENIENCE +
      breakdown.compliance * W_COMPLIANCE +
      breakdown.fairness * W_FAIRNESS) /
    (W_COST + W_RELIABILITY + W_CONVENIENCE + W_COMPLIANCE + W_FAIRNESS);

  return { score: Math.round(score), breakdown };
}

// ─── Main optimizer ──────────────────────────────────────────────────────────

export type SwapAssignment = {
  oncoming_pic: string | null;
  oncoming_sic: string | null;
  offgoing_pic: string | null;
  offgoing_sic: string | null;
};

export function buildSwapPlan(params: {
  flights: FlightLeg[];
  crewRoster: CrewMember[];
  aliases: AirportAlias[];
  swapDate: string; // YYYY-MM-DD (Wednesday)
  // Optional: pre-fetched commercial flights keyed by "ORIG-DEST-DATE"
  commercialFlights?: Map<string, FlightOffer[]>;
  // Optional: swap assignments from Excel upload (tail → crew names)
  swapAssignments?: Record<string, SwapAssignment>;
}): SwapPlanResult {
  const { flights, crewRoster, aliases, swapDate, commercialFlights, swapAssignments } = params;
  const warnings: string[] = [];

  // Group flights by tail
  const byTail = new Map<string, FlightLeg[]>();
  for (const f of flights) {
    if (!f.tail_number) continue;
    if (!byTail.has(f.tail_number)) byTail.set(f.tail_number, []);
    byTail.get(f.tail_number)!.push(f);
  }

  // Sort each tail's flights chronologically
  for (const [, legs] of byTail) {
    legs.sort((a, b) => new Date(a.scheduled_departure).getTime() - new Date(b.scheduled_departure).getTime());
  }

  // Separate crew by role
  const picPool = crewRoster.filter((c) => c.role === "PIC");
  const sicPool = crewRoster.filter((c) => c.role === "SIC");

  const plans: TailSwapPlan[] = [];
  const assignedCrewIds = new Set<string>();

  for (const [tail, legs] of byTail) {
    const wedLegs = legs.filter((f) => isWednesday(f.scheduled_departure, swapDate));
    const planWarnings: string[] = [];

    // Use Excel swap assignments if available, otherwise fall back to ICS flight data
    const excelAssignment = swapAssignments?.[tail] ?? null;

    let offgoingPic: CrewMember | null = null;
    let offgoingSic: CrewMember | null = null;
    let directOncomingPic: CrewMember | null = null;
    let directOncomingSic: CrewMember | null = null;
    let currentPicName: string | null = null;
    let currentSicName: string | null = null;

    if (excelAssignment) {
      // Excel swap doc is the source of truth
      if (excelAssignment.offgoing_pic) {
        offgoingPic = findCrewByName(crewRoster, excelAssignment.offgoing_pic, "PIC");
        currentPicName = excelAssignment.offgoing_pic;
      }
      if (excelAssignment.offgoing_sic) {
        offgoingSic = findCrewByName(crewRoster, excelAssignment.offgoing_sic, "SIC");
        currentSicName = excelAssignment.offgoing_sic;
      }
      if (excelAssignment.oncoming_pic) {
        directOncomingPic = findCrewByName(crewRoster, excelAssignment.oncoming_pic, "PIC");
      }
      if (excelAssignment.oncoming_sic) {
        directOncomingSic = findCrewByName(crewRoster, excelAssignment.oncoming_sic, "SIC");
      }
    } else {
      // Fallback: determine current crew from most recent ICS flight before Wednesday
      const priorLegs = legs.filter(
        (f) => new Date(f.scheduled_departure).getTime() < new Date(swapDate).getTime(),
      );
      const lastPrior = priorLegs[priorLegs.length - 1];

      currentPicName = lastPrior?.pic ?? wedLegs[0]?.pic ?? null;
      currentSicName = lastPrior?.sic ?? wedLegs[0]?.sic ?? null;

      offgoingPic = currentPicName
        ? findCrewByName(crewRoster, currentPicName, "PIC")
        : null;
      offgoingSic = currentSicName
        ? findCrewByName(crewRoster, currentSicName, "SIC")
        : null;
    }

    // Determine aircraft type from crew qualifications or flight data
    const aircraftType = offgoingPic?.aircraft_types[0] ?? null;

    // Find last flight before Wednesday (for idle aircraft position)
    const allPriorLegs = legs.filter(
      (f) => new Date(f.scheduled_departure).getTime() < new Date(swapDate).getTime(),
    );
    const lastPriorLeg = allPriorLegs[allPriorLegs.length - 1] ?? null;

    // Find swap candidate airports
    const swapAirports: {
      airport: string;
      isLive: boolean;
      gapMinutes: number;
    }[] = [];

    if (wedLegs.length === 0) {
      // Aircraft idle — swap at last known position
      const lastAirport = lastPriorLeg?.arrival_icao;
      if (lastAirport) {
        swapAirports.push({ airport: lastAirport, isLive: false, gapMinutes: -1 });
      }
    } else {
      // Before first leg
      swapAirports.push({
        airport: wedLegs[0].departure_icao,
        isLive: isLiveType(wedLegs[0].flight_type),
        gapMinutes: -1,
      });

      // Between legs
      for (let i = 0; i < wedLegs.length - 1; i++) {
        const arr = wedLegs[i];
        const dep = wedLegs[i + 1];
        const gap =
          (new Date(dep.scheduled_departure).getTime() -
            new Date(arr.scheduled_arrival ?? arr.scheduled_departure).getTime()) /
          60_000;
        swapAirports.push({
          airport: arr.arrival_icao,
          isLive: isLiveType(arr.flight_type) || isLiveType(dep.flight_type),
          gapMinutes: Math.round(gap),
        });
      }

      // After last leg
      const last = wedLegs[wedLegs.length - 1];
      swapAirports.push({
        airport: last.arrival_icao,
        isLive: isLiveType(last.flight_type),
        gapMinutes: -1,
      });
    }

    // Find best oncoming crew candidates (exclude offgoing crew and already-assigned)
    const qualifiedPics = picPool.filter(
      (c) => isQualified(c, aircraftType) && !assignedCrewIds.has(c.id) && c.id !== offgoingPic?.id,
    );
    const qualifiedSics = sicPool.filter(
      (c) => isQualified(c, aircraftType) && !assignedCrewIds.has(c.id) && c.id !== offgoingSic?.id,
    );

    // Build swap options for each candidate airport
    const options: SwapOption[] = [];

    for (const sa of swapAirports) {
      const commercialAirport = findCommercialAirport(sa.airport, aliases);

      // Build transport options for best oncoming PIC candidate
      const oncomingTransport: TransportOption[] = [];
      const offgoingTransport: TransportOption[] = [];

      // Score each qualified PIC by proximity to swap airport
      const picCandidates = qualifiedPics.map((pic) => {
        const home = closestHomeAirport(pic, commercialAirport.length === 3 ? `K${commercialAirport}` : commercialAirport);
        return { crew: pic, home, miles: home.drive?.straight_line_miles ?? 9999 };
      }).sort((a, b) => a.miles - b.miles);

      const bestPic = picCandidates[0] ?? null;
      const bestSic = qualifiedSics.map((sic) => {
        const home = closestHomeAirport(sic, commercialAirport.length === 3 ? `K${commercialAirport}` : commercialAirport);
        return { crew: sic, home, miles: home.drive?.straight_line_miles ?? 9999 };
      }).sort((a, b) => a.miles - b.miles)[0] ?? null;

      // Oncoming PIC transport
      if (bestPic) {
        const homeIcao = bestPic.home.airport.length === 3 ? `K${bestPic.home.airport}` : bestPic.home.airport;

        // Check for commercial flights
        const flightKey = `${bestPic.home.airport}-${commercialAirport}-${swapDate}`;
        const flights = commercialFlights?.get(flightKey);
        if (flights && flights.length > 0) {
          for (const offer of flights.slice(0, 3)) {
            const seg = offer.itineraries[0]?.segments;
            if (!seg) continue;
            const firstSeg = seg[0];
            const lastSeg = seg[seg.length - 1];
            oncomingTransport.push({
              type: "commercial_flight",
              from: firstSeg.departure.iataCode,
              to: lastSeg.arrival.iataCode,
              departure_time: firstSeg.departure.at,
              arrival_time: lastSeg.arrival.at,
              duration_minutes: seg.reduce(
                (s, sg) => {
                  const m = sg.duration.match(/PT(?:(\d+)H)?(?:(\d+)M)?/);
                  return s + (parseInt(m?.[1] ?? "0") * 60 + parseInt(m?.[2] ?? "0"));
                },
                0,
              ),
              cost_estimate: parseFloat(offer.price.total),
              details: seg.map((s) => `${s.carrierCode}${s.number}`).join(" → "),
              flight_offer: offer,
            });
          }
        }

        // Drive option
        const drive = estimateDriveTime(homeIcao, sa.airport.length === 3 ? `K${sa.airport}` : sa.airport);
        if (drive && drive.feasible) {
          oncomingTransport.push({
            type: "drive",
            from: bestPic.home.airport,
            to: sa.airport,
            duration_minutes: drive.estimated_drive_minutes,
            cost_estimate: drive.estimated_drive_miles * 0.67, // IRS mileage rate
            details: `${drive.estimated_drive_miles}mi drive (~${Math.round(drive.estimated_drive_minutes / 60)}h)`,
          });
        }
      }

      // Offgoing crew transport (reverse — from swap airport to home)
      if (offgoingPic) {
        const homeIcao = offgoingPic.home_airports[0]?.length === 3
          ? `K${offgoingPic.home_airports[0]}` : offgoingPic.home_airports[0] ?? "";
        const drive = estimateDriveTime(
          sa.airport.length === 3 ? `K${sa.airport}` : sa.airport,
          homeIcao,
        );
        if (drive && drive.feasible) {
          offgoingTransport.push({
            type: "drive",
            from: sa.airport,
            to: offgoingPic.home_airports[0] ?? "",
            duration_minutes: drive.estimated_drive_minutes,
            cost_estimate: drive.estimated_drive_miles * 0.67,
            details: `${drive.estimated_drive_miles}mi drive (~${Math.round(drive.estimated_drive_minutes / 60)}h)`,
          });
        }

        // Check for commercial flights home
        const flightKey = `${commercialAirport}-${offgoingPic.home_airports[0] ?? ""}-${swapDate}`;
        const returnFlights = commercialFlights?.get(flightKey);
        if (returnFlights && returnFlights.length > 0) {
          for (const offer of returnFlights.slice(0, 3)) {
            const seg = offer.itineraries[0]?.segments;
            if (!seg) continue;
            const firstSeg = seg[0];
            const lastSeg = seg[seg.length - 1];
            offgoingTransport.push({
              type: "commercial_flight",
              from: firstSeg.departure.iataCode,
              to: lastSeg.arrival.iataCode,
              departure_time: firstSeg.departure.at,
              arrival_time: lastSeg.arrival.at,
              duration_minutes: seg.reduce(
                (s, sg) => {
                  const m = sg.duration.match(/PT(?:(\d+)H)?(?:(\d+)M)?/);
                  return s + (parseInt(m?.[1] ?? "0") * 60 + parseInt(m?.[2] ?? "0"));
                },
                0,
              ),
              cost_estimate: parseFloat(offer.price.total),
              details: seg.map((s) => `${s.carrierCode}${s.number}`).join(" → "),
              flight_offer: offer,
            });
          }
        }
      }

      const oncomingDrive = bestPic
        ? estimateDriveTime(
            (bestPic.home.airport.length === 3 ? `K${bestPic.home.airport}` : bestPic.home.airport),
            (commercialAirport.length === 3 ? `K${commercialAirport}` : commercialAirport),
          )
        : null;
      const offgoingDrive = offgoingPic?.home_airports[0]
        ? estimateDriveTime(
            (commercialAirport.length === 3 ? `K${commercialAirport}` : commercialAirport),
            (offgoingPic.home_airports[0].length === 3 ? `K${offgoingPic.home_airports[0]}` : offgoingPic.home_airports[0]),
          )
        : null;

      const option: SwapOption = {
        swap_airport: sa.airport,
        commercial_airport: commercialAirport,
        is_live_leg_adjacent: sa.isLive,
        gap_minutes: sa.gapMinutes,
        oncoming_transport: oncomingTransport,
        offgoing_transport: offgoingTransport,
        oncoming_drive: oncomingDrive,
        offgoing_drive: offgoingDrive,
        score: 0,
        score_breakdown: { cost: 0, reliability: 0, convenience: 0, compliance: 0, fairness: 0 },
      };

      const { score, breakdown } = computeScore(option);
      option.score = score;
      option.score_breakdown = breakdown;

      options.push(option);
    }

    // Sort options by score descending
    options.sort((a, b) => b.score - a.score);

    // Assign oncoming crew — prefer Excel swap assignments, then optimize by proximity
    const bestOption = options[0] ?? null;
    let oncomingPic: CrewMember | null = directOncomingPic;
    let oncomingSic: CrewMember | null = directOncomingSic;

    // Mark direct assignments as used
    if (oncomingPic) assignedCrewIds.add(oncomingPic.id);
    if (oncomingSic) assignedCrewIds.add(oncomingSic.id);

    // If no Excel assignment, try to find best crew by proximity (only if transport exists)
    if (!oncomingPic) {
      const hasViableTransport = options.some(
        (o) => o.oncoming_transport.length > 0 || o.offgoing_transport.length > 0,
      );

      if (hasViableTransport && qualifiedPics.length > 0) {
        const viableOption = options.find((o) => o.oncoming_transport.length > 0) ?? bestOption;
        const target = viableOption
          ? (viableOption.commercial_airport.length === 3 ? `K${viableOption.commercial_airport}` : viableOption.commercial_airport)
          : null;

        if (target) {
          const sorted = qualifiedPics.map((p) => {
            const home = closestHomeAirport(p, target);
            return { crew: p, miles: home.drive?.straight_line_miles ?? 9999 };
          }).sort((a, b) => a.miles - b.miles);
          if (sorted[0] && sorted[0].miles < 9999) {
            oncomingPic = sorted[0].crew;
            assignedCrewIds.add(oncomingPic.id);
          }
        }
      }
    }

    if (!oncomingSic) {
      const hasViableTransport = options.some(
        (o) => o.oncoming_transport.length > 0 || o.offgoing_transport.length > 0,
      );

      if (hasViableTransport && qualifiedSics.length > 0) {
        const viableOption = options.find((o) => o.oncoming_transport.length > 0) ?? bestOption;
        const target = viableOption
          ? (viableOption.commercial_airport.length === 3 ? `K${viableOption.commercial_airport}` : viableOption.commercial_airport)
          : null;

        if (target) {
          const sorted = qualifiedSics.map((s) => {
            const home = closestHomeAirport(s, target);
            return { crew: s, miles: home.drive?.straight_line_miles ?? 9999 };
          }).sort((a, b) => a.miles - b.miles);
          if (sorted[0] && sorted[0].miles < 9999) {
            oncomingSic = sorted[0].crew;
            assignedCrewIds.add(oncomingSic.id);
          }
        }
      }
    }

    if (!oncomingPic) {
      planWarnings.push(`No qualified PIC available (aircraft: ${aircraftType ?? "unknown"}, pool: ${picPool.length}, qualified: ${qualifiedPics.length}, offgoing: ${currentPicName ?? "none"}, excel: ${excelAssignment?.oncoming_pic ?? "none"})`);
    }
    if (!oncomingSic) {
      planWarnings.push(`No qualified SIC available (aircraft: ${aircraftType ?? "unknown"}, pool: ${sicPool.length}, qualified: ${qualifiedSics.length}, offgoing: ${currentSicName ?? "none"}, excel: ${excelAssignment?.oncoming_sic ?? "none"})`);
    }

    // Duty day check
    if (wedLegs.length > 0) {
      const firstDep = new Date(wedLegs[0].scheduled_departure);
      const lastArr = new Date(wedLegs[wedLegs.length - 1].scheduled_arrival ?? wedLegs[wedLegs.length - 1].scheduled_departure);
      const dutyHours = (lastArr.getTime() - firstDep.getTime()) / (60 * 60 * 1000);
      if (dutyHours > MAX_DUTY_HOURS) {
        planWarnings.push(`Duty day exceeds ${MAX_DUTY_HOURS}h (${Math.round(dutyHours * 10) / 10}h)`);
      }
    }

    plans.push({
      tail_number: tail,
      swap_date: swapDate,
      aircraft_type: aircraftType,
      offgoing_pic: offgoingPic,
      offgoing_sic: offgoingSic,
      oncoming_pic: oncomingPic,
      oncoming_sic: oncomingSic,
      wednesday_legs: wedLegs,
      options,
      warnings: planWarnings,
    });
  }

  // Unassigned crew (available but not placed)
  const unassigned = crewRoster.filter((c) => !assignedCrewIds.has(c.id));

  return { swap_date: swapDate, plans, unassigned_crew: unassigned, warnings };
}
