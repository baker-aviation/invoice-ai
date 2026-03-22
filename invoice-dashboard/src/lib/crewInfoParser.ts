/**
 * CREW INFO Excel Parser
 *
 * Parses Baker Aviation's master "_CREW INFO 2026.xlsx" workbook to extract:
 *   1. Full crew roster (CREW ROSTER sheet) — name, home airports, rotation, type, rank
 *   2. Rotation calendar (CREW CALENDAR sheet) — who's on which week
 *   3. Weekly swap sheets (e.g. "MAR 18-MAR 25 (B)") — completed swap plans
 *   4. Different airports overrides — crew temporarily not at home base
 *   5. Slack name matching — fuzzy match Slack display names to roster names
 */

import * as XLSX from "xlsx";

// ─── Types ──────────────────────────────────────────────────────────────────

export type CrewRosterEntry = {
  name: string;
  home_airports: string[];
  rotation: "A" | "B" | "part_time" | null;
  aircraft_type: "citation_x" | "challenger" | "dual";
  role: "PIC" | "SIC";
  is_skillbridge: boolean;
  skillbridge_end: string | null; // ISO date
  is_terminated: boolean;
  terminated_on: string | null; // ISO date
  slack_display_name: string | null;
};

export type WeeklySwapEntry = {
  name: string;
  home_airports: string[];
  aircraft_type: string;
  is_checkairman: boolean;
  role: "PIC" | "SIC";
  direction: "oncoming" | "offgoing";
  is_skillbridge: boolean;
  volunteer: "early" | "late" | "standby" | null;
  tail_number: string | null;
  swap_location: string | null;
  flight_number: string | null;
  date: string | null;
  duty_on_time: string | null;
  arrival_time: string | null;
  price: number | null;
  notes: string | null;
  is_staying: boolean;
};

export type DifferentAirportEntry = {
  name: string;
  date: string | null;
  coming_from: string | null;
  going_to: string | null;
  notes: string | null;
};

export type CrewInfoParseResult = {
  roster: CrewRosterEntry[];
  weekly_swap: WeeklySwapEntry[] | null;
  weekly_sheet_name: string | null;
  different_airports: DifferentAirportEntry[];
  rotation_counts: { a: { pic: number; sic: number }; b: { pic: number; sic: number } };
  errors: string[];
};

// ─── Aircraft type mapping ──────────────────────────────────────────────────

function parseAircraftType(raw: string): "citation_x" | "challenger" | "dual" {
  const s = raw.toLowerCase().trim();
  if (s.includes("dual")) return "dual";
  if (s.includes("challenger") || s.includes("cl300") || s.includes("cl 300")) return "challenger";
  return "citation_x";
}

// ─── Emoji → aircraft type (for weekly sheets) ─────────────────────────────

const EMOJI_TYPE: Record<string, string> = {
  "\u{1F7E2}": "citation_x", // 🟢
  "\u{1F7E1}": "challenger", // 🟡
  "\u{1F7E3}": "dual",       // 🟣
};

// ─── Date parsing helpers ───────────────────────────────────────────────────

function excelDateToISO(val: unknown): string | null {
  if (!val) return null;
  if (typeof val === "number") {
    // Excel serial date
    const d = new Date((val - 25569) * 86400000);
    return d.toISOString().slice(0, 10);
  }
  if (typeof val === "string") {
    const trimmed = val.trim();
    if (!trimmed) return null;
    // Try various formats: "03/01/2026", "03/01/2026 (03/02/2026)", "2026-03-01"
    const match = trimmed.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
    if (match) {
      const [, m, d, y] = match;
      return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
    }
  }
  return null;
}

// ─── Slack name matching ────────────────────────────────────────────────────

