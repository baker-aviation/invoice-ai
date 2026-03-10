import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, isRateLimited } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";
import { getAirportTimezone } from "@/lib/airportTimezones";

/**
 * POST /api/admin/trip-notifications/check
 *
 * Check for flights departing within ~1 hour and send Slack DMs to
 * the assigned salesperson. Deduplicates via salesperson_notifications_sent.
 *
 * Logic:
 * 1. Query flights with scheduled_departure between now and now + 75 min
 * 2. Match to trip_salespersons on tail_number + date overlap
 * 3. Skip if already in salesperson_notifications_sent
 * 4. Look up Slack user ID from salesperson_slack_map
 * 5. Send DM via chat.postMessage
 * 6. Record in salesperson_notifications_sent
 */
export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if ("error" in auth) return auth.error;
  if (isRateLimited(auth.userId, 5)) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const slackToken = process.env.SLACK_BOT_TOKEN;
  if (!slackToken) {
    return NextResponse.json({ error: "SLACK_BOT_TOKEN not configured" }, { status: 503 });
  }

  const supa = createServiceClient();
  const now = new Date();
  const windowEnd = new Date(now.getTime() + 75 * 60 * 1000);

  // 1. Find live flights departing within the next 75 minutes (skip positioning/ferry/maintenance)
  const LIVE_TYPES = ["Revenue", "Owner", "Charter"];
  const { data: flights, error: flightsErr } = await supa
    .from("flights")
    .select("id, tail_number, departure_icao, arrival_icao, scheduled_departure, flight_type, summary")
    .gte("scheduled_departure", now.toISOString())
    .lte("scheduled_departure", windowEnd.toISOString())
    .not("tail_number", "is", null)
    .in("flight_type", LIVE_TYPES);

  if (flightsErr) {
    return NextResponse.json({ error: "Failed to query flights", detail: flightsErr.message }, { status: 500 });
  }

  if (!flights || flights.length === 0) {
    return NextResponse.json({ ok: true, checked: 0, sent: 0, skipped: 0, message: "No flights departing within window" });
  }

  // 2. Load all salesperson-slack mappings
  const { data: slackMap } = await supa
    .from("salesperson_slack_map")
    .select("salesperson_name, slack_user_id");

  const slackLookup = new Map<string, string>();
  for (const m of slackMap ?? []) {
    slackLookup.set(m.salesperson_name.toLowerCase(), m.slack_user_id);
  }

  let sent = 0;
  let skipped = 0;
  const errors: string[] = [];
  const sentDetails: { salesperson: string; tail: string; route: string; time: string }[] = [];

  for (const flight of flights) {
    // 3. Find matching trip_salespersons: exact leg match (tail + origin + dest)
    const { data: trips } = await supa
      .from("trip_salespersons")
      .select("trip_id, salesperson_name, origin_icao, destination_icao, customer")
      .eq("tail_number", flight.tail_number)
      .eq("origin_icao", flight.departure_icao)
      .eq("destination_icao", flight.arrival_icao);

    if (!trips || trips.length === 0) continue;

    for (const trip of trips) {
      // 4. Check dedup
      const { data: existing } = await supa
        .from("salesperson_notifications_sent")
        .select("id")
        .eq("flight_id", flight.id)
        .eq("trip_id", trip.trip_id)
        .limit(1);

      if (existing && existing.length > 0) {
        skipped++;
        continue;
      }

      // 5. Look up Slack user ID
      const slackUserId = slackLookup.get(trip.salesperson_name.toLowerCase());
      if (!slackUserId) {
        skipped++;
        continue;
      }

      // 6. Format and send DM
      const depTime = formatTimeLocal(flight.scheduled_departure, flight.departure_icao);
      const depIcao = formatIcao(flight.departure_icao);
      const arrIcao = formatIcao(flight.arrival_icao);
      const broker = trip.customer || "Unknown";

      const lines = [
        `You have a trip departing in ~1hr (${depTime}) on tail *${flight.tail_number}* going ${depIcao} - ${arrIcao}.`,
        `Broker is ${broker}.`,
        `Crew should be at the FBO now.`,
        `Please check in and manage.`,
      ];
      const message = lines.join("\n");

      try {
        const slackRes = await fetch("https://slack.com/api/chat.postMessage", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${slackToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            channel: slackUserId,
            text: message,
          }),
        });
        const slackData = await slackRes.json();

        if (!slackData.ok) {
          errors.push(`Slack error for ${trip.salesperson_name}: ${slackData.error}`);
          continue;
        }

        // 7. Record sent notification
        await supa.from("salesperson_notifications_sent").insert({
          flight_id: flight.id,
          trip_id: trip.trip_id,
          salesperson_name: trip.salesperson_name,
        });

        sentDetails.push({
          salesperson: trip.salesperson_name,
          tail: flight.tail_number,
          route: `${depIcao} → ${arrIcao}`,
          time: depTime,
        });
        sent++;
      } catch (err) {
        errors.push(`Failed to DM ${trip.salesperson_name}: ${err instanceof Error ? err.message : "unknown"}`);
      }
    }
  }

  return NextResponse.json({
    ok: true,
    checked: flights.length,
    sent,
    skipped,
    sentDetails,
    ...(errors.length > 0 ? { errors } : {}),
  });
}

/** Format ISO timestamp in the departure airport's local timezone: "5pm CST" */
function formatTimeLocal(iso: string, airportIcao: string | null): string {
  const d = new Date(iso);
  const tz = getAirportTimezone(airportIcao) ?? "America/New_York";

  const parts = new Intl.DateTimeFormat("en-US", {
    hour: "numeric", minute: "2-digit", hour12: true, timeZone: tz,
  }).formatToParts(d);

  const hour = parts.find((p) => p.type === "hour")?.value ?? "12";
  const minute = parts.find((p) => p.type === "minute")?.value ?? "00";
  const dayPeriod = parts.find((p) => p.type === "dayPeriod")?.value?.toLowerCase() ?? "am";
  const timeStr = minute === "00" ? `${hour}${dayPeriod}` : `${hour}:${minute}${dayPeriod}`;

  const tzAbbr = new Intl.DateTimeFormat("en-US", {
    timeZoneName: "short", timeZone: tz,
  }).formatToParts(d).find((p) => p.type === "timeZoneName")?.value ?? "ET";

  return `${timeStr} ${tzAbbr}`;
}

/** Strip leading K from ICAO for display: "KTEB" → "TEB" */
function formatIcao(icao: string | null): string {
  if (!icao) return "???";
  if (icao.length === 4 && icao.startsWith("K")) return icao.slice(1);
  return icao;
}
