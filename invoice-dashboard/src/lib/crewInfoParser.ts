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

export type BadPairing = {
  pic: string;
  sic: string;
  severity: "severe" | "moderate" | "minor";
  notes: string;
};

export type CheckairmanEntry = {
  name: string;
  rotation: "A" | "B" | "other";
  citation_x: boolean;
  challenger: boolean;
};

export type TrainingEntry = {
  name: string;
  indoc: boolean;
  emergency_drill: boolean;
};

export type Recurrency299Entry = {
  name: string;
  month: string;
  needs_299: boolean;
  citation_drill: boolean;
  challenger_drill: boolean;
};

export type PicSwapEntry = {
  old_pic: string | null;
  new_pic: string | null;
  tail: string | null;
};

export type CrewingChecklist = {
  assignees: { name: string; tasks: Record<string, boolean | string> }[];
};

export type CalendarWeek = {
  date_range: string;
  rotation: "A" | "B" | null;
  pic: { citation_x: string[]; challenger: string[]; dual: string[] };
  sic: { citation_x: string[]; challenger: string[]; dual: string[] };
  pic_count: { citation_x: number; challenger: number };
  sic_count: { citation_x: number; challenger: number };
};

export type CrewInfoParseResult = {
  roster: CrewRosterEntry[];
  weekly_swap: WeeklySwapEntry[] | null;
  weekly_sheet_name: string | null;
  different_airports: DifferentAirportEntry[];
  rotation_counts: { a: { pic: number; sic: number }; b: { pic: number; sic: number } };
  bad_pairings: BadPairing[];
  checkairmen: CheckairmanEntry[];
  training_needed: TrainingEntry[];
  recurrency_299: Recurrency299Entry[];
  pic_swap_table: PicSwapEntry[];
  crewing_checklist: CrewingChecklist | null;
  calendar_weeks: CalendarWeek[];
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

// ─── Slack name matching (delegates to shared nameResolver) ─────────────────

import { matchNameFuzzy, type NameCandidate } from "./nameResolver";

/**
 * Fuzzy-match a Slack display name to a roster name.
 * Delegates to the shared matchNameFuzzy from nameResolver.ts.
 */
export function matchSlackName(slackName: string, rosterNames: string[]): string | null {
  if (!slackName) return null;
  const candidates: NameCandidate[] = rosterNames.map((name, i) => ({
    id: String(i),
    name,
  }));
  const result = matchNameFuzzy(slackName, candidates);
  if (!result) return null;
  return rosterNames[parseInt(result.id)];
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
      const weeklyRows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" }) as unknown[][];
      weeklySwap = parseWeeklySheetRows(weeklyRows, errors);
    }
  }

  // ═══ 4. Parse "Different Airports / .299 / Bad P" sheet ═══════════════════

  const different_airports: DifferentAirportEntry[] = [];
  const bad_pairings: BadPairing[] = [];
  const checkairmen: CheckairmanEntry[] = [];
  const training_needed: TrainingEntry[] = [];
  const recurrency_299: Recurrency299Entry[] = [];

  const diffSheet = wb.Sheets["Different Airports / .299 / Bad Pairs / Training"];
  if (diffSheet) {
    const rows = XLSX.utils.sheet_to_json(diffSheet, { header: 1, defval: "" }) as unknown[][];

    // State machine: track which section we're in
    let section: "airports" | "training_299" | "bad_pairings" | "checkairmen" | "training_people" | "unknown" = "airports";

    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      const col0 = String(row[0] ?? "").trim();
      const col0Lower = col0.toLowerCase();

      // ── Section detection ──
      if (col0Lower.includes("training needed")) { section = "training_299"; continue; }
      if (col0Lower.includes("bad pairing")) { section = "bad_pairings"; continue; }
      if (col0Lower.includes("air checkman") || col0Lower.includes("checkairman")) { section = "checkairmen"; continue; }
      if (col0Lower.includes("training people")) { section = "training_people"; continue; }

      // Skip header rows
      if (col0Lower === "name" || col0Lower === "pic" || col0Lower === "rotation a" || col0Lower === "different airports") continue;
      if (!col0) continue;

      // ── Different Airports ──
      if (section === "airports") {
        different_airports.push({
          name: col0,
          date: excelDateToISO(row[1]),
          coming_from: String(row[2] ?? "").trim() || null,
          going_to: String(row[3] ?? "").trim() || null,
          notes: String(row[4] ?? "").trim() || null,
        });
      }

      // ── .299 Recurrency + Training Drills ──
      if (section === "training_299") {
        const month = String(row[1] ?? "").trim();
        if (!month) continue;
        recurrency_299.push({
          name: col0,
          month,
          needs_299: row[2] === true || String(row[2] ?? "").toLowerCase() === "true",
          citation_drill: row[3] === true || String(row[3] ?? "").toLowerCase() === "true",
          challenger_drill: row[4] === true || String(row[4] ?? "").toLowerCase() === "true",
        });
      }

      // ── Bad Pairings ──
      if (section === "bad_pairings") {
        const sic = String(row[1] ?? "").trim();
        const notesRaw = String(row[2] ?? "").trim();
        if (!sic) continue;

        let severity: BadPairing["severity"] = "minor";
        const notesLower = notesRaw.toLowerCase();
        if (notesLower.includes("very severe") || notesLower.includes("severe")) severity = "severe";
        else if (notesLower.includes("moderate") || notesLower.includes("don't like") || notesLower.includes("dont like")) severity = "moderate";

        bad_pairings.push({ pic: col0, sic, severity, notes: notesRaw });
      }

      // ── Checkairmen ──
      if (section === "checkairmen") {
        // Two columns: Rotation A (cols 0-2) and Rotation B (cols 3-5)
        const citX_A = row[1] === true;
        const cl_A = row[2] === true;
        if (col0 && (citX_A || cl_A || col0.length > 2)) {
          checkairmen.push({ name: col0, rotation: "A", citation_x: citX_A, challenger: cl_A });
        }
        const nameB = String(row[3] ?? "").trim();
        const citX_B = row[4] === true;
        const cl_B = row[5] === true;
        if (nameB && (citX_B || cl_B || nameB.length > 2)) {
          checkairmen.push({ name: nameB, rotation: "B", citation_x: citX_B, challenger: cl_B });
        }
        // "OTHER" column (col 6)
        const nameOther = String(row[6] ?? "").trim();
        if (nameOther) {
          checkairmen.push({ name: nameOther, rotation: "other", citation_x: true, challenger: true });
        }
      }

      // ── Training People ──
      if (section === "training_people") {
        const indoc = row[1] === true || String(row[1] ?? "").toLowerCase() === "true";
        const eDrill = row[2] === true || String(row[2] ?? "").toLowerCase() === "true";
        if (indoc || eDrill) {
          training_needed.push({ name: col0, indoc, emergency_drill: eDrill });
        }
      }
    }
  }

  // ═══ 5. Parse PIC swap table + checklist from weekly sheet ═══════════════

  let pic_swap_table: PicSwapEntry[] = [];
  let crewing_checklist: CrewingChecklist | null = null;

  if (weeklySheetName) {
    const ws = wb.Sheets[weeklySheetName];
    if (ws) {
      const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" }) as unknown[][];

      // ── PIC swap table (cols 15=OLD PIC, 16=NEW PIC, 17=TAIL) ──
      // Row 4 is header (OLD PIC / NEW PIC / TAIL), data starts at 5
      for (let i = 5; i < rows.length; i++) {
        const row = rows[i];
        const oldPic = String(row[15] ?? "").trim();
        const newPic = String(row[16] ?? "").trim();
        const tail = String(row[17] ?? "").trim();
        if (!oldPic && !newPic && !tail) continue;
        // Parse names from cells like "🟢 Daniel Minarro (DEN)"
        const parseSwapName = (raw: string): string | null => {
          if (!raw || raw.includes("not swapping")) return null;
          const cleaned = raw.replace(/^[\u{1F7E0}-\u{1F7FF}\s]+/u, "").replace(/[✔✓\s]+$/u, "").trim();
          const m = cleaned.match(/^(.+?)\s*\(/);
          return m ? m[1].trim() : cleaned || null;
        };
        pic_swap_table.push({
          old_pic: parseSwapName(oldPic),
          new_pic: parseSwapName(newPic),
          tail: tail && /^N/.test(tail) ? tail : null,
        });
      }

      // ── Crewing checklist (cols 15-23, rows 0-2) ──
      if (rows.length > 2) {
        const headerRow = rows[0] as unknown[];
        const taskNames = [
          String(headerRow[16] ?? "").trim(), // "Crew Swap Needed Checks Tue/Wed/Thur"
          String(headerRow[17] ?? "").trim(), // "Flight Numbers / Times Checked"
          String(headerRow[18] ?? "").trim(), // "Duty and Hours Check"
          String(headerRow[19] ?? "").trim(), // "Crew Pairings to Choate"
          String(headerRow[20] ?? "").trim(), // "Double Booking Check"
          String(headerRow[21] ?? "").trim(), // "Add to Slack channels"
          String(headerRow[22] ?? "").trim(), // "Crew Assigned to Tails"
          String(headerRow[23] ?? "").trim(), // "Assignments Acknowledged"
        ];

        const assignees: CrewingChecklist["assignees"] = [];
        for (let r = 1; r <= 2; r++) {
          const row = rows[r] as unknown[];
          const name = String(row[15] ?? "").trim();
          if (!name) continue;
          const tasks: Record<string, boolean | string> = {};
          for (let t = 0; t < taskNames.length; t++) {
            const val = row[16 + t];
            if (val === true || val === false) tasks[taskNames[t]] = val;
            else if (String(val ?? "").trim() === "---") tasks[taskNames[t]] = "n/a";
            else tasks[taskNames[t]] = String(val ?? "").trim() === "true";
          }
          assignees.push({ name, tasks });
        }
        if (assignees.length > 0) crewing_checklist = { assignees };
      }
    }
  }

  // ═══ 6. Parse CREW CALENDAR ══════════════════════════════════════════════

  const calendar_weeks: CalendarWeek[] = [];
  const calSheet = wb.Sheets["CREW CALENDAR"];
  if (calSheet) {
    const rows = XLSX.utils.sheet_to_json(calSheet, { header: 1, defval: "" }) as unknown[][];

    // Scan for date-range headers in col 3
    for (let i = 0; i < rows.length; i++) {
      const cell = String(rows[i]?.[3] ?? "").trim();
      const headerMatch = cell.match(/([A-Za-z]+\s+\d+,\s*\d{4}\s*-\s*[A-Za-z]+\s+\d+,\s*\d{4})\s*\(Rotation\s*([AB])\)/i);
      if (!headerMatch) continue;

      const dateRange = headerMatch[1].trim();
      const rotation = headerMatch[2].toUpperCase() as "A" | "B";

      // Extract names from the 9-row block using header detection.
      // i+1: PIC header row (contains "Captains (PICs)" + type sub-headers in columns)
      // i+5: SIC header row (contains "First Officers (SICs)" + type sub-headers)
      // Types are detected from sub-header text ("Citation X", "Challenger", "Dual")
      // in the label row, then names are read from the following rows.
      //
      // The label row (e.g., i+1) contains header text like "Citation X (22):" or "Challenger (11):"
      // Names follow in columns after each header.

      // Detect column boundaries from the label/header row for a role section
      const detectTypeBoundaries = (labelRowIdx: number): { cx: [number, number]; cl: [number, number]; du: [number, number] } => {
        const defaultBounds = { cx: [4, 17] as [number, number], cl: [21, 30] as [number, number], du: [31, 35] as [number, number] };
        if (labelRowIdx >= rows.length) return defaultBounds;

        // Scan the label row for type headers
        const labelRow = rows[labelRowIdx] as unknown[];
        let cxStart = -1, clStart = -1, duStart = -1;

        // Also check the row itself and the header row above (i) for type labels
        for (let j = 0; j < Math.min(labelRow.length, 40); j++) {
          const cellStr = String(labelRow[j] ?? "").toLowerCase().trim();
          if (cellStr.includes("citation") && cxStart < 0) cxStart = j;
          else if (cellStr.includes("challenger") && clStart < 0) clStart = j;
          else if (cellStr.includes("dual") && duStart < 0) duStart = j;
        }

        // If we found at least Citation X and Challenger, use detected boundaries
        if (cxStart >= 0 && clStart >= 0) {
          const cxEnd = clStart - 1;
          const clEnd = duStart >= 0 ? duStart - 1 : Math.min(labelRow.length - 1, clStart + 14);
          const duEnd = duStart >= 0 ? Math.min(labelRow.length - 1, duStart + 6) : -1;
          return {
            cx: [cxStart, Math.max(cxStart, cxEnd)],
            cl: [clStart, Math.max(clStart, clEnd)],
            du: duStart >= 0 ? [duStart, Math.max(duStart, duEnd)] : [999, 999],
          };
        }

        return defaultBounds;
      };

      // Cross-reference names with roster to validate/correct aircraft type assignment
      const rosterTypeMap = new Map<string, "citation_x" | "challenger" | "dual">();
      for (const r of roster) {
        rosterTypeMap.set(r.name.toLowerCase().trim(), r.aircraft_type);
      }

      const extractNames = (rowIdx: number, bounds: ReturnType<typeof detectTypeBoundaries>): { citation_x: string[]; challenger: string[]; dual: string[] } => {
        if (rowIdx >= rows.length) return { citation_x: [], challenger: [], dual: [] };
        const row = rows[rowIdx] as unknown[];
        const citation_x: string[] = [];
        const challenger: string[] = [];
        const dual: string[] = [];

        for (let j = 0; j < Math.min(row.length, 40); j++) {
          const name = String(row[j] ?? "").trim();
          if (!name || typeof row[j] === "number") continue;
          // Skip header-like text
          if (name.toLowerCase().includes("citation") || name.toLowerCase().includes("challenger") ||
              name.toLowerCase().includes("dual") || name.toLowerCase().includes("captain") ||
              name.toLowerCase().includes("first officer") || /^\(\d+\)/.test(name) || /^\d+$/.test(name)) continue;

          // Cross-reference with roster for correct type
          const rosterType = rosterTypeMap.get(name.toLowerCase().trim());
          if (rosterType) {
            if (rosterType === "citation_x") citation_x.push(name);
            else if (rosterType === "challenger") challenger.push(name);
            else if (rosterType === "dual") dual.push(name);
            continue;
          }

          // Fall back to column position
          if (j >= bounds.cx[0] && j <= bounds.cx[1]) citation_x.push(name);
          else if (j >= bounds.cl[0] && j <= bounds.cl[1]) challenger.push(name);
          else if (j >= bounds.du[0] && j <= bounds.du[1]) dual.push(name);
        }
        return { citation_x, challenger, dual };
      };

      // Detect boundaries from the label rows
      const picBounds = detectTypeBoundaries(i + 1);
      const sicBounds = detectTypeBoundaries(i + 5);

      const picRow1 = extractNames(i + 2, picBounds); // names row under PIC header
      const picRow2 = extractNames(i + 3, picBounds);
      const sicRow1 = extractNames(i + 6, sicBounds); // names row under SIC header
      const sicRow2 = extractNames(i + 7, sicBounds);

      // Merge rows
      const pic = {
        citation_x: [...picRow1.citation_x, ...picRow2.citation_x],
        challenger: [...picRow1.challenger, ...picRow2.challenger],
        dual: [...picRow1.dual, ...picRow2.dual],
      };
      const sic = {
        citation_x: [...sicRow1.citation_x, ...sicRow2.citation_x],
        challenger: [...sicRow1.challenger, ...sicRow2.challenger],
        dual: [...sicRow1.dual, ...sicRow2.dual],
      };

      // Parse counts from row i+3 col 0-1 (PIC) and i+7 col 0-1 (SIC)
      const picCitCount = typeof rows[i + 3]?.[0] === "number" ? rows[i + 3][0] as number : pic.citation_x.length;
      const picClCount = typeof rows[i + 3]?.[1] === "number" ? rows[i + 3][1] as number : pic.challenger.length;
      const sicCitCount = typeof rows[i + 7]?.[0] === "number" ? rows[i + 7][0] as number : sic.citation_x.length;
      const sicClCount = typeof rows[i + 7]?.[1] === "number" ? rows[i + 7][1] as number : sic.challenger.length;

      calendar_weeks.push({
        date_range: dateRange,
        rotation,
        pic,
        sic,
        pic_count: { citation_x: picCitCount, challenger: picClCount },
        sic_count: { citation_x: sicCitCount, challenger: sicClCount },
      });
    }
  }

  // ═══ 7. Rotation counts ════════════════════════════════════════════════════

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
    bad_pairings,
    checkairmen,
    training_needed,
    recurrency_299,
    pic_swap_table,
    crewing_checklist,
    calendar_weeks,
    errors,
  };
}