const NICKNAME_MAP: Record<string, string[]> = {
  zack: ["zachary", "zach"], zachary: ["zack", "zach"],
  mike: ["michael"], michael: ["mike"],
  bill: ["william", "will", "billy", "johnny"], william: ["bill", "will", "billy"],
  will: ["william", "bill"], bob: ["robert", "rob"],
  robert: ["bob", "rob"], rob: ["robert", "bob"],
  jim: ["james", "jimmy"], james: ["jim", "jimmy"],
  joe: ["joseph", "joey"], joseph: ["joe", "joey"],
  tom: ["thomas", "tommy"], thomas: ["tom", "tommy"],
  dave: ["david"], david: ["dave"],
  dan: ["daniel", "danny"], daniel: ["dan", "danny"],
  matt: ["matthew"], matthew: ["matt"],
  chris: ["christopher"], christopher: ["chris"],
  steve: ["steven", "stephen"], steven: ["steve", "stephen"], stephen: ["steve", "steven"],
  tony: ["anthony"], anthony: ["tony"],
  ed: ["edward", "eddie"], edward: ["ed", "eddie"], eddie: ["edward", "ed"],
  rick: ["richard"], richard: ["rick"],
  pat: ["patrick"], patrick: ["pat"],
  nick: ["nicholas"], nicholas: ["nick"],
  wes: ["wesley"], wesley: ["wes"],
  jon: ["jonathan", "john"], jonathan: ["jon"],
  john: ["jon", "johnny"], johnny: ["john"],
  charlie: ["charles"], charles: ["charlie"],
  al: ["alexander", "alex"], alex: ["alexander"],
  alexander: ["alex", "al"],
  greg: ["gregory"], gregory: ["greg"],
  ben: ["benjamin"], benjamin: ["ben"],
  josh: ["joshua"], joshua: ["josh"],
  andy: ["andrew"], andrew: ["andy"],
  ken: ["kenneth"], kenneth: ["ken"],
  jeff: ["jeffrey", "jeffray"], jeffrey: ["jeff"], jeffray: ["jeff"],
  larry: ["lawrence"], lawrence: ["larry"],
  fred: ["frederick"], frederick: ["fred"],
  jake: ["jacob"], jacob: ["jake"],
  jimmy: ["james", "jim"],
  dick: ["richard"],
  liz: ["elizabeth"], elizabeth: ["liz"],
  sam: ["samuel", "samantha"], samuel: ["sam"],
  ron: ["ronald"], ronald: ["ron"],
  curt: ["curtis"], curtis: ["curt"],
};

function normalize(s: string): string {
  return s.toLowerCase().trim()
    .replace(/[^a-z\s]/g, "") // strip non-alpha
    .replace(/\s+/g, " ");
}

/**
 * Fuzzy-match a Slack display name to a roster name.
 * Handles: middle names, nicknames, suffixes (Jr, III), initials.
 */
export function matchSlackName(slackName: string, rosterNames: string[]): string | null {
  // Pre-process: strip commas (handles "Macklin, Jr." → "Macklin Jr")
  const sn = normalize(slackName.replace(/,/g, ""));
  if (!sn) return null;

  // 1. Exact match
  const exact = rosterNames.find((r) => normalize(r) === sn);
  if (exact) return exact;

  const sParts = sn.split(" ").filter(Boolean);
  if (sParts.length === 0) return null;

  // Handle username-style names (e.g., "whecox" → try splitting as first initial + last)
  if (sParts.length === 1 && sParts[0].length > 3) {
    const username = sParts[0];
    // Try matching against roster last names
    for (const roster of rosterNames) {
      const rLast = normalize(roster).split(" ").pop() ?? "";
      if (rLast.length >= 4 && username.endsWith(rLast)) {
        return roster;
      }
      // Also try username contains last name
      if (rLast.length >= 4 && username.includes(rLast)) {
        return roster;
      }
    }
  }

  // Strip common suffixes
  const suffixes = new Set(["jr", "sr", "ii", "iii", "iv"]);
  const sClean = sParts.filter((p) => !suffixes.has(p));
  if (sClean.length === 0) return null;
  const sFirst = sClean[0];
  const sLast = sClean[sClean.length - 1];

  let bestMatch: string | null = null;
  let bestScore = 0;

  for (const roster of rosterNames) {
    const rn = normalize(roster);
    const rParts = rn.split(" ").filter((p) => !suffixes.has(p));
    if (rParts.length === 0) continue;

    const rFirst = rParts[0];
    const rLast = rParts[rParts.length - 1];

    // ── Last name matching (required) ──
    let lastNameScore = 0;
    if (rLast === sLast) {
      lastNameScore = 10;
    } else if (rLast.length >= 4 && sLast.length >= 4) {
      // Fuzzy last name: handle typos (e.g., "Rodriguez" vs "Rodriquez")
      // Levenshtein distance ≤ 2 for names ≥ 5 chars
      const dist = levenshtein(rLast, sLast);
      if (dist === 1) lastNameScore = 8;
      else if (dist === 2 && rLast.length >= 6) lastNameScore = 5;
    }
    // Also check: slack has multi-word last name, roster is shorter
    // e.g., "Maestre Giron" slack → "Maestre" roster (first part of last matches)
    if (lastNameScore === 0 && sClean.length >= 3) {
      // Try treating second-to-last as the last name
      const sSecondLast = sClean[sClean.length - 2];
      if (sSecondLast === rLast) lastNameScore = 7;
    }

    if (lastNameScore === 0) continue;

    let score = lastNameScore;

    // ── First name scoring ──
    if (rFirst === sFirst) {
      score += 20;
    } else if (NICKNAME_MAP[sFirst]?.includes(rFirst) || NICKNAME_MAP[rFirst]?.includes(sFirst)) {
      score += 15;
    } else if (sFirst.length >= 3 && rFirst.startsWith(sFirst.slice(0, 3))) {
      score += 10;
    } else if (rFirst.length >= 3 && sFirst.startsWith(rFirst.slice(0, 3))) {
      score += 10;
    } else if (sFirst.length === 1 && rFirst.startsWith(sFirst)) {
      score += 5;
    } else {
      // Check middle names and ALL parts of the slack name
      const allSlackParts = sClean;
      const matched = allSlackParts.some((m) =>
        m === rFirst || NICKNAME_MAP[m]?.includes(rFirst) || NICKNAME_MAP[rFirst]?.includes(m)
      );
      if (matched) {
        score += 8;
      } else {
        continue;
      }
    }

    if (sClean.length > 2 || rParts.length > 2) {
      score += 2;
    }

    if (score > bestScore) {
      bestScore = score;
      bestMatch = roster;
    }
  }

  return bestMatch;
}

