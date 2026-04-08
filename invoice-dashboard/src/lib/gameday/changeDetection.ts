/**
 * Game Day Operations — Schedule Change Detection
 *
 * Compares old vs new flight state during JetInsight schedule sync
 * and creates swap_leg_alerts for changes that affect active swap plans.
 *
 * Called from schedule-sync.ts after updates/inserts/cancellations are classified.
 */

import "server-only";
import { createServiceClient } from "@/lib/supabase/service";

// ─── Types ──────────────────────────────────────────────────────────────────

type ChangeType = "added" | "cancelled" | "time_change" | "airport_change";

type FlightSnapshot = {
  id: string;
  tail_number: string;
  departure_icao: string | null;
  arrival_icao: string | null;
  scheduled_departure: string;
  scheduled_arrival?: string | null;
};

export type ChangeAlert = {
  flight_id: string | null;
  tail_number: string;
  change_type: ChangeType;
  old_value: Record<string, unknown> | null;
  new_value: Record<string, unknown> | null;
  swap_date: string; // YYYY-MM-DD
};

export type ChangeDetectionResult = {
  alerts_created: number;
  alerts_skipped: number; // already existed (dedup)
  errors: string[];
};

// ─── Configuration ──────────────────────────────────────────────────────────

/** Minimum time change (minutes) to trigger an alert */
const TIME_CHANGE_THRESHOLD_MINUTES = 10;

// ─── Main function ──────────────────────────────────────────────────────────

/**
 * Detect schedule changes and write them to swap_leg_alerts.
 *
 * @param updates - Flights that existed before and have new data
 * @param inserts - Newly created flights (added legs)
 * @param cancelledFlights - Flights that disappeared from the feed
 * @param existingFlights - Snapshot of flights BEFORE the sync updated them
 */
