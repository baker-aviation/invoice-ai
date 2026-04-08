/**
 * Game Day Operations — Suggestion Engine
 *
 * For each schedule change impact, generates ranked suggestions
 * ordered by least disruption first. Philosophy:
 *   - Minimize changes to the original plan
 *   - Prefer single-crew fixes over multi-tail swaps
 *   - Stability over cost savings
 */

import "server-only";
import { createServiceClient } from "@/lib/supabase/service";
import { getCachedRoute } from "@/lib/commercialFlightCache";
import { estimateDriveTime } from "@/lib/driveTime";
import { toIata, toIcao } from "@/lib/swapOptimizer";
import { DEFAULT_AIRPORT_ALIASES } from "@/lib/airportAliases";
import { UBER_MAX_MINUTES } from "@/lib/swapRules";
import type { PlanImpact } from "@/lib/swapPlanImpact";

// ─── Types ──────────────────────────────────────────────────────────────────

export type Suggestion = {
  type:
    | "no_action"
    | "earlier_flight"
    | "backup_flight"
    | "ground_transport"
    | "pool_swap"
    | "reoptimize"
    | "rebook"
    | "review_swap_points";
  description: string;
  estimated_cost_delta: number | null;
  crew_affected_count: number;
  auto_applicable: boolean;
  /** Optional data for auto-apply */
  metadata?: Record<string, unknown>;
};

type PlanRow = {
  name: string;
  role: "PIC" | "SIC";
  direction: "oncoming" | "offgoing";
  tail_number: string;
  swap_location: string | null;
  travel_type: string;
  flight_number: string | null;
  home_airports?: string[];
};

// ─── Main function ──────────────────────────────────────────────────────────

/**
 * Generate suggestions for a list of impacts.
 * Reads plan data and commercial flight cache to find alternatives.
 */
export async function generateSuggestions(
  impacts: PlanImpact[],
  swapDate: string,
  planRows: PlanRow[],
): Promise<Map<string, Suggestion[]>> {
  const result = new Map<string, Suggestion[]>();

  // Load crew home airports for transport lookups
  const supa = createServiceClient();
  const crewNames = [...new Set(impacts.flatMap((i) => i.affected_crew.map((c) => c.name)))];
  const { data: crewData } = crewNames.length > 0
    ? await supa
        .from("crew_members")
        .select("name, home_airports")
        .in("name", crewNames)
    : { data: [] };

  const homeAirportMap = new Map<string, string[]>();
  for (const c of crewData ?? []) {
    homeAirportMap.set(c.name as string, (c.home_airports as string[]) ?? []);
  }

  for (const impact of impacts) {
    const suggestions = await suggestForImpact(
      impact,
      swapDate,
      planRows,
      homeAirportMap,
    );
    result.set(impact.alert_id, suggestions);
  }

  return result;
}

// ─── Per-impact suggestion logic ────────────────────────────────────────────

async function suggestForImpact(
  impact: PlanImpact,
  swapDate: string,
  planRows: PlanRow[],
  homeAirportMap: Map<string, string[]>,
): Promise<Suggestion[]> {
  const suggestions: Suggestion[] = [];

  // Route to the right handler based on what the alert's about
  const isTimeCritical = impact.severity === "critical" &&
    impact.affected_crew.some((c) => c.detail.includes("Arrives after"));
  const isTimeWarning = impact.severity === "warning" &&
    impact.affected_crew.some((c) => c.detail.includes("Buffer only"));

  if (isTimeCritical) {
    await suggestForTimeCritical(impact, swapDate, planRows, homeAirportMap, suggestions);
  } else if (isTimeWarning) {
    suggestForTimeWarning(impact, suggestions);
  }

  // Cancelled leg
  if (impact.affected_crew.some((c) => c.detail.includes("cancelled"))) {
    suggestions.push({
      type: "reoptimize",
      description: `Leg cancelled on ${impact.tail_number} — re-run optimizer for this tail to recalculate swap points`,
      estimated_cost_delta: null,
      crew_affected_count: impact.affected_crew.length,
      auto_applicable: false,
    });
  }

  // Added leg
  if (impact.affected_crew.some((c) => c.detail.includes("New leg added"))) {
    suggestions.push({
      type: "review_swap_points",
      description: `New leg added to ${impact.tail_number} — review swap points (new leg may create a better swap opportunity)`,
      estimated_cost_delta: null,
      crew_affected_count: impact.affected_crew.length,
      auto_applicable: false,
    });
  }

  // Airport change
  if (impact.affected_crew.some((c) => c.detail.includes("Traveling to"))) {
    const affectedOncoming = impact.affected_crew.filter(
      (c) => c.direction === "oncoming" && c.detail.includes("Traveling to"),
    );
    for (const crew of affectedOncoming) {
      suggestions.push({
        type: "rebook",
        description: `${crew.name} is headed to the wrong airport — rebook transport to new location`,
        estimated_cost_delta: null,
        crew_affected_count: 1,
        auto_applicable: false,
      });
    }
  }

  // If nothing specific, and it's just info severity
  if (suggestions.length === 0 && impact.severity === "info") {
    suggestions.push({
      type: "no_action",
      description: "Minor schedule shift — current plan still works",
      estimated_cost_delta: 0,
      crew_affected_count: 0,
      auto_applicable: false,
    });
  }

  return suggestions;
}

