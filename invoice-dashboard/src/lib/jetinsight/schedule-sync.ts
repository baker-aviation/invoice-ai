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
  flightsCreated: number;
  flightsUpdated: number;
  mxNotesUpserted: number;
  errors: string[];
  sessionExpired: boolean;
}

/**
 * Fetch the JetInsight schedule JSON — PRIMARY source of flight data.
 * Creates new flights and updates existing ones with full data.
 * ICS sync (ops-monitor) serves as fallback when cookie is dead.
 */
export async function runScheduleSync(): Promise<ScheduleSyncResult> {
  const result: ScheduleSyncResult = {
    flightsCreated: 0,
    flightsUpdated: 0,
    mxNotesUpserted: 0,
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

  // Load existing flights for matching
  const { data: existingFlights } = await supa
    .from("flights")
    .select(
      "id, ics_uid, tail_number, departure_icao, arrival_icao, scheduled_departure, jetinsight_event_uuid",
    )
    .gte("scheduled_departure", start.toISOString())
    .lte("scheduled_departure", end.toISOString());

  const flights = existingFlights ?? [];

  // Process events
  for (const event of events) {
    if (event.eventType === "maintenance") {
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

    // Build the full flight data payload
    const flightData = {
      tail_number: event.tailNumber,
      departure_icao: event.departureIcao,
      arrival_icao: event.arrivalIcao,
      scheduled_departure: event.start,
      scheduled_arrival: event.end,
      summary: buildSummary(event),
      flight_type: event.flightType,
      pic: event.pic,
      sic: event.sic,
      pax_count: event.paxCount,
      jetinsight_url: event.tripId
        ? `${BASE_URL}/trips/${event.tripId}`
        : null,
      // Enrichment fields
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
    };

    // Try to match to existing flight
    const matched = findMatchingFlight(flights, event);

    if (matched) {
      // Update existing flight (preserve ics_uid and diverted flag)
      try {
        const { error } = await supa
          .from("flights")
          .update(flightData)
          .eq("id", matched.id);

        if (error) {
          result.errors.push(`Update ${matched.id}: ${error.message}`);
        } else {
          result.flightsUpdated++;
        }
      } catch (err) {
        result.errors.push(
          `Update ${matched.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    } else {
      // Create new flight — JSON is the primary source
      try {
        const { error } = await supa.from("flights").insert({
          ...flightData,
          ics_uid: `ji:${event.uuid}`, // Synthetic ics_uid so ICS sync can match later
        });

        if (error) {
          // Might be a duplicate — ignore unique constraint violations
          if (!error.message.includes("duplicate") && !error.message.includes("unique")) {
            result.errors.push(`Insert ${event.tailNumber} ${event.departureIcao}-${event.arrivalIcao}: ${error.message}`);
          }
        } else {
          result.flightsCreated++;
          // Add to local array so subsequent events can match against it
          flights.push({
            id: "", // unknown but we won't need to update it again this cycle
            ics_uid: `ji:${event.uuid}`,
            tail_number: event.tailNumber,
            departure_icao: event.departureIcao,
            arrival_icao: event.arrivalIcao,
            scheduled_departure: event.start,
            jetinsight_event_uuid: event.uuid,
          });
        }
      } catch (err) {
        result.errors.push(
          `Insert ${event.tailNumber}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  // Log sync run
  await supa.from("jetinsight_sync_runs").insert({
    sync_type: "schedule",
    status: result.errors.length > 0 ? "partial" : "ok",
    crew_synced: 0,
    aircraft_synced: 0,
    docs_downloaded: result.flightsCreated + result.flightsUpdated,
    docs_skipped: 0,
    errors: result.errors.map((e) => ({ entity: "schedule", message: e })),
    duration_ms: 0,
    completed_at: new Date().toISOString(),
  });

  return result;
}

/**
 * Build a summary string matching the ICS format for consistency.
 * e.g., "[N883TR] V2 Jets (TQPF - KTEB) - Revenue"
 */
function buildSummary(event: ScheduleEvent): string {
  const customer = event.customerName ? ` ${event.customerName}` : "";
  return `[${event.tailNumber}]${customer} (${event.departureIcao} - ${event.arrivalIcao}) - ${event.flightType}`;
}

/**
 * Find a matching flight in the DB for a JSON schedule event.
 * Priority: jetinsight_event_uuid > ics_uid > route + time signature.
 */
function findMatchingFlight(
  flights: Array<{
    id: string;
    ics_uid?: string;
    tail_number: string;
    departure_icao: string;
    arrival_icao: string;
    scheduled_departure: string;
    jetinsight_event_uuid: string | null;
  }>,
  event: ScheduleEvent,
): { id: string } | null {
  // 1. Exact event UUID match
  const uuidMatch = flights.find(
    (f) => f.jetinsight_event_uuid === event.uuid,
  );
  if (uuidMatch) return uuidMatch;

  // 2. Synthetic ics_uid match (from previous JSON sync)
  const syntheticMatch = flights.find(
    (f) => f.ics_uid === `ji:${event.uuid}`,
  );
  if (syntheticMatch) return syntheticMatch;

  // 3. Route + time signature match (catches ICS-created flights)
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
      text: ":warning: *JetInsight session expired*\n\nThe schedule sync cookie has expired. Tap below to update it:\n\n:point_right: <https://www.whitelabel-ops.com/jetinsight|Update Cookie on Whiteboard>\n\nSchedule enrichment and doc sync are paused until refreshed.",
    });
  } catch {
    console.error("[jetinsight] Failed to send Slack session expiry DM");
  }
}
