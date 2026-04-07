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

// ─── Crew matching (delegates to shared nameResolver) ───────────────────────

import { matchNameFuzzy, type NameCandidate } from "./nameResolver";

type CrewMemberForMatch = {
  id: string;
  name: string;
  slack_user_id?: string | null;
};

/**
 * Match a Slack user to a crew member.
 * Strategy: exact slack_user_id first, then fuzzy name match via nameResolver.
 */
export function matchSlackUserToCrew(
  slackUserId: string,
  slackDisplayName: string,
  crewMembers: CrewMemberForMatch[],
): string | null {
  // 1. Exact slack_user_id match (most reliable)
  const byId = crewMembers.find(
    (c) => c.slack_user_id && c.slack_user_id === slackUserId,
  );
  if (byId) return byId.id;

  // 2. Fuzzy name match via shared resolver
  if (!slackDisplayName) return null;
  const candidates: NameCandidate[] = crewMembers.map((c) => ({
    id: c.id,
    name: c.name,
  }));
  const result = matchNameFuzzy(slackDisplayName, candidates);
  return result?.id ?? null;
}
