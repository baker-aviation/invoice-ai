/**
 * Raw sheet data validation for weekly swap tabs.
 *
 * Validates the raw unknown[][] from Google Sheets API BEFORE parseWeeklySheetRows
 * touches it. Catches format issues that would cause silent parse failures.
 */

import { isValidIcao, isValid24hTime, type ValidationIssue, type ValidationResult } from "./swapValidation";

// Emoji prefixes used in column C crew cells
const CREW_CELL_EMOJIS = [
  "\u{1F7E2}", // 🟢 Citation X
  "\u{1F7E1}", // 🟡 Challenger
  "\u{1F7E3}", // 🟣 Dual-qualified
  "\u{1F7E0}", // 🟠
  "\u{1F534}", // 🔴
  "\u{26AA}",  // ⚪
];

// Section header keywords in column C (index 2)
const SECTION_HEADERS = ["ONCOMING PILOTS", "OFFGOING PILOTS", "PILOT IN-COMMAND", "SECOND IN-COMMAND"];

function isSectionHeader(value: string): boolean {
  const upper = value.toUpperCase();
  return SECTION_HEADERS.some((h) => upper === h) || upper.startsWith("NAME (HOME");
}

function isCrewCell(value: string): boolean {
  // Must contain name + (airports) pattern
  const cleaned = value
    .replace(/[\u{1F7E0}-\u{1F7FF}\u{2B1B}\u{2B1C}\u{26AA}\u{26AB}]/gu, "") // strip emojis
    .replace(/[✔✓]/g, "")
    .trim();
  return /^.+?\s*\([^)]+\)\s*$/.test(cleaned);
}

function isExcelDate(value: unknown): boolean {
  if (typeof value === "number") return value > 40000 && value < 60000; // Excel serial date range
  if (typeof value === "string") {
    // Accept ISO dates, "MM/DD/YYYY", "M/D/YYYY", "M/D" (short), or sheet-formatted dates
    return /^\d{4}-\d{2}-\d{2}/.test(value) || /^\d{1,2}\/\d{1,2}(\/\d{2,4})?$/.test(value);
  }
  return false;
}

/** Common placeholder strings that mean "no data" in the sheet */
const PLACEHOLDER_VALUES = new Set(["---", "--", "-", "n/a", "tbd", "tba", "at landing", "at departure", "upon arrival"]);

function isPlaceholder(value: unknown): boolean {
  if (value == null || value === "") return true;
  return typeof value === "string" && PLACEHOLDER_VALUES.has(value.trim().toLowerCase());
}

function isTimeValue(value: unknown): boolean {
  if (value == null || value === "") return false;
  if (isPlaceholder(value)) return true;
  const s = String(value).replace(/L$/i, "").trim();
  if (!s) return false;
  // Number (Excel decimal time, e.g., 0.75 = 18:00)
  if (typeof value === "number") return true;
  return isValid24hTime(s) || /^\d{1,2}:\d{2}\s*(AM|PM)$/i.test(s);
}

function isNumericPrice(value: unknown): boolean {
  if (isPlaceholder(value)) return true;
  if (typeof value === "number") return true;
  if (typeof value === "string") {
    const cleaned = value.replace(/[$,\s]/g, "");
    return cleaned === "" || !isNaN(parseFloat(cleaned));
  }
  return false;
}

/**
 * Validate raw sheet data from a weekly swap tab.
 * This runs on the raw unknown[][] before any parsing.
 */