// ─── Time-critical: crew will miss the aircraft ─────────────────────────────

async function suggestForTimeCritical(
  impact: PlanImpact,
  swapDate: string,
  planRows: PlanRow[],
  homeAirportMap: Map<string, string[]>,
  suggestions: Suggestion[],
): Promise<void> {
  const lateOncoming = impact.affected_crew.filter(
    (c) => c.direction === "oncoming" && c.detail.includes("Arrives after"),
  );

  for (const crew of lateOncoming) {
    // Find the crew's plan row for swap location
    const planRow = planRows.find(
      (r) => r.name === crew.name && r.direction === "oncoming",
    );
    if (!planRow?.swap_location) continue;

    const swapIata = resolveToCommercialIata(planRow.swap_location);
    const homeAirports = homeAirportMap.get(crew.name) ?? [];

    // Option A: Find earlier commercial flight
    for (const home of homeAirports) {
      const homeIata = toIata(toIcao(home));
      const flights = await getCachedRoute(homeIata, swapIata, swapDate);
      if (flights.length === 0) continue;

      // Find flights earlier than current
      const currentFlight = planRow.flight_number;
      const earlierFlights = currentFlight
        ? flights.filter((f) => f.flight_number !== currentFlight)
        : flights;

      if (earlierFlights.length > 0) {
        const best = earlierFlights[0]; // earliest departure
        const cost = best.hasdata_price ?? best.estimated_price ?? 350;
        suggestions.push({
          type: "earlier_flight",
          description: `Rebook ${crew.name} on ${best.flight_number} (${homeIata}→${swapIata}, departs ${fmtTime(best.scheduled_departure)}) — arrives earlier`,
          estimated_cost_delta: cost,
          crew_affected_count: 1,
          auto_applicable: false,
          metadata: { flight_number: best.flight_number, crew_name: crew.name },
        });
        break; // one flight suggestion per crew is enough
      }
    }

    // Option B: Ground transport (if close enough)
    for (const home of homeAirports) {
      const drive = estimateDriveTime(toIcao(home), planRow.swap_location);
      if (!drive || drive.estimated_drive_minutes > 300) continue;

      const isUber = drive.estimated_drive_minutes <= UBER_MAX_MINUTES;
      const cost = isUber
        ? Math.max(25, Math.round(drive.estimated_drive_miles * 2.0))
        : 80 + Math.round(drive.estimated_drive_miles * 0.50);

      suggestions.push({
        type: "ground_transport",
        description: `${crew.name} could ${isUber ? "Uber" : "drive rental"} from ${home} (${Math.round(drive.estimated_drive_minutes)}min, ~$${cost})`,
        estimated_cost_delta: cost,
        crew_affected_count: 1,
        auto_applicable: false,
      });
      break;
    }
  }

  // Option C: If multiple crew late, suggest re-optimize
  if (lateOncoming.length >= 2) {
    suggestions.push({
      type: "reoptimize",
      description: `Multiple crew late for ${impact.tail_number} — consider re-optimizing this tail`,
      estimated_cost_delta: null,
      crew_affected_count: lateOncoming.length,
      auto_applicable: false,
    });
  }
}

// ─── Time-warning: tight buffer ─────────────────────────────────────────────

function suggestForTimeWarning(
  impact: PlanImpact,
  suggestions: Suggestion[],
): void {
  const tightCrew = impact.affected_crew.filter(
    (c) => c.detail.includes("Buffer only"),
  );

  if (tightCrew.length > 0) {
    suggestions.push({
      type: "backup_flight",
      description: `Buffer is tight for ${tightCrew.map((c) => c.name).join(", ")} — verify backup flight is available`,
      estimated_cost_delta: 0,
      crew_affected_count: tightCrew.length,
      auto_applicable: false,
    });
  }

  // If buffer > 15min, it's probably fine
  const hasOkBuffer = tightCrew.some((c) => {
    const match = c.detail.match(/Buffer only (\d+)min/);
    return match && parseInt(match[1]) >= 15;
  });
  if (hasOkBuffer) {
    suggestions.push({
      type: "no_action",
      description: "Buffer is reduced but likely still workable — monitor for further changes",
      estimated_cost_delta: 0,
      crew_affected_count: 0,
      auto_applicable: false,
    });
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function resolveToCommercialIata(icao: string): string {
  const upper = icao.toUpperCase();
  const alias = DEFAULT_AIRPORT_ALIASES.find(
    (a) => a.fbo_icao === upper && a.preferred,
  );
  if (alias) return toIata(alias.commercial_icao);
  return toIata(upper);
}

function fmtTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString("en-US", {
      timeZone: "America/Chicago",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}