/** Simple Levenshtein distance for short strings */
function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
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

// ─── Main parser ────────────────────────────────────────────────────────────

export function parseCrewInfo(
  buffer: Buffer,
  slackNames?: string[],
  targetSwapDate?: string, // YYYY-MM-DD — pick the right weekly sheet
): CrewInfoParseResult {
  const wb = XLSX.read(buffer, { type: "buffer" });
  const errors: string[] = [];

  // ═══ 1. Parse CREW ROSTER sheet ═══════════════════════════════════════════

  const rosterSheet = wb.Sheets["CREW ROSTER"];
  const roster: CrewRosterEntry[] = [];
  const rosterNames: string[] = [];

  if (rosterSheet) {
    const rows = XLSX.utils.sheet_to_json(rosterSheet, { header: 1, defval: "" }) as unknown[][];

    // Find header row (NAME, HOME AIRPORT, ROTATION, TYPE RATING, RANK)
    let headerIdx = -1;
    for (let i = 0; i < Math.min(10, rows.length); i++) {
      if (String(rows[i]?.[0] ?? "").toUpperCase() === "NAME") {
        headerIdx = i;
        break;
      }
    }

    if (headerIdx >= 0) {
      for (let i = headerIdx + 1; i < rows.length; i++) {
        const row = rows[i];
        const name = String(row[0] ?? "").trim();
        if (!name) continue;

        const homeStr = String(row[1] ?? "").trim();
        const home_airports = homeStr
          .split(/[\/,]/)
          .map((a) => a.trim().toUpperCase().replace(/\s+/g, ""))
          .filter((a) => a.length >= 2 && a.length <= 5)
          // Handle "N.Y.C." type entries — strip periods
          .map((a) => a.replace(/\./g, ""));

        const rotationRaw = String(row[2] ?? "").trim().toUpperCase();
        let rotation: CrewRosterEntry["rotation"] = null;
        if (rotationRaw === "A") rotation = "A";
        else if (rotationRaw === "B") rotation = "B";
        else if (rotationRaw.includes("PART") || rotationRaw.includes("NON")) rotation = "part_time";

        const aircraft_type = parseAircraftType(String(row[3] ?? ""));

        const rankRaw = String(row[4] ?? "").toLowerCase();
        const role: "PIC" | "SIC" = rankRaw.includes("captain") ? "PIC" : "SIC";

        const sbVal = row[5];
        const skillbridge_end = excelDateToISO(sbVal);
        const is_skillbridge = !!skillbridge_end;

        const termVal = row[6];
        const terminated_on = excelDateToISO(termVal);
        const is_terminated = !!terminated_on;

        roster.push({
          name,
          home_airports,
          rotation,
          aircraft_type,
          role,
          is_skillbridge,
          skillbridge_end,
          is_terminated,
          terminated_on,
          slack_display_name: null,
        });
        rosterNames.push(name);
      }
    } else {
      errors.push("CREW ROSTER sheet: header row not found");
    }
  } else {
    errors.push("CREW ROSTER sheet not found");
  }

  // ═══ 2. Match Slack names ══════════════════════════════════════════════════

  if (slackNames && slackNames.length > 0 && rosterNames.length > 0) {
    let matched = 0;
    for (const slackName of slackNames) {
      const trimmed = slackName.trim();
      if (!trimmed) continue;

      const rosterMatch = matchSlackName(trimmed, rosterNames);
      if (rosterMatch) {
        const entry = roster.find((r) => r.name === rosterMatch);
        if (entry) {
          entry.slack_display_name = trimmed;
          matched++;
        }
      }
    }
    if (matched < slackNames.length * 0.5) {
      errors.push(`Slack matching: only ${matched}/${slackNames.length} matched (some may be non-pilots)`);
    }
  }

  // ═══ 3. Parse weekly swap sheet ════════════════════════════════════════════

  let weeklySwap: WeeklySwapEntry[] | null = null;
  let weeklySheetName: string | null = null;

  // Find the right sheet by target date or pick the latest
  const weeklySheets = wb.SheetNames.filter((n) =>
    /^[A-Z]{3}\s+\d+-[A-Z]{3}\s+\d+\s*\([AB]\)$/i.test(n)
  );

  if (targetSwapDate && weeklySheets.length > 0) {
    // Parse target date to find matching sheet
    const target = new Date(targetSwapDate + "T12:00:00Z");
    const targetMonth = target.toLocaleString("en-US", { month: "short" }).toUpperCase();
    const targetDay = target.getDate();

    // Match sheet like "MAR 18-MAR 25 (B)" where targetDate falls in the range
    for (const name of weeklySheets) {
      const m = name.match(/([A-Z]{3})\s+(\d+)-([A-Z]{3})\s+(\d+)\s*\(([AB])\)/i);
      if (!m) continue;
      // The end date (e.g., MAR 25) is the swap Wednesday
      const endMonth = m[3].toUpperCase();
      const endDay = parseInt(m[4]);
      if (endMonth === targetMonth && endDay === targetDay) {
        weeklySheetName = name;
        break;
      }
    }
  }

  // Fallback: use the first (most recent) weekly sheet
  if (!weeklySheetName && weeklySheets.length > 0) {
    weeklySheetName = weeklySheets[0];
  }

  if (weeklySheetName) {
    const ws = wb.Sheets[weeklySheetName];
    if (ws) {
      weeklySwap = parseWeeklySheet(ws, errors);
    }
  }

  // ═══ 4. Parse Different Airports ═══════════════════════════════════════════

  const different_airports: DifferentAirportEntry[] = [];
  const diffSheet = wb.Sheets["Different Airports  .299  Bad P"];
  if (diffSheet) {
    const rows = XLSX.utils.sheet_to_json(diffSheet, { header: 1, defval: "" }) as unknown[][];
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      const name = String(row[0] ?? "").trim();
      if (!name) continue;
      // Stop at "Training Needed" section
      if (name.toLowerCase().includes("training")) break;

      different_airports.push({
        name,
        date: excelDateToISO(row[1]),
        coming_from: String(row[2] ?? "").trim() || null,
        going_to: String(row[3] ?? "").trim() || null,
        notes: String(row[4] ?? "").trim() || null,
      });
    }
  }

  // ═══ 5. Rotation counts ════════════════════════════════════════════════════

  const activeRoster = roster.filter((r) => !r.is_terminated);
  const rotation_counts = {
    a: {
      pic: activeRoster.filter((r) => r.rotation === "A" && r.role === "PIC").length,
      sic: activeRoster.filter((r) => r.rotation === "A" && r.role === "SIC").length,
    },
    b: {
      pic: activeRoster.filter((r) => r.rotation === "B" && r.role === "PIC").length,
      sic: activeRoster.filter((r) => r.rotation === "B" && r.role === "SIC").length,
    },
  };

  return {
    roster,
    weekly_swap: weeklySwap,
    weekly_sheet_name: weeklySheetName,
    different_airports,
    rotation_counts,
    errors,
  };
}

