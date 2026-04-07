/**
 * Unified name resolution module.
 *
 * Consolidates nickname maps, normalization, and fuzzy matching from:
 * - crewInfoParser.ts (matchSlackName)
 * - volunteerParser.ts (matchSlackUserToCrew)
 * - crewRotationDetect.ts (matchName for JetInsight)
 *
 * Single source of truth for all cross-system name matching.
 */

// ─── Nickname Map (union of all 3 previous maps) ────────────────────────────

export const NICKNAME_MAP: Record<string, string[]> = {
  zack: ["zachary", "zach", "zac"], zach: ["zachary", "zack", "zac"], zac: ["zachary", "zack", "zach"],
  zachary: ["zack", "zach", "zac"],
  mike: ["michael", "mick"], michael: ["mike", "mick"], mick: ["mike", "michael"],
  bill: ["william", "will", "billy"], william: ["bill", "will", "billy"], will: ["william", "bill", "billy"],
  billy: ["william", "bill", "will"],
  bob: ["robert", "rob", "bobby"], robert: ["bob", "rob", "bobby"], rob: ["robert", "bob"],
  bobby: ["robert", "bob"],
  jim: ["james", "jimmy"], james: ["jim", "jimmy"], jimmy: ["james", "jim"],
  joe: ["joseph", "joey"], joseph: ["joe", "joey"], joey: ["joseph", "joe"],
  tom: ["thomas", "tommy"], thomas: ["tom", "tommy"], tommy: ["thomas", "tom"],
  dave: ["david"], david: ["dave"],
  dan: ["daniel", "danny"], daniel: ["dan", "danny"], danny: ["daniel", "dan"],
  matt: ["matthew", "matthias"], matthew: ["matt"], matthias: ["matt"],
  chris: ["christopher", "christian"], christopher: ["chris"], christian: ["chris"],
  steve: ["steven", "stephen"], steven: ["steve", "stephen"], stephen: ["steve", "steven"],
  tony: ["anthony"], anthony: ["tony"],
  ed: ["edward", "eddie", "eddy"], edward: ["ed", "eddie", "eddy"],
  eddie: ["edward", "ed", "eddy"], eddy: ["edward", "ed", "eddie"],
  rick: ["richard", "ricky", "dick"], richard: ["rick", "ricky", "dick"],
  ricky: ["rick", "richard"], dick: ["richard", "rick"],
  pat: ["patrick"], patrick: ["pat"],
  nick: ["nicholas", "nickolaus", "nikolas"], nicholas: ["nick"], nickolaus: ["nick"], nikolas: ["nick"],
  wes: ["wesley"], wesley: ["wes"],
  jon: ["jonathan", "john"], jonathan: ["jon", "john"], john: ["jon", "johnny", "jonathan"],
  johnny: ["john", "jon"],
  charlie: ["charles"], charles: ["charlie"],
  al: ["alan", "albert", "alexander", "alex"],
  alex: ["alexander", "al"], alexander: ["alex", "al"],
  alan: ["al"], albert: ["al"],
  greg: ["gregory"], gregory: ["greg"],
  ben: ["benjamin"], benjamin: ["ben"],
  josh: ["joshua"], joshua: ["josh"],
  andy: ["andrew"], andrew: ["andy"],
  ken: ["kenneth"], kenneth: ["ken"],
  jeff: ["jeffrey", "jeffray", "geoffrey"], jeffrey: ["jeff"], jeffray: ["jeff"], geoffrey: ["jeff"],
  larry: ["lawrence", "laurence"], lawrence: ["larry"], laurence: ["larry"],
  fred: ["frederick"], frederick: ["fred"],
  jake: ["jacob"], jacob: ["jake"],
  liz: ["elizabeth"], elizabeth: ["liz"],
  sam: ["samuel", "samantha", "sammy"], samuel: ["sam", "sammy"], samantha: ["sam"],
  sammy: ["sam", "samuel"],
  ron: ["ronald"], ronald: ["ron"],
  curt: ["curtis"], curtis: ["curt"],
  tim: ["timothy"], timothy: ["tim"],
  lenny: ["leonard", "len"], leonard: ["lenny", "len"], len: ["leonard", "lenny"],
  henry: ["hank"], hank: ["henry"],
  seb: ["sebastian"], sebastian: ["seb"],
};

