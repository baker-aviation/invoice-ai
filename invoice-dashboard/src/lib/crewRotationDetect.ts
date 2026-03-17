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
// Fuzzy Name Matching
// ═══════════════════════════════════════════════════════════════════════════════

/** Common nickname → formal name mappings */
const NICKNAME_MAP: Record<string, string[]> = {
  zack: ["zachary", "zach"],
  zach: ["zachary", "zack"],
  zachary: ["zack", "zach"],
  chris: ["christopher", "christian"],
  christopher: ["chris"],
  christian: ["chris"],
  tony: ["anthony"],
  anthony: ["tony"],
  jon: ["jonathan", "john"],
  jonathan: ["jon", "john"],
  john: ["jon", "jonathan"],
  matt: ["matthew", "matthias"],
  matthew: ["matt"],
  nick: ["nicholas", "nickolaus", "nikolas"],
  nicholas: ["nick"],
  nickolaus: ["nick"],
  tim: ["timothy"],
  timothy: ["tim"],
  rick: ["richard", "ricky"],
  ricky: ["rick", "richard"],
  richard: ["rick", "ricky"],
  bob: ["robert"],
  robert: ["bob", "rob"],
  rob: ["robert"],
  bill: ["william"],
  william: ["will", "bill", "billy"],
  will: ["william"],
  ed: ["edward", "eddie", "eddy"],
  edward: ["ed", "eddie"],
  eddie: ["ed", "edward"],
  dan: ["daniel"],
  daniel: ["dan"],
  jim: ["james"],
  james: ["jim"],
  mike: ["michael"],
  michael: ["mike"],
  joe: ["joseph"],
  joseph: ["joe"],
  lenny: ["leonard"],
  leonard: ["lenny", "len"],
  ben: ["benjamin"],
  benjamin: ["ben"],
  dave: ["david"],
  david: ["dave"],
  larry: ["lawrence", "laurence"],
  jeff: ["jeffray", "jeffrey", "geoffrey"],
  jeffray: ["jeff"],
  jeffrey: ["jeff"],
  alex: ["alexander"],
  alexander: ["alex"],
  wes: ["wesley"],
  wesley: ["wes"],
  henry: ["hank"],
  fred: ["frederick"],
  frederick: ["fred"],
  greg: ["gregory"],
  gregory: ["greg"],
  seb: ["sebastian"],
  sebastian: ["seb"],
};

function normalize(name: string): string {
  return name.toLowerCase().trim().replace(/[^a-z\s'-]/g, "");
}

function getLastName(fullName: string): string {
  const parts = normalize(fullName).split(/\s+/);
  return parts[parts.length - 1];
}

function getFirstName(fullName: string): string {
  return normalize(fullName).split(/\s+/)[0];
}

/**
 * Match a JetInsight full name to a crew_members record.
 *
 * Strategy:
 * 1. Exact match (normalized)
 * 2. Last name match + first name is a known nickname variant
 * 3. Last name match + first name starts with same 3 chars
 * 4. Last name match + one name contains the other's first name as a word
 *    (handles "James Graeme Lang" matching "Graeme Lang")
 */
function matchName(jetInsightName: string, crewMembers: CrewMember[]): CrewMember | null {
  const jNorm = normalize(jetInsightName);

  // 0. Check jetinsight_name field (DB-stored mapping — most reliable)
  const jiMatch = crewMembers.find((c) => c.jetinsight_name && normalize(c.jetinsight_name) === jNorm);
  if (jiMatch) return jiMatch;

  // 1. Exact match on display name
  const exact = crewMembers.find((c) => normalize(c.name) === jNorm);
  if (exact) return exact;

  const jLast = getLastName(jetInsightName);
  const jFirst = getFirstName(jetInsightName);
  const jParts = jNorm.split(/\s+/);

  // Filter to last-name matches
  const lastNameMatches = crewMembers.filter((c) => getLastName(c.name) === jLast);
  if (lastNameMatches.length === 0) return null;
  if (lastNameMatches.length === 1) {
    // Only one person with that last name — very likely the same person
    // But verify first name isn't wildly different
    const cFirst = getFirstName(lastNameMatches[0].name);
    if (cFirst[0] === jFirst[0]) return lastNameMatches[0];
    // Check if any part of the JetInsight name matches the crew first name
    if (jParts.some((p) => p === cFirst)) return lastNameMatches[0];
    // Check nickname
    const variants = NICKNAME_MAP[cFirst] ?? [];
    if (variants.includes(jFirst) || jParts.some((p) => variants.includes(p))) return lastNameMatches[0];
  }

  for (const c of lastNameMatches) {
    const cFirst = getFirstName(c.name);

    // 2. Nickname match
    const jVariants = NICKNAME_MAP[jFirst] ?? [];
    const cVariants = NICKNAME_MAP[cFirst] ?? [];
    if (jFirst === cFirst || jVariants.includes(cFirst) || cVariants.includes(jFirst)) {
      return c;
    }

    // 3. First 3 chars match
    if (jFirst.length >= 3 && cFirst.length >= 3 && jFirst.slice(0, 3) === cFirst.slice(0, 3)) {
      return c;
    }

    // 4. Middle name handling: "James Graeme Lang" should match "Graeme Lang"
    // Check if crew first name appears anywhere in JetInsight name parts
    if (jParts.includes(cFirst)) return c;

    // Also check if JetInsight first name appears in crew name parts
    const cParts = normalize(c.name).split(/\s+/);
    if (cParts.includes(jFirst)) return c;
  }

  // 5. Typo tolerance: check if last names are within edit distance 1
  // Handles "Rodriguez" vs "Rodriquez" typo
  for (const c of crewMembers) {
    const cLast = getLastName(c.name);
    if (editDistance(jLast, cLast) <= 1) {
      const cFirst = getFirstName(c.name);
      const jVariants = NICKNAME_MAP[jFirst] ?? [];
      const cVariants = NICKNAME_MAP[cFirst] ?? [];
      if (jFirst === cFirst || jFirst[0] === cFirst[0] || jVariants.includes(cFirst) || cVariants.includes(jFirst)) {
        return c;
      }
    }
  }

  return null;
}

/** Simple Levenshtein edit distance */
function editDistance(a: string, b: string): number {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const dp: number[][] = [];
  for (let i = 0; i <= a.length; i++) {
    dp[i] = [i];
    for (let j = 1; j <= b.length; j++) {
      if (i === 0) { dp[i][j] = j; continue; }
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
  }
  return dp[a.length][b.length];
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