// ─── Direct Sheets API parser ──────────────────────────────────────────────

/**
 * Parse crew info from pre-fetched Sheets API data (no XLSX download needed).
 * Each sheet is a 2D array of raw values. Only required tabs need to be provided.
 * This is the preferred ingestion path — faster and more reliable than XLSX export.
 */
export function parseCrewInfoFromSheets(params: {
  rosterRows?: unknown[][];
  weeklyRows?: unknown[][];
  weeklySheetName?: string;
  referenceRows?: unknown[][];  // "Different Airports .299 Bad P" sheet
  calendarRows?: unknown[][];   // "CREW CALENDAR" sheet
  slackNames?: string[];
}): CrewInfoParseResult {
  const errors: string[] = [];

  // ═══ 1. Parse CREW ROSTER ═══════════════════════════════════════════════
  const roster: CrewRosterEntry[] = [];
  const rosterNames: string[] = [];

  if (params.rosterRows && params.rosterRows.length > 0) {
    const rows = params.rosterRows;
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
        const name = String(row?.[0] ?? "").trim();
        if (!name) continue;

        const homeStr = String(row?.[1] ?? "").trim();
        const home_airports = homeStr
          .split(/[\/,]/)
          .map((a: string) => a.trim().toUpperCase().replace(/\s+/g, ""))
          .filter((a: string) => a.length >= 2 && a.length <= 5)
          .map((a: string) => a.replace(/\./g, ""));

        const rotationRaw = String(row?.[2] ?? "").trim().toUpperCase();
        let rotation: CrewRosterEntry["rotation"] = null;
        if (rotationRaw === "A") rotation = "A";
        else if (rotationRaw === "B") rotation = "B";
        else if (rotationRaw.includes("PART") || rotationRaw.includes("NON")) rotation = "part_time";

        const aircraft_type = parseAircraftType(String(row?.[3] ?? ""));
        const rankRaw = String(row?.[4] ?? "").toLowerCase();
        const role: "PIC" | "SIC" = rankRaw.includes("captain") ? "PIC" : "SIC";

        const sbVal = row?.[5];
        const skillbridge_end = excelDateToISO(sbVal);
        const is_skillbridge = !!skillbridge_end;

        const termVal = row?.[6];
        const terminated_on = excelDateToISO(termVal);
        const is_terminated = !!terminated_on;

        roster.push({
          name, home_airports, rotation, aircraft_type, role,
          is_skillbridge, skillbridge_end, is_terminated, terminated_on,
          slack_display_name: null,
        });
        rosterNames.push(name);
      }
    } else {
      errors.push("CREW ROSTER: header row not found");
    }
  } else {
    errors.push("CREW ROSTER: no data provided");
  }

  // ═══ 2. Match Slack names ═══════════════════════════════════════════════
  if (params.slackNames && params.slackNames.length > 0 && rosterNames.length > 0) {
    let matched = 0;
    for (const slackName of params.slackNames) {
      const trimmed = slackName.trim();
      if (!trimmed) continue;
      const rosterMatch = matchSlackName(trimmed, rosterNames);
      if (rosterMatch) {
        const entry = roster.find((r) => r.name === rosterMatch);
        if (entry) { entry.slack_display_name = trimmed; matched++; }
      }
    }
    if (matched < params.slackNames.length * 0.5) {
      errors.push(`Slack matching: only ${matched}/${params.slackNames.length} matched`);
    }
  }

  // ═══ 3. Parse weekly swap sheet ═════════════════════════════════════════
  let weeklySwap: WeeklySwapEntry[] | null = null;
  if (params.weeklyRows && params.weeklyRows.length > 0) {
    weeklySwap = parseWeeklySheetRows(params.weeklyRows, errors);
  }

  // ═══ 4. Parse reference data sheet ══════════════════════════════════════
  const different_airports: DifferentAirportEntry[] = [];
  const bad_pairings: BadPairing[] = [];
  const checkairmen: CheckairmanEntry[] = [];
  const training_needed: TrainingEntry[] = [];
  const recurrency_299: Recurrency299Entry[] = [];

  if (params.referenceRows && params.referenceRows.length > 0) {
    parseReferenceSheet(params.referenceRows, different_airports, bad_pairings, checkairmen, training_needed, recurrency_299);
  }

  // ═══ 5. Parse PIC swap table from weekly sheet ══════════════════════════
  let pic_swap_table: PicSwapEntry[] = [];
  let crewing_checklist: CrewingChecklist | null = null;

  if (params.weeklyRows && params.weeklyRows.length > 0) {
    const parsed = parsePicSwapAndChecklist(params.weeklyRows);
    pic_swap_table = parsed.pic_swap_table;
    crewing_checklist = parsed.crewing_checklist;
  }

  // ═══ 6. Parse CREW CALENDAR ═════════════════════════════════════════════
  const calendar_weeks: CalendarWeek[] = [];
  if (params.calendarRows && params.calendarRows.length > 0) {
    parseCalendarRows(params.calendarRows, calendar_weeks, roster);
  }

  // ═══ 7. Rotation counts ═════════════════════════════════════════════════
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
    weekly_sheet_name: params.weeklySheetName ?? null,
    different_airports,
    rotation_counts,
    bad_pairings,
    checkairmen,
    training_needed,
    recurrency_299,
    pic_swap_table,
    crewing_checklist,
    calendar_weeks,
    errors,
  };
}

