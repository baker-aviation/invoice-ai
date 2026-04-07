/**
 * Pre-optimization validation for crew swap data.
 *
 * Runs before the optimizer to catch bad data from sheet parsing.
 * Returns errors (block optimization) and warnings (proceed with caution).
 */

import type { CrewMember, FlightLeg, SwapAssignment } from "./swapOptimizer";

export type ValidationIssue = {
  severity: "error" | "warning";
  field: string;
  message: string;
  /** Row reference for sheet-sourced issues (e.g., "Row 12") */
  row?: number;
  /** Crew member or tail number involved */
  subject?: string;
};

export type ValidationResult = {
  valid: boolean; // false if any errors (warnings don't block)
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
};

// Known ICAO prefixes for airport code validation
const VALID_ICAO_PREFIXES = ["K", "C", "M", "T", "P", "PH", "PA"];

function isValidIcao(code: string): boolean {
  if (!code || code.length < 3 || code.length > 4) return false;
  // Allow 3-letter IATA codes and 4-letter ICAO codes
  if (code.length === 3) return /^[A-Z]{3}$/.test(code);
  return /^[A-Z]{4}$/.test(code);
}

function isValid24hTime(time: string): boolean {
  // Accepts HHMM, HH:MM, or ISO datetime strings
  if (/^\d{4}$/.test(time)) {
    const h = parseInt(time.slice(0, 2));
    const m = parseInt(time.slice(2));
    return h >= 0 && h <= 23 && m >= 0 && m <= 59;
  }
  if (/^\d{2}:\d{2}$/.test(time)) {
    const [h, m] = time.split(":").map(Number);
    return h >= 0 && h <= 23 && m >= 0 && m <= 59;
  }
  // ISO datetime
  if (/^\d{4}-\d{2}-\d{2}T/.test(time)) {
    return !isNaN(new Date(time).getTime());
  }
  return false;
}

/**
 * Validate swap assignments — checks that all required fields are present and consistent.
 */
