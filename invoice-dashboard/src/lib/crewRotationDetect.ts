/**
 * Crew Rotation Auto-Detection from JetInsight Flights
 *
 * Scans flights in the days before a swap Wednesday to determine who's
 * currently flying each tail (offgoing) and who's on the other rotation
 * (oncoming). Uses fuzzy name matching because JetInsight uses full legal
 * names ("Zachary Benz") while crew_members has nicknames ("Zack Benz").
 */

import type { CrewMember, FlightLeg, SwapAssignment } from "./swapOptimizer";

// ═══════════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════════

export type DetectedRotation = {
  /** Swap assignments with offgoing crew populated per tail */
  swap_assignments: Record<string, SwapAssignment>;
  /** Oncoming pool (crew not currently flying) */
  oncoming_pool: { pic: OncomingPoolEntry[]; sic: OncomingPoolEntry[] };
  /** Crew staying on aircraft for a 2nd rotation (in both offgoing+oncoming pools) */
  staying_crew: Array<{ name: string; tail: string; role: "PIC" | "SIC" }>;
  /** Name matches found (for debugging) */
  name_matches: Array<{ jetinsight_name: string; matched_to: string; tail: string; role: "PIC" | "SIC" }>;
  /** JetInsight names that couldn't be matched to crew_members */
  unmatched_names: string[];
  /** Which rotation group is currently flying (offgoing) */
  offgoing_rotation_group: "A" | "B" | null;
  /** Which rotation group is oncoming */
  oncoming_rotation_group: "A" | "B" | null;
  /** Summary stats */
  stats: {
    tails_detected: number;
    offgoing_pic: number;
    offgoing_sic: number;
    oncoming_pic: number;
    oncoming_sic: number;
  };
};