export function validateRawSheetData(rows: unknown[][], sheetName: string): ValidationResult {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];

  if (!rows || rows.length === 0) {
    errors.push({
      severity: "error",
      field: "sheet",
      message: `Sheet "${sheetName}" is empty — no data found`,
    });
    return { valid: false, errors, warnings };
  }

  // ── Check sheet name format ────────────────────────────────────────────
  if (!/[A-Z]{3}\s+\d+-[A-Z]{3}\s+\d+\s*\([AB]\)/i.test(sheetName)) {
    warnings.push({
      severity: "warning",
      field: "sheet_name",
      message: `Sheet name "${sheetName}" doesn't match expected format (e.g., "APR 8-APR 16 (A)")`,
    });
  }

  // ── Check section headers ──────────────────────────────────────────────
  const sectionTransitions: { header: string; row: number }[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const col2 = String(row?.[2] ?? "").trim().toUpperCase();
    if (col2 === "ONCOMING PILOTS" || col2 === "OFFGOING PILOTS" ||
        col2 === "PILOT IN-COMMAND" || col2 === "SECOND IN-COMMAND") {
      sectionTransitions.push({ header: col2, row: i + 1 });
    }
  }

  const requiredHeaders = ["ONCOMING PILOTS", "OFFGOING PILOTS", "PILOT IN-COMMAND", "SECOND IN-COMMAND"];
  for (const h of requiredHeaders) {
    const found = sectionTransitions.filter((s) => s.header === h);
    if (found.length === 0) {
      errors.push({
        severity: "error",
        field: "section_header",
        message: `Missing section header: "${h}" — sheet structure may be corrupted`,
      });
    }
  }

  // PIC/SIC headers should appear at least twice (once under ONCOMING, once under OFFGOING)
  const picCount = sectionTransitions.filter((s) => s.header === "PILOT IN-COMMAND").length;
  const sicCount = sectionTransitions.filter((s) => s.header === "SECOND IN-COMMAND").length;
  if (picCount < 2) {
    warnings.push({
      severity: "warning",
      field: "section_header",
      message: `Expected 2 "PILOT IN-COMMAND" sections (oncoming + offgoing), found ${picCount}`,
    });
  }
  if (sicCount < 2) {
    warnings.push({
      severity: "warning",
      field: "section_header",
      message: `Expected 2 "SECOND IN-COMMAND" sections (oncoming + offgoing), found ${sicCount}`,
    });
  }

  // ── Validate data rows ─────────────────────────────────────────────────
  let currentSection = "unknown";
  let currentRole = "unknown";
  const crewNames: { name: string; section: string; row: number }[] = [];
  let oncomingPicCount = 0;
  let offgoingPicCount = 0;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row || !Array.isArray(row)) continue;

    const rowNum = i + 1; // 1-indexed for user display
    const col2 = String(row[2] ?? "").trim();
    const col2Upper = col2.toUpperCase();

    // Track current section
    if (col2Upper === "ONCOMING PILOTS") { currentSection = "oncoming"; continue; }
    if (col2Upper === "OFFGOING PILOTS") { currentSection = "offgoing"; continue; }
    if (col2Upper === "PILOT IN-COMMAND") { currentRole = "PIC"; continue; }
    if (col2Upper === "SECOND IN-COMMAND") { currentRole = "SIC"; continue; }
    if (isSectionHeader(col2)) continue;

    // Skip empty rows
    if (!col2) continue;

    // ── Column C: Crew cell ──────────────────────────────────────────
    if (!isCrewCell(col2)) {
      // Could be a data row with an unparseable crew cell
      // Check if it looks like it's trying to be a crew entry (has content in other columns)
      const hasOtherData = row.slice(3, 11).some((v) => v != null && String(v).trim() !== "");
      if (hasOtherData) {
        warnings.push({
          severity: "warning",
          field: "crew_cell",
          message: `Row ${rowNum}: crew cell "${col2.slice(0, 50)}" is not parseable — expected "Name (Airport/Airport)" — row skipped`,
          row: rowNum,
          subject: col2.slice(0, 30),
        });
      }
      continue;
    }

    // Extract name for duplicate checking
    const cleaned = col2
      .replace(/[\u{1F7E0}-\u{1F7FF}\u{2B1B}\u{2B1C}\u{26AA}\u{26AB}]/gu, "")
      .replace(/[✔✓\s]+$/u, "")
      .trim();
    const nameMatch = cleaned.match(/^(.+?)\s*\(([^)]+)\)\s*$/);
    if (nameMatch) {
      const name = nameMatch[1].trim();
      crewNames.push({ name, section: currentSection, row: rowNum });
      if (currentSection === "oncoming" && currentRole === "PIC") oncomingPicCount++;
      if (currentSection === "offgoing" && currentRole === "PIC") offgoingPicCount++;

      // Validate home airports
      const homeStr = nameMatch[2].trim();
      const airports = homeStr.split(/[\/,]/).map((a) => a.trim().toUpperCase().replace(/\./g, ""));
      for (const apt of airports) {
        if (apt.length >= 2 && apt.length <= 5 && !isValidIcao(apt)) {
          warnings.push({
            severity: "warning",
            field: "home_airport",
            message: `Row ${rowNum}: unusual home airport code "${apt}" for ${name}`,
            row: rowNum,
            subject: name,
          });
        }
      }
    }

    // ── Column B: Volunteer status ───────────────────────────────────
    const colB = String(row[1] ?? "").trim().toUpperCase();
    if (colB && !["E", "L", "SB", "TRUE", ""].includes(colB)) {
      warnings.push({
        severity: "warning",
        field: "volunteer",
        message: `Row ${rowNum}: unexpected volunteer flag "${colB}" — expected E, L, SB, or empty`,
        row: rowNum,
        subject: nameMatch?.[1]?.trim(),
      });
    }

    // ── Column E: Tail number ────────────────────────────────────────
    const colE = String(row[4] ?? "").trim();
    if (colE && !/^N\d{1,5}[A-Z]{0,2}$/i.test(colE)) {
      warnings.push({
        severity: "warning",
        field: "tail_number",
        message: `Row ${rowNum}: invalid tail number "${colE}" — expected N-number format`,
        row: rowNum,
        subject: nameMatch?.[1]?.trim(),
      });
    }

    // ── Column D: Swap location ──────────────────────────────────────
    const colD = String(row[3] ?? "").trim().toUpperCase();
    const SWAP_LOC_KEYWORDS = new Set(["STAYING", "STAYING ON", "HOME", "TBD", "N/A", "---", "--"]);
    if (colD && colD.length >= 2 && !isValidIcao(colD) && !SWAP_LOC_KEYWORDS.has(colD)) {
      warnings.push({
        severity: "warning",
        field: "swap_location",
        message: `Row ${rowNum}: unusual swap location code "${colD}"`,
        row: rowNum,
        subject: nameMatch?.[1]?.trim(),
      });
    }

    // ── Column G: Date ───────────────────────────────────────────────
    const colG = row[6];
    if (colG != null && String(colG).trim() !== "" && !isPlaceholder(colG) && !isExcelDate(colG)) {
      warnings.push({
        severity: "warning",
        field: "date",
        message: `Row ${rowNum}: unparseable date value "${String(colG).slice(0, 20)}"`,
        row: rowNum,
        subject: nameMatch?.[1]?.trim(),
      });
    }

    // ── Column H/I: Times ────────────────────────────────────────────
    const colH = row[7];
    if (colH != null && String(colH).trim() !== "" && !isTimeValue(colH)) {
      warnings.push({
        severity: "warning",
        field: "depart_time",
        message: `Row ${rowNum}: unparseable departure time "${String(colH).slice(0, 20)}"`,
        row: rowNum,
        subject: nameMatch?.[1]?.trim(),
      });
    }
    const colI = row[8];
    if (colI != null && String(colI).trim() !== "" && !isTimeValue(colI)) {
      warnings.push({
        severity: "warning",
        field: "arrival_time",
        message: `Row ${rowNum}: unparseable arrival time "${String(colI).slice(0, 20)}"`,
        row: rowNum,
        subject: nameMatch?.[1]?.trim(),
      });
    }

    // ── Column J: Price ──────────────────────────────────────────────
    if (!isNumericPrice(row[9])) {
      warnings.push({
        severity: "warning",
        field: "price",
        message: `Row ${rowNum}: non-numeric price value "${String(row[9]).slice(0, 20)}"`,
        row: rowNum,
        subject: nameMatch?.[1]?.trim(),
      });
    }
  }

  // ── Cross-row checks ───────────────────────────────────────────────────

  // Check for crew appearing in both oncoming and offgoing
  const oncomingNames = new Set(crewNames.filter((c) => c.section === "oncoming").map((c) => c.name.toLowerCase()));
  const offgoingNames = crewNames.filter((c) => c.section === "offgoing");
  for (const off of offgoingNames) {
    if (oncomingNames.has(off.name.toLowerCase())) {
      warnings.push({
        severity: "warning",
        field: "crew_section",
        message: `"${off.name}" appears in both ONCOMING and OFFGOING sections (row ${off.row}) — may be staying on for a second rotation`,
        row: off.row,
        subject: off.name,
      });
    }
  }

  // Must have at least 1 PIC in each direction
  if (oncomingPicCount === 0) {
    errors.push({
      severity: "error",
      field: "crew_count",
      message: "No oncoming PICs found — sheet may be incomplete",
    });
  }
  if (offgoingPicCount === 0) {
    errors.push({
      severity: "error",
      field: "crew_count",
      message: "No offgoing PICs found — sheet may be incomplete",
    });
  }

  // Total crew sanity check
  if (crewNames.length === 0) {
    errors.push({
      severity: "error",
      field: "crew_count",
      message: "No crew entries found in sheet — check that crew cells have the format: Name (Airport)",
    });
  } else if (crewNames.length < 4) {
    warnings.push({
      severity: "warning",
      field: "crew_count",
      message: `Only ${crewNames.length} crew entries found — expected at least 4 (PIC+SIC in each direction)`,
    });
  }

  // Cap warnings
  if (warnings.length > 30) {
    const trimmed = warnings.length - 30;
    warnings.splice(30);
    warnings.push({
      severity: "warning",
      field: "sheet",
      message: `...and ${trimmed} more warnings`,
    });
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}