export function validateSwapAssignments(
  swapAssignments: Record<string, SwapAssignment>,
  crewRoster: CrewMember[],
  flights: FlightLeg[],
): ValidationResult {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];

  const rosterNames = new Set(crewRoster.map((c) => c.name));
  const rosterByName = new Map(crewRoster.map((c) => [c.name, c]));

  // ── Check each tail's assignments ──────────────────────────────────
  for (const [tail, sa] of Object.entries(swapAssignments)) {
    // Tail number format
    if (!/^N\d{1,5}[A-Z]{0,2}$/i.test(tail)) {
      errors.push({
        severity: "error",
        field: "tail_number",
        message: `Invalid tail number format: "${tail}" (expected N-number like N123AB)`,
        subject: tail,
      });
    }

    // Must have at least offgoing PIC
    if (!sa.offgoing_pic) {
      warnings.push({
        severity: "warning",
        field: "offgoing_pic",
        message: `${tail}: no offgoing PIC assigned`,
        subject: tail,
      });
    }

    // Validate crew names exist in roster
    const crewFields: [string, string | null][] = [
      ["offgoing_pic", sa.offgoing_pic],
      ["offgoing_sic", sa.offgoing_sic],
      ["oncoming_pic", sa.oncoming_pic],
      ["oncoming_sic", sa.oncoming_sic],
    ];

    for (const [field, name] of crewFields) {
      if (!name) continue;
      if (!rosterNames.has(name)) {
        warnings.push({
          severity: "warning",
          field,
          message: `${tail}: "${name}" not found in crew roster — may cause matching issues`,
          subject: name,
        });
      }
    }

    // Check PIC↔PIC, SIC↔SIC role consistency
    if (sa.offgoing_pic && sa.oncoming_pic) {
      const offCrew = rosterByName.get(sa.offgoing_pic);
      const onCrew = rosterByName.get(sa.oncoming_pic);
      if (offCrew && onCrew && offCrew.role !== "PIC") {
        errors.push({
          severity: "error",
          field: "offgoing_pic",
          message: `${tail}: "${sa.offgoing_pic}" is listed as ${offCrew.role} in roster but assigned as PIC`,
          subject: sa.offgoing_pic,
        });
      }
    }

    // Check for duplicate crew across tails
    for (const [field, name] of crewFields) {
      if (!name) continue;
      for (const [otherTail, otherSa] of Object.entries(swapAssignments)) {
        if (otherTail === tail) continue;
        const otherNames = [otherSa.offgoing_pic, otherSa.offgoing_sic, otherSa.oncoming_pic, otherSa.oncoming_sic];
        if (otherNames.includes(name)) {
          warnings.push({
            severity: "warning",
            field,
            message: `"${name}" assigned to both ${tail} and ${otherTail}`,
            subject: name,
          });
          break; // Only warn once per name
        }
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Validate flight data quality before optimizer runs.
 */
export function validateFlights(
  flights: FlightLeg[],
  swapDate: string,
): ValidationResult {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];

  if (flights.length === 0) {
    errors.push({
      severity: "error",
      field: "flights",
      message: "No flights loaded — sync JetInsight schedule first",
    });
    return { valid: false, errors, warnings };
  }

  // Check flights around the swap date
  const swapDateTs = new Date(swapDate + "T00:00:00Z").getTime();
  const swapDayFlights = flights.filter((f) => {
    const depTs = new Date(f.scheduled_departure).getTime();
    return Math.abs(depTs - swapDateTs) < 24 * 60 * 60_000;
  });

  if (swapDayFlights.length === 0) {
    warnings.push({
      severity: "warning",
      field: "flights",
      message: `No flights found on swap day (${swapDate}) — schedule may not be synced`,
    });
  }

  for (let i = 0; i < flights.length; i++) {
    const f = flights[i];
    const row = i + 1;

    // Required fields
    if (!f.tail_number) {
      errors.push({ severity: "error", field: "tail_number", message: `Row ${row}: missing tail number`, row });
    }
    if (!f.departure_icao) {
      errors.push({ severity: "error", field: "departure_icao", message: `Row ${row}: missing departure airport`, row, subject: f.tail_number });
    }
    if (!f.arrival_icao) {
      errors.push({ severity: "error", field: "arrival_icao", message: `Row ${row}: missing arrival airport`, row, subject: f.tail_number });
    }
    if (!f.scheduled_departure) {
      errors.push({ severity: "error", field: "scheduled_departure", message: `Row ${row}: missing departure time`, row, subject: f.tail_number });
    }

    // Airport code format
    if (f.departure_icao && !isValidIcao(f.departure_icao)) {
      warnings.push({ severity: "warning", field: "departure_icao", message: `Row ${row}: unusual airport code "${f.departure_icao}"`, row, subject: f.tail_number });
    }
    if (f.arrival_icao && !isValidIcao(f.arrival_icao)) {
      warnings.push({ severity: "warning", field: "arrival_icao", message: `Row ${row}: unusual airport code "${f.arrival_icao}"`, row, subject: f.tail_number });
    }

    // Time consistency
    if (f.scheduled_departure && f.scheduled_arrival) {
      const depTs = new Date(f.scheduled_departure).getTime();
      const arrTs = new Date(f.scheduled_arrival).getTime();
      if (arrTs <= depTs) {
        warnings.push({
          severity: "warning",
          field: "scheduled_arrival",
          message: `Row ${row}: arrival (${f.scheduled_arrival.slice(11, 16)}) is before departure (${f.scheduled_departure.slice(11, 16)})`,
          row,
          subject: f.tail_number,
        });
      }
      // Flag extremely long flights (> 8 hours)
      const durationHrs = (arrTs - depTs) / (60 * 60_000);
      if (durationHrs > 8) {
        warnings.push({
          severity: "warning",
          field: "duration",
          message: `Row ${row}: ${f.tail_number} flight duration is ${durationHrs.toFixed(1)}hr (${f.departure_icao}→${f.arrival_icao})`,
          row,
          subject: f.tail_number,
        });
      }
    }
  }

  // Cap warnings to prevent noise
  if (warnings.length > 20) {
    const trimmed = warnings.length - 20;
    warnings.splice(20);
    warnings.push({
      severity: "warning",
      field: "flights",
      message: `...and ${trimmed} more warnings`,
    });
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Validate crew roster data quality.
 */
export function validateCrewRoster(crewRoster: CrewMember[]): ValidationResult {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];

  if (crewRoster.length === 0) {
    errors.push({
      severity: "error",
      field: "crew_roster",
      message: "No crew members loaded — sync crew roster first",
    });
    return { valid: false, errors, warnings };
  }

  const nameCount = new Map<string, number>();
  for (const c of crewRoster) {
    nameCount.set(c.name, (nameCount.get(c.name) ?? 0) + 1);

    if (!c.name || c.name.length < 3) {
      errors.push({ severity: "error", field: "name", message: `Invalid crew name: "${c.name}"`, subject: c.name });
    }

    if (c.home_airports.length === 0) {
      warnings.push({ severity: "warning", field: "home_airports", message: `${c.name}: no home airports set`, subject: c.name });
    }

    for (const apt of c.home_airports) {
      if (!isValidIcao(apt)) {
        warnings.push({ severity: "warning", field: "home_airports", message: `${c.name}: unusual home airport code "${apt}"`, subject: c.name });
      }
    }

    if (c.aircraft_types.length === 0) {
      warnings.push({ severity: "warning", field: "aircraft_types", message: `${c.name}: no aircraft type set`, subject: c.name });
    }
  }

  // Check for duplicate names (same name, same role)
  for (const [name, count] of nameCount) {
    if (count > 1) {
      warnings.push({ severity: "warning", field: "name", message: `"${name}" appears ${count} times in roster — possible duplicate`, subject: name });
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Run all pre-optimization validations. Returns combined result.
 * If valid=false, optimization should be blocked.
 */
export function validatePreOptimization(params: {
  swapAssignments: Record<string, SwapAssignment>;
  crewRoster: CrewMember[];
  flights: FlightLeg[];
  swapDate: string;
}): ValidationResult {
  const allErrors: ValidationIssue[] = [];
  const allWarnings: ValidationIssue[] = [];

  const rosterResult = validateCrewRoster(params.crewRoster);
  allErrors.push(...rosterResult.errors);
  allWarnings.push(...rosterResult.warnings);

  const flightResult = validateFlights(params.flights, params.swapDate);
  allErrors.push(...flightResult.errors);
  allWarnings.push(...flightResult.warnings);

  const assignmentResult = validateSwapAssignments(
    params.swapAssignments,
    params.crewRoster,
    params.flights,
  );
  allErrors.push(...assignmentResult.errors);
  allWarnings.push(...assignmentResult.warnings);

  return {
    valid: allErrors.length === 0,
    errors: allErrors,
    warnings: allWarnings,
  };
}