// ─── Normalization ───────────────────────────────────────────────────────────

/** Normalize a name: lowercase, trim, preserve hyphens and apostrophes, collapse spaces */
export function normalizeName(s: string): string {
  return s.toLowerCase().trim().replace(/[^a-z\s'-]/g, "").replace(/\s+/g, " ");
}

/** Extract first name from "First Middle Last" */
export function getFirstName(fullName: string): string {
  return normalizeName(fullName).split(/\s+/)[0];
}

/** Extract last name from "First Middle Last" */
export function getLastName(fullName: string): string {
  const parts = normalizeName(fullName).split(/\s+/);
  return parts[parts.length - 1];
}

// ─── Levenshtein Edit Distance ───────────────────────────────────────────────

export function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp: number[][] = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

// ─── Name matching helpers ───────────────────────────────────────────────────

/** Check if two first names are nickname variants */
export function isNicknameMatch(name1: string, name2: string): boolean {
  const n1 = normalizeName(name1);
  const n2 = normalizeName(name2);
  if (n1 === n2) return true;
  return NICKNAME_MAP[n1]?.includes(n2) === true || NICKNAME_MAP[n2]?.includes(n1) === true;
}

// Common suffixes to strip
const NAME_SUFFIXES = new Set(["jr", "sr", "ii", "iii", "iv"]);

/** Strip name suffixes and return cleaned parts */
export function cleanNameParts(name: string): string[] {
  return normalizeName(name).split(/\s+/).filter((p) => !NAME_SUFFIXES.has(p));
}

// ─── Unified fuzzy matching ─────────────────────────────────────────────────

export type NameCandidate = {
  id: string;
  name: string;
  /** Optional field to check first (e.g., jetinsight_name) */
  alt_name?: string | null;
  /** Optional field for direct ID match (e.g., slack_user_id) */
  external_id?: string | null;
};

export type NameMatchResult = {
  id: string;
  name: string;
  confidence: number; // 0-100
};

/**
 * Unified fuzzy name matching. Used by all 3 callers.
 *
 * Strategy (in priority order):
 * 1. Exact match on alt_name (e.g., jetinsight_name)
 * 2. Exact normalized name match
 * 3. Last name match + first name scoring (nickname, 3-char prefix, middle name)
 * 4. Typo tolerance (levenshtein distance ≤ 1 on last name)
 */
export function matchNameFuzzy(
  input: string,
  candidates: NameCandidate[],
): NameMatchResult | null {
  const inputNorm = normalizeName(input.replace(/,/g, ""));
  if (!inputNorm) return null;

  // 1. Exact match on alt_name field
  for (const c of candidates) {
    if (c.alt_name && normalizeName(c.alt_name) === inputNorm) {
      return { id: c.id, name: c.name, confidence: 100 };
    }
  }

  // 2. Exact match on display name
  for (const c of candidates) {
    if (normalizeName(c.name) === inputNorm) {
      return { id: c.id, name: c.name, confidence: 100 };
    }
  }

  const inputParts = cleanNameParts(input.replace(/,/g, ""));
  if (inputParts.length === 0) return null;

  // Handle username-style single names (e.g., "whecox")
  if (inputParts.length === 1 && inputParts[0].length > 3) {
    const username = inputParts[0];
    for (const c of candidates) {
      const cLast = getLastName(c.name);
      if (cLast.length >= 4 && (username.endsWith(cLast) || username.includes(cLast))) {
        return { id: c.id, name: c.name, confidence: 60 };
      }
    }
  }

  const inputFirst = inputParts[0];
  const inputLast = inputParts[inputParts.length - 1];
  const inputAllParts = inputParts; // All parts for middle name checking

  let bestMatch: NameMatchResult | null = null;

  for (const c of candidates) {
    const cParts = cleanNameParts(c.name);
    if (cParts.length === 0) continue;

    const cFirst = cParts[0];
    const cLast = cParts[cParts.length - 1];

    // ── Last name matching (required) ──
    let lastNameScore = 0;
    if (cLast === inputLast) {
      lastNameScore = 10;
    } else if (cLast.length >= 4 && inputLast.length >= 4) {
      const dist = levenshtein(cLast, inputLast);
      if (dist === 1) lastNameScore = 8;
      else if (dist === 2 && cLast.length >= 6) lastNameScore = 5;
    }
    // Multi-word last name: e.g., "Maestre Giron" → try second-to-last
    if (lastNameScore === 0 && inputParts.length >= 3) {
      const secondLast = inputParts[inputParts.length - 2];
      if (secondLast === cLast) lastNameScore = 7;
    }

    if (lastNameScore === 0) continue;

    let score = lastNameScore;

    // ── First name scoring ──
    if (cFirst === inputFirst) {
      score += 20;
    } else if (isNicknameMatch(inputFirst, cFirst)) {
      score += 15;
    } else if (inputFirst.length >= 3 && cFirst.length >= 3 &&
               (inputFirst.slice(0, 3) === cFirst.slice(0, 3) || cFirst.slice(0, 3) === inputFirst.slice(0, 3))) {
      score += 10;
    } else if (inputFirst.length === 1 && cFirst.startsWith(inputFirst)) {
      score += 5;
    } else {
      // Middle name handling: check if crew first name appears in any input part
      const middleMatch = inputAllParts.some(
        (p) => p === cFirst || isNicknameMatch(p, cFirst),
      );
      // Or input first name appears in crew parts
      const reverseMiddle = cParts.some(
        (p) => p === inputFirst || isNicknameMatch(p, inputFirst),
      );
      if (middleMatch || reverseMiddle) {
        score += 8;
      } else if (inputFirst[0] === cFirst[0]) {
        // Same initial — weak match but valid if only one last-name candidate
        score += 3;
      } else {
        continue;
      }
    }

    // Bonus for multi-part names (more evidence)
    if (inputParts.length > 2 || cParts.length > 2) score += 2;

    // Normalize to 0-100 confidence (max raw score is ~32)
    const confidence = Math.min(100, Math.round((score / 32) * 100));

    if (!bestMatch || confidence > bestMatch.confidence) {
      bestMatch = { id: c.id, name: c.name, confidence };
    }
  }

  // Also check typo tolerance on last names (covers the broader candidate set)
  if (!bestMatch || bestMatch.confidence < 70) {
    for (const c of candidates) {
      const cLast = getLastName(c.name);
      const cFirst = getFirstName(c.name);
      if (levenshtein(inputLast, cLast) <= 1 && inputLast !== cLast) {
        if (inputFirst === cFirst || inputFirst[0] === cFirst[0] ||
            isNicknameMatch(inputFirst, cFirst)) {
          const confidence = 65;
          if (!bestMatch || confidence > bestMatch.confidence) {
            bestMatch = { id: c.id, name: c.name, confidence };
          }
        }
      }
    }
  }

  return bestMatch;
}

/**
 * Suggest top-N close matches for an unmatched name.
 * Used by the "click to link" UI.
 */
export function suggestMatches(
  input: string,
  candidates: NameCandidate[],
  maxResults = 3,
): NameMatchResult[] {
  const inputNorm = normalizeName(input.replace(/,/g, ""));
  if (!inputNorm) return [];

  const inputLast = getLastName(input);
  const inputFirst = getFirstName(input);

  const scored: NameMatchResult[] = [];

  for (const c of candidates) {
    const cLast = getLastName(c.name);
    const cFirst = getFirstName(c.name);

    let score = 0;

    // Last name similarity
    if (cLast === inputLast) score += 40;
    else {
      const dist = levenshtein(cLast, inputLast);
      if (dist === 1) score += 30;
      else if (dist === 2) score += 15;
      else if (dist === 3) score += 5;
    }

    // First name similarity
    if (cFirst === inputFirst) score += 30;
    else if (isNicknameMatch(inputFirst, cFirst)) score += 25;
    else {
      const dist = levenshtein(cFirst, inputFirst);
      if (dist === 1) score += 20;
      else if (dist === 2) score += 10;
      else if (cFirst[0] === inputFirst[0]) score += 5;
    }

    if (score > 10) {
      scored.push({ id: c.id, name: c.name, confidence: Math.min(100, score) });
    }
  }

  return scored
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, maxResults);
}
