import "server-only";
import { createServiceClient } from "./supabase/service";

type FlightEvent = {
  id: string;
  event_code: string;
  registration: string | null;
  fa_flight_id: string | null;
  origin: string | null;
  destination: string | null;
  summary: string | null;
  description: string | null;
  raw_payload: Record<string, unknown>;
  created_at: string;
  processed: boolean;
};

type ProcessedAlert = {
  type: "arrival" | "departure" | "delay" | "diversion" | "cancellation" | "filed";
  tail: string;
  message: string;
  severity: "info" | "warning" | "critical";
  airport: string | null;
  event_id: string;
};

/**
 * Process unprocessed flight_events and return actionable alerts.
 * Marks events as processed after handling.
 */
export async function processFlightEvents(): Promise<ProcessedAlert[]> {
  const supa = createServiceClient();

  const { data: events, error } = await supa
    .from("flight_events")
    .select("*")
    .eq("processed", false)
    .order("created_at", { ascending: true })
    .limit(50);

  if (error || !events || events.length === 0) return [];

  const alerts: ProcessedAlert[] = [];
  const processedIds: string[] = [];

  for (const event of events as FlightEvent[]) {
    const tail = event.registration ?? "Unknown";

    switch (event.event_code) {
      case "arrival":
        alerts.push({
          type: "arrival",
          tail,
          message: `${tail} landed at ${event.destination ?? "?"}`,
          severity: "info",
          airport: event.destination,
          event_id: event.id,
        });
        break;

      case "departure":
        alerts.push({
          type: "departure",
          tail,
          message: `${tail} departed ${event.origin ?? "?"} → ${event.destination ?? "?"}`,
          severity: "info",
          airport: event.destination,
          event_id: event.id,
        });
        break;

      case "diverted":
        alerts.push({
          type: "diversion",
          tail,
          message: `${tail} DIVERTED — now heading to ${event.destination ?? "?"}`,
          severity: "critical",
          airport: event.destination,
          event_id: event.id,
        });
        break;

      case "cancelled":
        alerts.push({
          type: "cancellation",
          tail,
          message: `${tail} flight CANCELLED (${event.origin ?? "?"} → ${event.destination ?? "?"})`,
          severity: "warning",
          airport: null,
          event_id: event.id,
        });
        break;

      case "filed":
        alerts.push({
          type: "filed",
          tail,
          message: `${tail} filed ${event.origin ?? "?"} → ${event.destination ?? "?"}`,
          severity: "info",
          airport: event.destination,
          event_id: event.id,
        });
        break;
    }

    processedIds.push(event.id);
  }

  // Mark all as processed
  if (processedIds.length > 0) {
    await supa
      .from("flight_events")
      .update({ processed: true })
      .in("id", processedIds);
  }

  return alerts;
}

/**
 * Get recent flight events (last 24h), already processed.
 * For display in the van driver view.
 */
export async function getRecentEvents(tailNumbers?: string[]): Promise<FlightEvent[]> {
  const supa = createServiceClient();
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  let query = supa
    .from("flight_events")
    .select("*")
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(100);

  if (tailNumbers && tailNumbers.length > 0) {
    query = query.in("registration", tailNumbers);
  }

  const { data } = await query;
  return (data ?? []) as FlightEvent[];
}