type OncomingPoolEntry = {
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

// ═══════════════════════════════════════════════════════════════════════════════
// Fuzzy Name Matching (delegates to shared nameResolver)
// ═══════════════════════════════════════════════════════════════════════════════

import { matchNameFuzzy, normalizeName, type NameCandidate } from "./nameResolver";

/**
 * Match a JetInsight full name to a crew_members record.
 * Checks jetinsight_name field first, then delegates to shared fuzzy matcher.
 */
function matchName(jetInsightName: string, crewMembers: CrewMember[]): CrewMember | null {
  const jNorm = normalizeName(jetInsightName);

  // 0. Check jetinsight_name field (DB-stored mapping — most reliable)
  const jiMatch = crewMembers.find((c) => c.jetinsight_name && normalizeName(c.jetinsight_name) === jNorm);
  if (jiMatch) return jiMatch;

  // 1. Delegate to shared fuzzy matcher
  const candidates: NameCandidate[] = crewMembers.map((c) => ({
    id: c.id ?? c.name,
    name: c.name,
    alt_name: c.jetinsight_name,
  }));
  const result = matchNameFuzzy(jetInsightName, candidates);
  if (!result) return null;

  return crewMembers.find((c) => (c.id ?? c.name) === result.id) ?? null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Rotation Detection
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Detect current crew rotation from JetInsight flight data.
 *
 * Scans flights in the 4 days before swap Wednesday (Sat-Tue) to identify
 * who's flying each tail. These are the offgoing crew. Everyone else in
 * crew_members is the oncoming pool.
 */
export function detectCurrentRotation(
  flights: FlightLeg[],
  crewRoster: CrewMember[],
  swapDate: string,
): DetectedRotation {
  const swapDay = new Date(swapDate + "T00:00:00Z");

  // Look at flights from 4 days before swap through the day before
  const lookbackStart = new Date(swapDay.getTime() - 4 * 24 * 60 * 60 * 1000).toISOString();
  const lookbackEnd = swapDate + "T00:00:00Z"; // exclusive — don't include swap day flights

  const priorFlights = flights.filter(
    (f) => f.scheduled_departure >= lookbackStart && f.scheduled_departure < lookbackEnd,
  );

  // Group by tail: collect all PIC/SIC names seen on each tail
  const tailCrew: Record<string, { pics: Set<string>; sics: Set<string>; lastArrival: string }> = {};

  for (const f of priorFlights) {
    const tail = f.tail_number;
    if (!tailCrew[tail]) {
      tailCrew[tail] = { pics: new Set(), sics: new Set(), lastArrival: "" };
    }
    if (f.pic && f.pic !== "-") tailCrew[tail].pics.add(f.pic);
    if (f.sic && f.sic !== "-") tailCrew[tail].sics.add(f.sic);
    // Track last arrival airport for the tail
    if (f.arrival_icao && f.scheduled_departure > tailCrew[tail].lastArrival) {
      tailCrew[tail].lastArrival = f.arrival_icao;
    }
  }

  // Match JetInsight names to crew_members and build swap assignments
  const swapAssignments: Record<string, SwapAssignment> = {};
  const nameMatches: DetectedRotation["name_matches"] = [];
  const unmatchedNames = new Set<string>();
  const offgoingCrewIds = new Set<string>();

  for (const [tail, crew] of Object.entries(tailCrew)) {
    const assignment: SwapAssignment = {
      oncoming_pic: null,
      oncoming_sic: null,
      offgoing_pic: null,
      offgoing_sic: null,
    };

    // Match PICs — use the most recent one if multiple
    const picNames = [...crew.pics];
    for (const picName of picNames) {
      const matched = matchName(picName, crewRoster.filter((c) => c.role === "PIC"));
      if (matched) {
        // Use most recently seen PIC (last in the list from flight order)
        assignment.offgoing_pic = matched.name;
        offgoingCrewIds.add(matched.id);
        nameMatches.push({ jetinsight_name: picName, matched_to: matched.name, tail, role: "PIC" });
      } else {
        // Try matching against all crew (maybe role doesn't match)
        const anyMatch = matchName(picName, crewRoster);
        if (anyMatch) {
          assignment.offgoing_pic = anyMatch.name;
          offgoingCrewIds.add(anyMatch.id);
          nameMatches.push({ jetinsight_name: picName, matched_to: anyMatch.name, tail, role: "PIC" });
        } else {
          unmatchedNames.add(picName);
        }
      }
    }

    // Match SICs
    const sicNames = [...crew.sics];
    for (const sicName of sicNames) {
      const matched = matchName(sicName, crewRoster.filter((c) => c.role === "SIC"));
      if (matched) {
        assignment.offgoing_sic = matched.name;
        offgoingCrewIds.add(matched.id);
        nameMatches.push({ jetinsight_name: sicName, matched_to: matched.name, tail, role: "SIC" });
      } else {
        const anyMatch = matchName(sicName, crewRoster);
        if (anyMatch) {
          assignment.offgoing_sic = anyMatch.name;
          offgoingCrewIds.add(anyMatch.id);
          nameMatches.push({ jetinsight_name: sicName, matched_to: anyMatch.name, tail, role: "SIC" });
        } else {
          unmatchedNames.add(sicName);
        }
      }
    }

    // Only include tails that have at least one identified crew member
    if (assignment.offgoing_pic || assignment.offgoing_sic) {
      swapAssignments[tail] = assignment;
    }
  }

  // Determine which rotation_group is offgoing by majority vote of matched crew
  let offgoingRotationGroup: "A" | "B" | null = null;
  const groupCounts: Record<string, number> = { A: 0, B: 0 };
  for (const id of offgoingCrewIds) {
    const c = crewRoster.find((m) => m.id === id);
    if (c?.rotation_group) groupCounts[c.rotation_group]++;
  }
  if (groupCounts.A > 0 || groupCounts.B > 0) {
    offgoingRotationGroup = groupCounts.A >= groupCounts.B ? "A" : "B";
  }
  const oncomingRotationGroup = offgoingRotationGroup === "A" ? "B" : offgoingRotationGroup === "B" ? "A" : null;

  // ── Detect "staying" crew: appears in BOTH offgoing (flying now) and oncoming pool ──
  // These crew stay on the aircraft for a 2nd rotation — no transport needed.
  const stayingCrew: DetectedRotation["staying_crew"] = [];
  const stayingCrewIds = new Set<string>();

  // Build oncoming pool using rotation_group when available
  const oncomingPool: DetectedRotation["oncoming_pool"] = { pic: [], sic: [] };

  for (const c of crewRoster) {
    // If this crew member is offgoing AND also in the oncoming rotation group,
    // they are staying on the aircraft for a 2nd rotation.
    if (offgoingCrewIds.has(c.id) && oncomingRotationGroup && c.rotation_group === oncomingRotationGroup) {
      // Find which tail they're on
      for (const [tail, assignment] of Object.entries(swapAssignments)) {
        if (assignment.offgoing_pic === c.name || assignment.offgoing_sic === c.name) {
          stayingCrew.push({ name: c.name, tail, role: c.role });
          stayingCrewIds.add(c.id);
        }
      }
      continue; // Don't add to oncoming pool — they stay put
    }

    // Skip offgoing crew (matched from JetInsight)
    if (offgoingCrewIds.has(c.id)) continue;

    // If rotation_groups are populated, use them: only include crew from the oncoming group
    // This prevents false "oncoming" entries from name-matching gaps
    if (oncomingRotationGroup && c.rotation_group) {
      if (c.rotation_group !== oncomingRotationGroup) continue;
    }
    // If no rotation_group set and we have group info, skip unknowns
    // (they'll need their rotation_group set via Excel upload first)
    if (oncomingRotationGroup && !c.rotation_group) continue;

    const entry: OncomingPoolEntry = {
      name: c.name,
      aircraft_type: c.aircraft_types[0] ?? "unknown",
      home_airports: c.home_airports,
      is_checkairman: c.is_checkairman,
      is_skillbridge: c.is_skillbridge,
      early_volunteer: false,
      late_volunteer: false,
      standby_volunteer: false,
      notes: null,
    };

    if (c.role === "PIC") oncomingPool.pic.push(entry);
    else oncomingPool.sic.push(entry);
  }

  return {
    swap_assignments: swapAssignments,
    oncoming_pool: oncomingPool,
    staying_crew: stayingCrew,
    name_matches: nameMatches,
    unmatched_names: [...unmatchedNames],
    offgoing_rotation_group: offgoingRotationGroup,
    oncoming_rotation_group: oncomingRotationGroup,
    stats: {
      tails_detected: Object.keys(swapAssignments).length,
      offgoing_pic: Object.values(swapAssignments).filter((a) => a.offgoing_pic).length,
      offgoing_sic: Object.values(swapAssignments).filter((a) => a.offgoing_sic).length,
      oncoming_pic: oncomingPool.pic.length,
      oncoming_sic: oncomingPool.sic.length,
    },
  };
}
