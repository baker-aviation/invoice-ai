import "server-only";
import { createServiceClient } from "@/lib/supabase/service";
import { postSlackMessage } from "@/lib/slack";
import { parseScheduleJson, type ScheduleEvent } from "./schedule-parser";
import { isLoginRedirect } from "./parser";

const BASE_URL = "https://portal.jetinsight.com";
const CHARLIE_SLACK_ID = "D0AK75CPPJM";

// Match window: flights within ±2 hours of JSON event are considered the same
const MATCH_WINDOW_MS = 2 * 60 * 60 * 1000;

export interface ScheduleSyncResult {
  flightsEnriched: number;
  mxNotesUpserted: number;
  unmatched: number;
  errors: string[];
  sessionExpired: boolean;
}

/**
 * Fetch the JetInsight schedule JSON and enrich existing flights.
 * Returns sync result. Sends Slack DM if session expires.
 */
export async function runScheduleSync(): Promise<ScheduleSyncResult> {
  const result: ScheduleSyncResult = {
    flightsEnriched: 0,
    mxNotesUpserted: 0,
    unmatched: 0,
    errors: [],
    sessionExpired: false,
  };

  const supa = createServiceClient();

  // Get session cookie
  const { data: cookieRow } = await supa
    .from("jetinsight_config")
    .select("config_value")
    .eq("config_key", "session_cookie")
    .single();

  const cookie = cookieRow?.config_value;
  if (!cookie) {
    result.errors.push("No session cookie configured");
    return result;
  }

  // Fetch schedule JSON
  const now = new Date();
  const start = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const end = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
  const startStr = start.toISOString().split("T")[0];
  const endStr = end.toISOString().split("T")[0];

  let rawJson: unknown[];
  try {
    const res = await fetch(
      `${BASE_URL}/schedule/aircraft.json?start=${startStr}&end=${endStr}`,
      {
        method: "GET",
        headers: {
          Cookie: cookie,
          Accept: "application/json",
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Baker-Aviation-Sync/1.0",
        },
        signal: AbortSignal.timeout(30_000),
      },
    );

    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }

    const text = await res.text();

    // Check for session expiry (HTML login page instead of JSON)
    if (isLoginRedirect(text)) {
      result.sessionExpired = true;
      result.errors.push("Session expired");
      await notifySessionExpired();
      return result;
    }

    rawJson = JSON.parse(text);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("sign_in") || msg.includes("SESSION_EXPIRED")) {
      result.sessionExpired = true;
      await notifySessionExpired();
    }
    result.errors.push(`Fetch failed: ${msg}`);
    return result;
  }

  if (!Array.isArray(rawJson)) {
    result.errors.push("Unexpected response format (not an array)");
    return result;
  }

  // Parse events
  const events = parseScheduleJson(rawJson);

  // Load existing flights for matching (past 7 days + next 30 days)
  const { data: existingFlights } = await supa
    .from("flights")
    .select(
      "id, tail_number, departure_icao, arrival_icao, scheduled_departure, jetinsight_event_uuid",
    )
    .gte("scheduled_departure", start.toISOString())
    .lte("scheduled_departure", end.toISOString());

  const flights = existingFlights ?? [];

  // Process flight events
  for (const event of events) {
    if (event.eventType === "maintenance") {
      // Upsert MX note to ops_alerts
      try {
        await upsertMxNote(supa, event);
        result.mxNotesUpserted++;
      } catch (err) {
        result.errors.push(
          `MX note ${event.tailNumber}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      continue;
    }

    // Match to existing flight
    const matched = findMatchingFlight(flights, event);
    if (!matched) {
      result.unmatched++;
      continue;
    }

    // Enrich the flight
    try {
      const { error } = await supa
        .from("flights")
        .update({
          flight_number: event.flightNumber,
          customer_name: event.customerName,
          jetinsight_trip_id: event.tripId,
          origin_fbo: event.originFbo,
          destination_fbo: event.destinationFbo,
          international_leg: event.internationalLeg || null,
          trip_stage: event.tripStage,
          release_complete: event.releaseComplete,
          crew_complete: event.crewComplete,
          pax_complete: event.paxComplete,
          faa_part: event.faaPart,
          jetinsight_event_uuid: event.uuid,
        })
        .eq("id", matched.id);

      if (error) {
        result.errors.push(`Update flight ${matched.id}: ${error.message}`);
      } else {
        result.flightsEnriched++;
      }
    } catch (err) {
      result.errors.push(
        `Update flight ${matched.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Log sync run
  await supa.from("jetinsight_sync_runs").insert({
    sync_type: "schedule",
    status: result.errors.length > 0 ? "partial" : "ok",
    crew_synced: 0,
    aircraft_synced: 0,
    docs_downloaded: result.flightsEnriched,
    docs_skipped: result.unmatched,
    errors: result.errors.map((e) => ({ entity: "schedule", message: e })),
    duration_ms: 0,
    completed_at: new Date().toISOString(),
  });

  return result;
}

/**
 * Find a matching flight in the DB for a JSON schedule event.
 * Matches by tail + departure ICAO + arrival ICAO + time within ±2 hours.
 * Prefers exact jetinsight_event_uuid match if available.
 */
function findMatchingFlight(
  flights: Array<{
    id: string;
    tail_number: string;
    departure_icao: string;
    arrival_icao: string;
    scheduled_departure: string;
    jetinsight_event_uuid: string | null;
  }>,
  event: ScheduleEvent,
): { id: string } | null {
  // First try UUID match
  const uuidMatch = flights.find(
    (f) => f.jetinsight_event_uuid === event.uuid,
  );
  if (uuidMatch) return uuidMatch;

  // Then try route + time match
  const eventTime = new Date(event.start).getTime();

  return (
    flights.find((f) => {
      if (f.tail_number !== event.tailNumber) return false;
      if (f.departure_icao !== event.departureIcao) return false;
      if (f.arrival_icao !== event.arrivalIcao) return false;
      const flightTime = new Date(f.scheduled_departure).getTime();
      return Math.abs(flightTime - eventTime) < MATCH_WINDOW_MS;
    }) ?? null
  );
}

/**
 * Upsert a maintenance event as MX_NOTE in ops_alerts.
 */
async function upsertMxNote(
  supa: ReturnType<typeof createServiceClient>,
  event: ScheduleEvent,
): Promise<void> {
  const sourceId = `mx-json-${event.uuid}`;
  const subject = event.mxNotes
    ? `[${event.tailNumber}] ${event.mxNotes.slice(0, 200)}`
    : `[${event.tailNumber}] Maintenance`;

  await supa.from("ops_alerts").upsert(
    {
      alert_type: "MX_NOTE",
      severity: "info",
      airport_icao: event.departureIcao,
      tail_number: event.tailNumber,
      subject,
      body: event.mxNotes || event.customerName || "Maintenance",
      source_message_id: sourceId,
      raw_data: {
        start_time: event.start,
        end_time: event.end,
        jetinsight_event_uuid: event.uuid,
        created_by: event.createdBy,
        notes: event.mxNotes,
      },
    },
    { onConflict: "source_message_id" },
  );
}

/**
 * Send Slack DM to Charlie when JetInsight session expires.
 */
async function notifySessionExpired(): Promise<void> {
  try {
    await postSlackMessage({
      channel: CHARLIE_SLACK_ID,
      text: "JetInsight session expired. Paste a new cookie at /jetinsight to resume schedule sync.\nhttps://whiteboard.baker-aviation.com/jetinsight",
    });
  } catch {
    console.error("[jetinsight] Failed to send Slack session expiry DM");
  }
}