export async function detectScheduleChanges(options: {
  updates: Array<{ id: string; data: Record<string, unknown> }>;
  inserts: Array<Record<string, unknown>>;
  cancelledFlights: FlightSnapshot[];
  existingFlights: FlightSnapshot[];
}): Promise<ChangeDetectionResult> {
  const { updates, inserts, cancelledFlights, existingFlights } = options;
  const result: ChangeDetectionResult = { alerts_created: 0, alerts_skipped: 0, errors: [] };
  const supa = createServiceClient();

  // Only create alerts for dates that have active swap plans
  const { data: activePlans } = await supa
    .from("swap_plans")
    .select("swap_date")
    .eq("status", "active");

  const activeDates = new Set(
    (activePlans ?? []).map((p) => p.swap_date as string),
  );

  if (activeDates.size === 0) return result;

  // Build index of existing flights for comparison
  const existingById = new Map<string, FlightSnapshot>();
  for (const f of existingFlights) {
    existingById.set(f.id, f);
  }

  const alerts: ChangeAlert[] = [];

  // ── 1. Detect time changes and airport changes in updates ────────────────

  for (const update of updates) {
    const old = existingById.get(update.id);
    if (!old) continue;

    const tail = (update.data.tail_number as string) ?? old.tail_number;
    const swapDate = getSwapDate(
      (update.data.scheduled_departure as string) ?? old.scheduled_departure,
    );
    if (!activeDates.has(swapDate)) continue;

    // Check time change
    const newDep = update.data.scheduled_departure as string | undefined;
    if (newDep && old.scheduled_departure) {
      const diffMin = Math.abs(
        new Date(newDep).getTime() - new Date(old.scheduled_departure).getTime(),
      ) / 60_000;

      if (diffMin >= TIME_CHANGE_THRESHOLD_MINUTES) {
        alerts.push({
          flight_id: update.id,
          tail_number: tail,
          change_type: "time_change",
          old_value: {
            scheduled_departure: old.scheduled_departure,
            scheduled_arrival: old.scheduled_arrival ?? null,
            departure_icao: old.departure_icao,
            arrival_icao: old.arrival_icao,
          },
          new_value: {
            scheduled_departure: newDep,
            scheduled_arrival: (update.data.scheduled_arrival as string) ?? null,
            departure_icao: (update.data.departure_icao as string) ?? old.departure_icao,
            arrival_icao: (update.data.arrival_icao as string) ?? old.arrival_icao,
          },
          swap_date: swapDate,
        });
      }
    }

    // Check airport change
    const newDepIcao = update.data.departure_icao as string | undefined;
    const newArrIcao = update.data.arrival_icao as string | undefined;
    const depChanged = newDepIcao && old.departure_icao && newDepIcao !== old.departure_icao;
    const arrChanged = newArrIcao && old.arrival_icao && newArrIcao !== old.arrival_icao;

    if (depChanged || arrChanged) {
      alerts.push({
        flight_id: update.id,
        tail_number: tail,
        change_type: "airport_change",
        old_value: {
          departure_icao: old.departure_icao,
          arrival_icao: old.arrival_icao,
        },
        new_value: {
          departure_icao: newDepIcao ?? old.departure_icao,
          arrival_icao: newArrIcao ?? old.arrival_icao,
        },
        swap_date: swapDate,
      });
    }
  }

  // ── 2. Detect added legs ─────────────────────────────────────────────────

  for (const insert of inserts) {
    const dep = insert.scheduled_departure as string | undefined;
    if (!dep) continue;

    const tail = insert.tail_number as string;
    const swapDate = getSwapDate(dep);
    if (!activeDates.has(swapDate)) continue;

    alerts.push({
      flight_id: null, // new flight, ID not yet available
      tail_number: tail,
      change_type: "added",
      old_value: null,
      new_value: {
        scheduled_departure: dep,
        scheduled_arrival: insert.scheduled_arrival as string ?? null,
        departure_icao: insert.departure_icao as string ?? null,
        arrival_icao: insert.arrival_icao as string ?? null,
      },
      swap_date: swapDate,
    });
  }

  // ── 3. Detect cancelled legs ─────────────────────────────────────────────

  for (const flight of cancelledFlights) {
    const swapDate = getSwapDate(flight.scheduled_departure);
    if (!activeDates.has(swapDate)) continue;

    alerts.push({
      flight_id: flight.id,
      tail_number: flight.tail_number,
      change_type: "cancelled",
      old_value: {
        scheduled_departure: flight.scheduled_departure,
        scheduled_arrival: flight.scheduled_arrival ?? null,
        departure_icao: flight.departure_icao,
        arrival_icao: flight.arrival_icao,
      },
      new_value: null,
      swap_date: swapDate,
    });
  }

  if (alerts.length === 0) return result;

  // ── 4. Deduplicate: skip alerts that already exist (same flight + type) ──

  const { data: existingAlerts } = await supa
    .from("swap_leg_alerts")
    .select("flight_id, change_type, tail_number, swap_date")
    .eq("acknowledged", false);

  const existingAlertKeys = new Set(
    (existingAlerts ?? []).map(
      (a) => `${a.flight_id ?? a.tail_number}|${a.change_type}|${a.swap_date}`,
    ),
  );

  const newAlerts = alerts.filter((a) => {
    const key = `${a.flight_id ?? a.tail_number}|${a.change_type}|${a.swap_date}`;
    return !existingAlertKeys.has(key);
  });

  result.alerts_skipped = alerts.length - newAlerts.length;

  // ── 5. Insert new alerts ─────────────────────────────────────────────────

  if (newAlerts.length > 0) {
    const { error } = await supa.from("swap_leg_alerts").insert(newAlerts);
    if (error) {
      result.errors.push(`Insert alerts: ${error.message}`);
    } else {
      result.alerts_created = newAlerts.length;
    }
  }

  return result;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Determine which swap date a flight belongs to.
 * Swaps happen on Wednesdays — a flight on Wed belongs to that week's swap.
 * For now, just return the date of the flight. The impact analysis matches
 * alerts to plans via swap_date overlap.
 */
function getSwapDate(isoDatetime: string): string {
  return isoDatetime.slice(0, 10);
}