// ─── Reference sheet parser (Different Airports / .299 / Bad Pairings) ──────

function parseReferenceSheet(
  rows: unknown[][],
  different_airports: DifferentAirportEntry[],
  bad_pairings: BadPairing[],
  checkairmen: CheckairmanEntry[],
  training_needed: TrainingEntry[],
  recurrency_299: Recurrency299Entry[],
) {
  let section: "airports" | "training_299" | "bad_pairings" | "checkairmen" | "training_people" | "unknown" = "airports";

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    // Check all columns for section headers (some sheets put headers in different columns)
    const allCols = (row ?? []).map((c: unknown) => String(c ?? "").trim().toLowerCase()).join(" | ");
    const col0 = String(row?.[0] ?? "").trim();
    const col0Lower = col0.toLowerCase();

    // Log first 30 rows for debugging
    if (i < 30) {
      console.log(`[RefSheet] Row ${i}: section=${section} col0="${col0}" allCols="${allCols.slice(0, 120)}"`);
    }

    if (col0Lower.includes("training needed") || allCols.includes("training needed")) { section = "training_299"; console.log(`[RefSheet] → section=training_299 at row ${i}`); continue; }
    if (col0Lower.includes("bad pairing") || allCols.includes("bad pair")) { section = "bad_pairings"; console.log(`[RefSheet] → section=bad_pairings at row ${i}`); continue; }
    if (col0Lower.includes("air checkman") || col0Lower.includes("checkairman") || allCols.includes("checkairman") || allCols.includes("check airman")) { section = "checkairmen"; console.log(`[RefSheet] → section=checkairmen at row ${i}`); continue; }
    if (col0Lower.includes("training people") || allCols.includes("training people")) { section = "training_people"; console.log(`[RefSheet] → section=training_people at row ${i}`); continue; }

    if (col0Lower === "name" || col0Lower === "pic" || col0Lower === "rotation a" || col0Lower === "different airports") continue;
    if (!col0) continue;

    if (section === "airports") {
      different_airports.push({
        name: col0,
        date: excelDateToISO(row?.[1]),
        coming_from: String(row?.[2] ?? "").trim() || null,
        going_to: String(row?.[3] ?? "").trim() || null,
        notes: String(row?.[4] ?? "").trim() || null,
      });
    }

    if (section === "training_299") {
      const month = String(row?.[1] ?? "").trim();
      if (!month) continue;
      recurrency_299.push({
        name: col0, month,
        needs_299: row?.[2] === true || String(row?.[2] ?? "").toLowerCase() === "true",
        citation_drill: row?.[3] === true || String(row?.[3] ?? "").toLowerCase() === "true",
        challenger_drill: row?.[4] === true || String(row?.[4] ?? "").toLowerCase() === "true",
      });
    }

    if (section === "bad_pairings") {
      const sic = String(row?.[1] ?? "").trim();
      const notesRaw = String(row?.[2] ?? "").trim();
      if (!sic) continue;
      let severity: BadPairing["severity"] = "minor";
      const notesLower = notesRaw.toLowerCase();
      if (notesLower.includes("very severe") || notesLower.includes("severe")) severity = "severe";
      else if (notesLower.includes("moderate") || notesLower.includes("don't like") || notesLower.includes("dont like")) severity = "moderate";
      bad_pairings.push({ pic: col0, sic, severity, notes: notesRaw });
    }

    if (section === "checkairmen") {
      const citX_A = row?.[1] === true;
      const cl_A = row?.[2] === true;
      if (col0 && (citX_A || cl_A || col0.length > 2)) {
        checkairmen.push({ name: col0, rotation: "A", citation_x: citX_A, challenger: cl_A });
      }
      const nameB = String(row?.[3] ?? "").trim();
      const citX_B = row?.[4] === true;
      const cl_B = row?.[5] === true;
      if (nameB && (citX_B || cl_B || nameB.length > 2)) {
        checkairmen.push({ name: nameB, rotation: "B", citation_x: citX_B, challenger: cl_B });
      }
      const nameOther = String(row?.[6] ?? "").trim();
      if (nameOther) {
        checkairmen.push({ name: nameOther, rotation: "other", citation_x: true, challenger: true });
      }
    }

    if (section === "training_people") {
      const indoc = row?.[1] === true || String(row?.[1] ?? "").toLowerCase() === "true";
      const eDrill = row?.[2] === true || String(row?.[2] ?? "").toLowerCase() === "true";
      if (indoc || eDrill) {
        training_needed.push({ name: col0, indoc, emergency_drill: eDrill });
      }
    }
  }
}

