/**
 * Suggestion engine for swap plan impacts.
 *
 * Given an impact (crew affected by a flight change), generates ranked
 * action suggestions ordered by least disruption first.
 *
 * Suggestion types (match UI color coding):
 *   no_action       — plan still works, no change needed
 *   earlier_flight  — rebook crew on earlier/later commercial flight
 *   ground_transport — switch to drive/Uber/rental
 *   reoptimize      — re-run optimizer for this tail (last resort)
 */

import { createServiceClient } from "@/lib/supabase/service";
import { estimateDriveTime } from "@/lib/driveTime";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ImpactSuggestion = {
  type: "no_action" | "earlier_flight" | "ground_transport" | "reoptimize";
  description: string;
  estimated_cost_delta: number | null;
  crew_affected_count: number;
  auto_applicable: boolean;
};

type CrewRow = {
  name: string;
  role: "PIC" | "SIC";
  direction: "oncoming" | "offgoing";
  tail_number: string;
  swap_location: string | null;
  travel_type: string;
  travel_from: string | null;
  travel_to: string | null;
  departure_time: string | null;
  arrival_time: string | null;
  available_time: string | null;
  flight_number: string | null;
  cost_estimate: number | null;
  duration_minutes: number | null;
  duty_on_time: string | null;
  alt_flights?: { flight_number: string; dep: string; arr: string; price: number }[];
  backup_flight?: { flight_number: string; dep: string; arr: string; price: number } | null;
};

type AlertInfo = {
  change_type: "added" | "cancelled" | "time_change" | "airport_change";
  old_value: Record<string, unknown> | null;
  new_value: Record<string, unknown> | null;
};

type AffectedCrew = {
  name: string;
  role: string;
  direction: string;
  detail: string;
};

export type SuggestionContext = {
  tail_number: string;
  severity: "critical" | "warning" | "info";
  affected_crew: AffectedCrew[];
  alert: AlertInfo;
  plan_rows: CrewRow[];
  swap_date: string;
};

const BUFFER_MINUTES = 30;

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function generateSuggestions(
  ctx: SuggestionContext,
): Promise<ImpactSuggestion[]> {
  const suggestions: ImpactSuggestion[] = [];
  const tailRows = ctx.plan_rows.filter((r) => r.tail_number === ctx.tail_number);
  const oncoming = tailRows.filter((r) => r.direction === "oncoming");

  switch (ctx.alert.change_type) {
    case "time_change":
      await suggestForTimeChange(ctx, tailRows, oncoming, suggestions);
      break;
    case "airport_change":
      await suggestForAirportChange(ctx, tailRows, oncoming, suggestions);
      break;
    case "cancelled":
      suggestForCancelled(ctx, tailRows, suggestions);
      break;
    case "added":
      suggestForAdded(ctx, tailRows, suggestions);
      break;
  }

  // Always offer reoptimize as last resort for critical/warning
  if (ctx.severity !== "info" && !suggestions.some((s) => s.type === "reoptimize")) {
    suggestions.push({
      type: "reoptimize",
      description: `Re-run optimizer for ${ctx.tail_number} with updated schedule`,
      estimated_cost_delta: null,
      crew_affected_count: tailRows.length,
      auto_applicable: false,
    });
  }

  return suggestions;
}

// ---------------------------------------------------------------------------
// Time change suggestions
// ---------------------------------------------------------------------------