// ─── Weekly sheet parser ────────────────────────────────────────────────────

function parseWeeklySheet(ws: XLSX.WorkSheet, errors: string[]): WeeklySwapEntry[] {
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" }) as unknown[][];
  const entries: WeeklySwapEntry[] = [];

  let inOncoming = true;
  let currentRole: "PIC" | "SIC" = "PIC";

  for (const row of rows) {
    const col2 = String(row[2] ?? "").trim();
    const col2Upper = col2.toUpperCase();

    // Section transitions
    if (col2Upper === "ONCOMING PILOTS") { inOncoming = true; continue; }
    if (col2Upper === "OFFGOING PILOTS") { inOncoming = false; continue; }
    if (col2Upper === "PILOT IN-COMMAND") { currentRole = "PIC"; continue; }
    if (col2Upper === "SECOND IN-COMMAND") { currentRole = "SIC"; continue; }
    if (col2Upper.startsWith("NAME (HOME")) continue;

    // Parse crew cell
    if (!col2 || col2Upper === "") continue;

    // Detect aircraft type from emoji
    let aircraftType = "unknown";
    for (const [emoji, type] of Object.entries(EMOJI_TYPE)) {
      if (col2.includes(emoji)) { aircraftType = type; break; }
    }

    const isCheckairman = /[✔✓]/.test(col2);

    // Extract name and home airports
    const cleaned = col2
      .replace(/^[\u{1F7E0}-\u{1F7FF}\s]+/u, "") // strip emoji prefix
      .replace(/[✔✓\s]+$/u, "")
      .trim();

    const nameMatch = cleaned.match(/^(.+?)\s*\(([^)]+)\)\s*$/);
    if (!nameMatch) continue;

    const name = nameMatch[1].trim();
    const homeStr = nameMatch[2].trim();
    const home_airports = homeStr
      .split(/[\/,]/)
      .map((a) => a.trim().toUpperCase().replace(/\./g, "").replace(/\s+/g, ""))
      .filter((a) => a.length >= 2 && a.length <= 5);

    const isSkillbridge = String(row[0] ?? "") === "true" || row[0] === true;
    const volRaw = String(row[1] ?? "").trim().toUpperCase();
    const volunteer = volRaw === "E" ? "early" as const
      : volRaw === "L" ? "late" as const
      : volRaw === "SB" ? "standby" as const
      : null;

    // Swap location (col 3)
    const swapLoc = String(row[3] ?? "").trim() || null;

    // Tail number (col 4) — match N-number pattern
    let tail_number: string | null = null;
    const col4 = String(row[4] ?? "").trim();
    if (/^N\d{1,5}[A-Z]{0,2}$/i.test(col4)) {
      tail_number = col4.toUpperCase();
    }

    // Flight number (col 5)
    const flightNum = String(row[5] ?? "").trim() || null;
    const is_staying = flightNum?.toLowerCase().includes("staying") ?? false;

    // Date (col 6)
    const dateVal = row[6];
    const date = excelDateToISO(dateVal);

    // Duty on / Depart (col 7)
    const dutyOn = String(row[7] ?? "").trim() || null;

    // Arrival time (col 8)
    const arrivalTime = String(row[8] ?? "").trim() || null;

    // Price (col 9)
    let price: number | null = null;
    const priceRaw = row[9];
    if (typeof priceRaw === "number") price = priceRaw;
    else if (typeof priceRaw === "string") {
      const p = parseFloat(priceRaw.replace(/[$,]/g, ""));
      if (!isNaN(p)) price = p;
    }

    // Notes (col 10)
    const notes = String(row[10] ?? "").trim() || null;

    entries.push({
      name,
      home_airports,
      aircraft_type: aircraftType,
      is_checkairman: isCheckairman,
      role: currentRole,
      direction: inOncoming ? "oncoming" : "offgoing",
      is_skillbridge: isSkillbridge,
      volunteer,
      tail_number,
      swap_location: swapLoc,
      flight_number: flightNum,
      date,
      duty_on_time: dutyOn,
      arrival_time: arrivalTime,
      price,
      notes,
      is_staying,
    });
  }

  return entries;
}
