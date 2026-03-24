/**
 * Slack volunteer thread parser.
 *
 * Parses pilot replies from the weekly "Volunteer Pilots" thread in #pilots
 * to extract preferences: early, late, standby, early_and_late, or unknown.
 *
 * Also handles matching Slack users to crew_members by slack_user_id or
 * fuzzy name matching.
 */

export type VolunteerPreference = "early" | "late" | "standby" | "early_and_late" | "unknown";

export type ParsedVolunteer = {
  preference: VolunteerPreference;
  notes: string | null;
};

// ─── Preference parsing ─────────────────────────────────────────────────────

// Patterns ordered by specificity (most specific first)
const PATTERNS: [RegExp, VolunteerPreference][] = [
  // Combined
  [/\bearly\s*(?:&|and|\+)\s*late\b/i, "early_and_late"],
  [/\blate\s*(?:&|and|\+)\s*early\b/i, "early_and_late"],
  [/\bboth\b/i, "early_and_late"],
  // Standby
  [/\bstandby\b/i, "standby"],
  [/\bsb\b/i, "standby"],
  [/\bstand\s*by\b/i, "standby"],
  // Early — including common misspellings and slang
  [/\bearly\b/i, "early"],
  [/\burlie\b/i, "early"],    // slang/typo for early
  [/\btuesda/i, "early"],     // "I can go Tuesday" → early arrival
  [/\btues\b/i, "early"],
  // Late
  [/\blate\b/i, "late"],
  [/\bl8\b/i, "late"],        // text-speak for late
  [/\bthursda/i, "late"],     // "I can stay Thursday" → late departure
  [/\bthurs\b/i, "late"],
];

/**
 * Parse free-text from a Slack reply into a volunteer preference.
 * Returns the preference and any extra text as notes.
 */
export function parseVolunteerText(text: string): ParsedVolunteer {
  const trimmed = text.trim();
  if (!trimmed) return { preference: "unknown", notes: null };

  for (const [pattern, preference] of PATTERNS) {
    const match = trimmed.match(pattern);
    if (match) {
      // Everything after the matched keyword is "notes"
      const afterMatch = trimmed.slice((match.index ?? 0) + match[0].length).trim();
      // Everything before the matched keyword could also be notes
      const beforeMatch = trimmed.slice(0, match.index ?? 0).trim();
      const combined = [beforeMatch, afterMatch].filter(Boolean).join(" ").trim();
      return {
        preference,
        notes: combined || null,
      };
    }
  }

  return { preference: "unknown", notes: trimmed };
}

// ─── Crew matching ──────────────────────────────────────────────────────────

type CrewMemberForMatch = {
  id: string;
  name: string;
  slack_user_id?: string | null;
};

// Common nickname variants
const NICKNAME_MAP: Record<string, string[]> = {
  zack: ["zachary", "zach", "zac"],
  zachary: ["zack", "zach", "zac"],
  zach: ["zachary", "zack", "zac"],
  mike: ["michael", "mick"],
  michael: ["mike", "mick"],
  bill: ["william", "will", "billy"],
  william: ["bill", "will", "billy"],
  will: ["william", "bill", "billy"],
  bob: ["robert", "rob", "bobby"],
  robert: ["bob", "rob", "bobby"],
  rob: ["robert", "bob"],
  jim: ["james", "jimmy"],
  james: ["jim", "jimmy"],
  joe: ["joseph", "joey"],
  joseph: ["joe", "joey"],
  tom: ["thomas", "tommy"],
  thomas: ["tom", "tommy"],
  dave: ["david"],
  david: ["dave"],
  dan: ["daniel", "danny"],
  daniel: ["dan", "danny"],
  matt: ["matthew"],
  matthew: ["matt"],
  chris: ["christopher"],
  christopher: ["chris"],
  steve: ["steven", "stephen"],
  steven: ["steve", "stephen"],
  stephen: ["steve", "steven"],
  tony: ["anthony"],
  anthony: ["tony"],
  ed: ["edward", "eddie"],
  edward: ["ed", "eddie"],
  rick: ["richard", "ricky", "dick"],
  richard: ["rick", "ricky", "dick"],
  pat: ["patrick"],
  patrick: ["pat"],
  nick: ["nicholas"],
  nicholas: ["nick"],
  wes: ["wesley"],
  wesley: ["wes"],
  jon: ["jonathan"],
  jonathan: ["jon"],
  charlie: ["charles"],
  charles: ["charlie"],
  al: ["alan", "albert", "alexander"],
  alex: ["alexander"],
  alexander: ["alex", "al"],
  greg: ["gregory"],
  gregory: ["greg"],
  ben: ["benjamin"],
  benjamin: ["ben"],
  sam: ["samuel", "sammy"],
  samuel: ["sam", "sammy"],
  jake: ["jacob"],
  jacob: ["jake"],
  josh: ["joshua"],
  joshua: ["josh"],
  andy: ["andrew"],
  andrew: ["andy"],
  ken: ["kenneth"],
  kenneth: ["ken"],
  jeff: ["jeffrey"],
  jeffrey: ["jeff"],
  larry: ["lawrence"],
  lawrence: ["larry"],
};

function normalize(s: string): string {
  return s.toLowerCase().trim().replace(/[^a-z\s]/g, "");
}

/**
 * Match a Slack user to a crew member.
 * Strategy:
 * 1. Exact slack_user_id match (most reliable)
 * 2. Fuzzy display name match:
 *    a. Exact normalized name match
 *    b. Last name match + first name is known nickname
 *    c. Last name match + first name starts with same 3 chars
 */
export function matchSlackUserToCrew(
  slackUserId: string,
  slackDisplayName: string,
  crewMembers: CrewMemberForMatch[],
): string | null {
  // 1. Exact slack_user_id match
  const byId = crewMembers.find(
    (c) => c.slack_user_id && c.slack_user_id === slackUserId,
  );
  if (byId) return byId.id;

  // 2. Name-based matching
  const displayNorm = normalize(slackDisplayName);
  if (!displayNorm) return null;

  // 2a. Exact normalized name match
  const exact = crewMembers.find((c) => normalize(c.name) === displayNorm);
  if (exact) return exact.id;

  // Split display name into parts
  const displayParts = displayNorm.split(/\s+/);
  if (displayParts.length < 2) {
    // Single name — try matching against any crew member's last name
    const singleMatch = crewMembers.find((c) => {
      const parts = normalize(c.name).split(/\s+/);
      return parts.some((p) => p === displayParts[0]);
    });
    return singleMatch?.id ?? null;
  }

  const displayFirst = displayParts[0];
  const displayLast = displayParts[displayParts.length - 1];

  for (const crew of crewMembers) {
    const crewParts = normalize(crew.name).split(/\s+/);
    if (crewParts.length < 2) continue;

    const crewFirst = crewParts[0];
    const crewLast = crewParts[crewParts.length - 1];

    // Last name must match
    if (crewLast !== displayLast) continue;

    // 2b. First name is a known nickname variant
    const nicknames = NICKNAME_MAP[displayFirst] ?? [];
    if (crewFirst === displayFirst || nicknames.includes(crewFirst)) {
      return crew.id;
    }

    // 2c. First name starts with same 3 chars
    if (
      displayFirst.length >= 3 &&
      crewFirst.length >= 3 &&
      displayFirst.slice(0, 3) === crewFirst.slice(0, 3)
    ) {
      return crew.id;
    }
  }

  return null;
}