async function suggestForTimeChange(
  ctx: SuggestionContext,
  tailRows: CrewRow[],
  oncoming: CrewRow[],
  suggestions: ImpactSuggestion[],
) {
  const newDep = (ctx.alert.new_value?.scheduled_departure as string) ?? null;
  if (!newDep) return;
  const newDepMs = new Date(newDep).getTime();

  // Check each affected oncoming crew member
  for (const crew of oncoming) {
    const affectedEntry = ctx.affected_crew.find((a) => a.name === crew.name);
    if (!affectedEntry) continue;

    const arrivalStr = crew.available_time ?? crew.arrival_time;
    if (!arrivalStr) continue;
    const arrivalMs = new Date(arrivalStr).getTime();
    const bufferMin = (newDepMs - arrivalMs) / 60_000;

    // If crew still makes it with buffer, it's fine
    if (bufferMin >= BUFFER_MINUTES) {
      suggestions.push({
        type: "no_action",
        description: `${crew.name} still arrives ${Math.round(bufferMin)}min before departure — plan holds`,
        estimated_cost_delta: null,
        crew_affected_count: 1,
        auto_applicable: false,
      });
      continue;
    }

    // Check if there's a backup flight in the plan
    if (crew.backup_flight) {
      const backupArr = new Date(crew.backup_flight.arr).getTime();
      const backupBuffer = (newDepMs - backupArr) / 60_000;
      if (backupBuffer >= BUFFER_MINUTES) {
        const costDelta = crew.backup_flight.price - (crew.cost_estimate ?? 0);
        suggestions.push({
          type: "earlier_flight",
          description: `Switch ${crew.name} to backup ${crew.backup_flight.flight_number} (arrives ${Math.round(backupBuffer)}min before)`,
          estimated_cost_delta: costDelta > 0 ? Math.round(costDelta) : null,
          crew_affected_count: 1,
          auto_applicable: true,
        });
        continue;
      }
    }

    // Check alt_flights from the plan
    if (crew.alt_flights?.length) {
      const viable = crew.alt_flights
        .filter((f) => {
          const fArr = new Date(f.arr).getTime();
          return (newDepMs - fArr) / 60_000 >= BUFFER_MINUTES;
        })
        .sort((a, b) => new Date(b.arr).getTime() - new Date(a.arr).getTime()); // latest viable first (least schedule disruption)

      if (viable.length > 0) {
        const best = viable[0];
        const costDelta = best.price - (crew.cost_estimate ?? 0);
        const arrBuf = Math.round((newDepMs - new Date(best.arr).getTime()) / 60_000);
        suggestions.push({
          type: "earlier_flight",
          description: `Rebook ${crew.name} on ${best.flight_number} (arrives ${arrBuf}min before, ${viable.length > 1 ? `${viable.length} options` : "only option"})`,
          estimated_cost_delta: costDelta > 0 ? Math.round(costDelta) : null,
          crew_affected_count: 1,
          auto_applicable: true,
        });
        continue;
      }
    }

    // Check cached flights from Supabase
    const cachedSuggestion = await checkCachedFlights(crew, newDepMs, ctx.swap_date);
    if (cachedSuggestion) {
      suggestions.push(cachedSuggestion);
      continue;
    }

    // Check ground transport as fallback
    if (crew.travel_from && crew.swap_location) {
      const driveSuggestion = await checkGroundTransport(crew, newDepMs);
      if (driveSuggestion) {
        suggestions.push(driveSuggestion);
        continue;
      }
    }

    // Nothing found — flag it
    suggestions.push({
      type: "reoptimize",
      description: `No alternative transport found for ${crew.name} — re-optimize needed`,
      estimated_cost_delta: null,
      crew_affected_count: 1,
      auto_applicable: false,
    });
  }

  // Check offgoing crew (time shift info only)
  const offgoing = tailRows.filter(
    (r) => r.direction === "offgoing" && ctx.affected_crew.some((a) => a.name === r.name),
  );
  if (offgoing.length > 0 && ctx.severity === "warning") {
    const oldDep = (ctx.alert.old_value?.scheduled_departure as string) ?? null;
    if (oldDep && newDep) {
      const shiftMin = Math.round((new Date(newDep).getTime() - new Date(oldDep).getTime()) / 60_000);
      if (Math.abs(shiftMin) < 60) {
        suggestions.push({
          type: "no_action",
          description: `Offgoing crew shift ${shiftMin > 0 ? "+" : ""}${shiftMin}min — within tolerance, return flights still work`,
          estimated_cost_delta: null,
          crew_affected_count: offgoing.length,
          auto_applicable: false,
        });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Airport change suggestions
// ---------------------------------------------------------------------------

async function suggestForAirportChange(
  ctx: SuggestionContext,
  tailRows: CrewRow[],
  oncoming: CrewRow[],
  suggestions: ImpactSuggestion[],
) {
  const oldAirport = (ctx.alert.old_value?.departure_icao as string) ??
    (ctx.alert.old_value?.arrival_icao as string) ?? null;
  const newAirport = (ctx.alert.new_value?.departure_icao as string) ??
    (ctx.alert.new_value?.arrival_icao as string) ?? null;

  if (!oldAirport || !newAirport) return;

  // Check if airports are close enough to drive between
  const drive = await estimateDriveTime(oldAirport, newAirport);
  if (drive?.feasible && drive.estimated_drive_minutes <= 60) {
    suggestions.push({
      type: "no_action",
      description: `${oldAirport} → ${newAirport} is only ${drive.estimated_drive_minutes}min drive — crew can redirect`,
      estimated_cost_delta: null,
      crew_affected_count: ctx.affected_crew.length,
      auto_applicable: false,
    });
    return;
  }

  // For each affected crew, check if ground transport to new airport works
  for (const crew of oncoming) {
    if (!ctx.affected_crew.some((a) => a.name === crew.name)) continue;

    if (crew.travel_from) {
      const driveToNew = await estimateDriveTime(crew.travel_from, newAirport);
      if (driveToNew?.feasible) {
        suggestions.push({
          type: "ground_transport",
          description: `Drive ${crew.name} to ${newAirport} instead (${driveToNew.estimated_drive_minutes}min, ${driveToNew.estimated_drive_miles}mi)`,
          estimated_cost_delta: estimateGroundCost(driveToNew.estimated_drive_miles),
          crew_affected_count: 1,
          auto_applicable: false,
        });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Cancelled leg suggestions
// ---------------------------------------------------------------------------

function suggestForCancelled(
  ctx: SuggestionContext,
  tailRows: CrewRow[],
  suggestions: ImpactSuggestion[],
) {
  // Cancelled leg is always critical — swap points likely need recompute
  // But if the cancelled leg wasn't the swap point basis, it may be fine
  suggestions.push({
    type: "reoptimize",
    description: `Leg cancelled on ${ctx.tail_number} — swap points need recompute with updated schedule`,
    estimated_cost_delta: null,
    crew_affected_count: tailRows.length,
    auto_applicable: false,
  });
}

// ---------------------------------------------------------------------------
// Added leg suggestions
// ---------------------------------------------------------------------------

function suggestForAdded(
  ctx: SuggestionContext,
  tailRows: CrewRow[],
  suggestions: ImpactSuggestion[],
) {
  // New leg may create a better swap point or invalidate the current one
  if (ctx.severity === "info") {
    suggestions.push({
      type: "no_action",
      description: `New leg on ${ctx.tail_number} — current swap plan likely still valid, review recommended`,
      estimated_cost_delta: null,
      crew_affected_count: 0,
      auto_applicable: false,
    });
  } else {
    suggestions.push({
      type: "reoptimize",
      description: `New leg on ${ctx.tail_number} may affect swap timing — recompute recommended`,
      estimated_cost_delta: null,
      crew_affected_count: tailRows.length,
      auto_applicable: false,
    });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function checkCachedFlights(
  crew: CrewRow,
  newDepMs: number,
  swapDate: string,
): Promise<ImpactSuggestion | null> {
  if (!crew.travel_from || !crew.swap_location) return null;

  try {
    const supa = createServiceClient();
    const { data: flights } = await supa
      .from("commercial_flight_cache")
      .select("flight_number, scheduled_departure, scheduled_arrival, estimated_price, is_direct")
      .eq("cache_date", swapDate)
      .eq("origin_icao", crew.travel_from)
      .eq("destination_icao", crew.swap_location)
      .order("scheduled_departure", { ascending: true });

    if (!flights?.length) return null;

    // Find flights that arrive with enough buffer before the new departure
    // Add 30min ground transport from commercial airport to FBO
    const FBO_TRANSFER_MIN = 30;
    const viable = flights.filter((f) => {
      const arrMs = new Date(f.scheduled_arrival).getTime();
      const readyMs = arrMs + FBO_TRANSFER_MIN * 60_000;
      return (newDepMs - readyMs) / 60_000 >= BUFFER_MINUTES;
    });

    if (viable.length === 0) return null;

    // Pick the latest viable (least disruption to crew schedule)
    const best = viable[viable.length - 1];
    const arrBuf = Math.round(
      (newDepMs - new Date(best.scheduled_arrival).getTime() - FBO_TRANSFER_MIN * 60_000) / 60_000,
    );
    const costDelta = best.estimated_price
      ? Math.round(best.estimated_price - (crew.cost_estimate ?? 0))
      : null;

    return {
      type: "earlier_flight",
      description: `Rebook ${crew.name} on ${best.flight_number}${best.is_direct ? "" : " (connecting)"} — arrives ${arrBuf}min before (${viable.length} option${viable.length > 1 ? "s" : ""} available)`,
      estimated_cost_delta: costDelta && costDelta > 0 ? costDelta : null,
      crew_affected_count: 1,
      auto_applicable: true,
    };
  } catch {
    return null;
  }
}

async function checkGroundTransport(
  crew: CrewRow,
  newDepMs: number,
): Promise<ImpactSuggestion | null> {
  if (!crew.travel_from || !crew.swap_location) return null;

  try {
    const drive = await estimateDriveTime(crew.travel_from, crew.swap_location);
    if (!drive?.feasible) return null;

    // Can crew drive and arrive with buffer?
    // Assume they can leave within 30 min of being notified
    const PREP_MIN = 30;
    const totalMin = PREP_MIN + drive.estimated_drive_minutes;
    const nowMs = Date.now();
    const arrivalMs = nowMs + totalMin * 60_000;

    if ((newDepMs - arrivalMs) / 60_000 >= BUFFER_MINUTES) {
      return {
        type: "ground_transport",
        description: `Drive ${crew.name} from ${crew.travel_from} → ${crew.swap_location} (${drive.estimated_drive_minutes}min, ${drive.estimated_drive_miles}mi)`,
        estimated_cost_delta: estimateGroundCost(drive.estimated_drive_miles),
        crew_affected_count: 1,
        auto_applicable: false,
      };
    }

    return null;
  } catch {
    return null;
  }
}

function estimateGroundCost(miles: number): number {
  // Rough Uber/rental estimate: $0.80/mi for shorter trips, less for longer
  if (miles <= 50) return Math.round(miles * 0.8);
  if (miles <= 150) return Math.round(40 + (miles - 50) * 0.6);
  return Math.round(100 + (miles - 150) * 0.5);
}
