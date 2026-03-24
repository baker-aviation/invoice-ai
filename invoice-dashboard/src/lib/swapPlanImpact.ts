/**
 * Analyzes how flight change alerts (swap_leg_alerts) impact a saved swap plan.
 *
 * Cross-references each alert's tail_number and change_type against the plan's
 * crew rows to determine who is affected and how severely.
 */

type CrewSwapRow = {
  name: string;
  role: "PIC" | "SIC";
  direction: "oncoming" | "offgoing";
  tail_number: string;
  swap_location: string | null;
  travel_type: string;
  departure_time: string | null;
  arrival_time: string | null;
  available_time: string | null;
};

type SwapAlert = {
  id: string;
  tail_number: string;
  change_type: "added" | "cancelled" | "time_change" | "airport_change";
  old_value: Record<string, unknown> | null;
  new_value: Record<string, unknown> | null;
};

type AffectedCrew = {
  name: string;
  role: "PIC" | "SIC";
  direction: "oncoming" | "offgoing";
  detail: string;
};

export type PlanImpact = {
  alert_id: string;
  tail_number: string;
  affected_crew: AffectedCrew[];
  severity: "critical" | "warning" | "info";
};

const BUFFER_MINUTES = 30;

export function analyzeAlertImpact(
  planRows: CrewSwapRow[],
  alert: SwapAlert,
): PlanImpact | null {
  const tailRows = planRows.filter((r) => r.tail_number === alert.tail_number);
  if (tailRows.length === 0) return null;

  const affected: AffectedCrew[] = [];
  let severity: "critical" | "warning" | "info" = "info";

  switch (alert.change_type) {
    case "time_change": {
      const newDep = (alert.new_value?.scheduled_departure as string) ?? null;
      const oldDep = (alert.old_value?.scheduled_departure as string) ?? null;
      if (!newDep) break;

      const newDepTime = new Date(newDep).getTime();

      for (const row of tailRows) {
        if (row.direction === "oncoming") {
          // Oncoming crew must arrive BEFORE the new departure
          const arrivalStr = row.available_time ?? row.arrival_time;
          if (!arrivalStr) continue;
          const arrivalTime = new Date(arrivalStr).getTime();
          const bufferMs = (newDepTime - arrivalTime) / 60_000;

          if (arrivalTime > newDepTime) {
            affected.push({
              name: row.name,
              role: row.role,
              direction: row.direction,
              detail: `Arrives after aircraft departs (${Math.abs(Math.round(bufferMs))}min late)`,
            });
            severity = "critical";
          } else if (bufferMs < BUFFER_MINUTES) {
            affected.push({
              name: row.name,
              role: row.role,
              direction: row.direction,
              detail: `Buffer only ${Math.round(bufferMs)}min (need ${BUFFER_MINUTES}min)`,
            });
            if (severity !== "critical") severity = "warning";
          }
        } else {
          // Offgoing: check if departure time moved earlier
          if (oldDep && newDep) {
            const oldTime = new Date(oldDep).getTime();
            const newTime = new Date(newDep).getTime();
            const shiftMin = Math.round((newTime - oldTime) / 60_000);
            if (Math.abs(shiftMin) >= 15) {
              affected.push({
                name: row.name,
                role: row.role,
                direction: row.direction,
                detail: `Leg time shifted ${shiftMin > 0 ? "+" : ""}${shiftMin}min`,
              });
              if (severity !== "critical") severity = "warning";
            }
          }
        }
      }
      break;
    }

    case "airport_change": {
      const oldAirport = (alert.old_value?.departure_icao as string) ??
                         (alert.old_value?.arrival_icao as string) ?? null;
      const newAirport = (alert.new_value?.departure_icao as string) ??
                         (alert.new_value?.arrival_icao as string) ?? null;

      for (const row of tailRows) {
        if (row.swap_location && oldAirport && row.swap_location === oldAirport) {
          affected.push({
            name: row.name,
            role: row.role,
            direction: row.direction,
            detail: `Traveling to ${oldAirport} but leg now at ${newAirport ?? "?"}`,
          });
          severity = "critical";
        }
      }
      break;
    }

    case "cancelled": {
      // A cancelled leg may have been the basis for a swap point
      for (const row of tailRows) {
        affected.push({
          name: row.name,
          role: row.role,
          direction: row.direction,
          detail: "Leg cancelled — swap point may have changed",
        });
      }
      if (tailRows.length > 0) severity = "critical";
      break;
    }

    case "added": {
      // New leg may change optimal swap points
      for (const row of tailRows) {
        affected.push({
          name: row.name,
          role: row.role,
          direction: row.direction,
          detail: "New leg added — swap points may need review",
        });
      }
      if (tailRows.length > 0 && severity === "info") severity = "warning";
      break;
    }
  }

  if (affected.length === 0) return null;

  return {
    alert_id: alert.id,
    tail_number: alert.tail_number,
    affected_crew: affected,
    severity,
  };
}