// ─── PIC swap table + checklist parser ──────────────────────────────────────

function parsePicSwapAndChecklist(rows: unknown[][]): { pic_swap_table: PicSwapEntry[]; crewing_checklist: CrewingChecklist | null } {
  const pic_swap_table: PicSwapEntry[] = [];
  let crewing_checklist: CrewingChecklist | null = null;

  const parseSwapName = (raw: string): string | null => {
    if (!raw || raw.includes("not swapping")) return null;
    const cleaned = raw.replace(/^[\u{1F7E0}-\u{1F7FF}\s]+/u, "").replace(/[✔✓\s]+$/u, "").trim();
    const m = cleaned.match(/^(.+?)\s*\(/);
    return m ? m[1].trim() : cleaned || null;
  };

  for (let i = 5; i < rows.length; i++) {
    const row = rows[i];
    const oldPic = String(row?.[15] ?? "").trim();
    const newPic = String(row?.[16] ?? "").trim();
    const tail = String(row?.[17] ?? "").trim();
    if (!oldPic && !newPic && !tail) continue;
    pic_swap_table.push({
      old_pic: parseSwapName(oldPic),
      new_pic: parseSwapName(newPic),
      tail: tail && /^N/.test(tail) ? tail : null,
    });
  }

  if (rows.length > 2) {
    const headerRow = rows[0] as unknown[];
    const taskNames = Array.from({ length: 8 }, (_, i) => String(headerRow?.[16 + i] ?? "").trim());
    const assignees: CrewingChecklist["assignees"] = [];
    for (let r = 1; r <= 2; r++) {
      const row = rows[r] as unknown[];
      const name = String(row?.[15] ?? "").trim();
      if (!name) continue;
      const tasks: Record<string, boolean | string> = {};
      for (let t = 0; t < taskNames.length; t++) {
        const val = row?.[16 + t];
        if (val === true || val === false) tasks[taskNames[t]] = val;
        else if (String(val ?? "").trim() === "---") tasks[taskNames[t]] = "n/a";
        else tasks[taskNames[t]] = String(val ?? "").trim() === "true";
      }
      assignees.push({ name, tasks });
    }
    if (assignees.length > 0) crewing_checklist = { assignees };
  }

  return { pic_swap_table, crewing_checklist };
}

// ─── Calendar parser ────────────────────────────────────────────────────────

function parseCalendarRows(rows: unknown[][], calendar_weeks: CalendarWeek[], roster: CrewRosterEntry[]) {
  const rosterTypeMap = new Map<string, "citation_x" | "challenger" | "dual">();
  for (const r of roster) {
    rosterTypeMap.set(r.name.toLowerCase().trim(), r.aircraft_type);
  }

  for (let i = 0; i < rows.length; i++) {
    const cell = String(rows[i]?.[3] ?? "").trim();
    const headerMatch = cell.match(/([A-Za-z]+\s+\d+,\s*\d{4}\s*-\s*[A-Za-z]+\s+\d+,\s*\d{4})\s*\(Rotation\s*([AB])\)/i);
    if (!headerMatch) continue;

    const dateRange = headerMatch[1].trim();
    const rotation = headerMatch[2].toUpperCase() as "A" | "B";

    const detectTypeBoundaries = (labelRowIdx: number): { cx: [number, number]; cl: [number, number]; du: [number, number] } => {
      const defaultBounds = { cx: [4, 17] as [number, number], cl: [21, 30] as [number, number], du: [31, 35] as [number, number] };
      if (labelRowIdx >= rows.length) return defaultBounds;
      const labelRow = rows[labelRowIdx] as unknown[];
      let cxStart = -1, clStart = -1, duStart = -1;
      for (let j = 0; j < Math.min(labelRow?.length ?? 0, 40); j++) {
        const cellStr = String(labelRow[j] ?? "").toLowerCase().trim();
        if (cellStr.includes("citation") && cxStart < 0) cxStart = j;
        else if (cellStr.includes("challenger") && clStart < 0) clStart = j;
        else if (cellStr.includes("dual") && duStart < 0) duStart = j;
      }
      if (cxStart >= 0 && clStart >= 0) {
        const cxEnd = clStart - 1;
        const clEnd = duStart >= 0 ? duStart - 1 : Math.min((labelRow?.length ?? 0) - 1, clStart + 14);
        const duEnd = duStart >= 0 ? Math.min((labelRow?.length ?? 0) - 1, duStart + 6) : -1;
        return {
          cx: [cxStart, Math.max(cxStart, cxEnd)],
          cl: [clStart, Math.max(clStart, clEnd)],
          du: duStart >= 0 ? [duStart, Math.max(duStart, duEnd)] : [999, 999],
        };
      }
      return defaultBounds;
    };

    const extractNames = (rowIdx: number, bounds: ReturnType<typeof detectTypeBoundaries>): { citation_x: string[]; challenger: string[]; dual: string[] } => {
      if (rowIdx >= rows.length) return { citation_x: [], challenger: [], dual: [] };
      const row = rows[rowIdx] as unknown[];
      const citation_x: string[] = [];
      const challenger: string[] = [];
      const dual: string[] = [];
      for (let j = 0; j < Math.min(row?.length ?? 0, 40); j++) {
        const name = String(row[j] ?? "").trim();
        if (!name || typeof row[j] === "number") continue;
        if (name.toLowerCase().includes("citation") || name.toLowerCase().includes("challenger") ||
            name.toLowerCase().includes("dual") || name.toLowerCase().includes("captain") ||
            name.toLowerCase().includes("first officer") || /^\(\d+\)/.test(name) || /^\d+$/.test(name)) continue;
        const rosterType = rosterTypeMap.get(name.toLowerCase().trim());
        if (rosterType) {
          if (rosterType === "citation_x") citation_x.push(name);
          else if (rosterType === "challenger") challenger.push(name);
          else if (rosterType === "dual") dual.push(name);
          continue;
        }
        if (j >= bounds.cx[0] && j <= bounds.cx[1]) citation_x.push(name);
        else if (j >= bounds.cl[0] && j <= bounds.cl[1]) challenger.push(name);
        else if (j >= bounds.du[0] && j <= bounds.du[1]) dual.push(name);
      }
      return { citation_x, challenger, dual };
    };

    const picBounds = detectTypeBoundaries(i + 1);
    const sicBounds = detectTypeBoundaries(i + 5);
    const picRow1 = extractNames(i + 2, picBounds);
    const picRow2 = extractNames(i + 3, picBounds);
    const sicRow1 = extractNames(i + 6, sicBounds);
    const sicRow2 = extractNames(i + 7, sicBounds);

    const pic = {
      citation_x: [...picRow1.citation_x, ...picRow2.citation_x],
      challenger: [...picRow1.challenger, ...picRow2.challenger],
      dual: [...picRow1.dual, ...picRow2.dual],
    };
    const sic = {
      citation_x: [...sicRow1.citation_x, ...sicRow2.citation_x],
      challenger: [...sicRow1.challenger, ...sicRow2.challenger],
      dual: [...sicRow1.dual, ...sicRow2.dual],
    };

    const picCitCount = typeof rows[i + 3]?.[0] === "number" ? rows[i + 3]![0] as number : pic.citation_x.length;
    const picClCount = typeof rows[i + 3]?.[1] === "number" ? rows[i + 3]![1] as number : pic.challenger.length;
    const sicCitCount = typeof rows[i + 7]?.[0] === "number" ? rows[i + 7]![0] as number : sic.citation_x.length;
    const sicClCount = typeof rows[i + 7]?.[1] === "number" ? rows[i + 7]![1] as number : sic.challenger.length;

    calendar_weeks.push({
      date_range: dateRange, rotation, pic, sic,
      pic_count: { citation_x: picCitCount, challenger: picClCount },
      sic_count: { citation_x: sicCitCount, challenger: sicClCount },
    });
  }
}

// ─── Weekly sheet parser ────────────────────────────────────────────────────

/** Parse a weekly swap sheet from raw 2D array (works with both XLSX and Sheets API data) */
export function parseWeeklySheetRows(rows: unknown[][], errors: string[]): WeeklySwapEntry[] {
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
