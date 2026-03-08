import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, isRateLimited } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";

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

  // 1. Find flights departing within the next 75 minutes
  const { data: flights, error: flightsErr } = await supa
    .from("flights")
    .select("id, tail_number, departure_icao, arrival_icao, scheduled_departure")
    .gte("scheduled_departure", now.toISOString())
    .lte("scheduled_departure", windowEnd.toISOString())
    .not("tail_number", "is", null);

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

  for (const flight of flights) {
    const depDate = flight.scheduled_departure.split("T")[0]; // YYYY-MM-DD

    // 3. Find matching trip_salespersons: same tail, date falls within trip range
    const { data: trips } = await supa
      .from("trip_salespersons")
      .select("trip_id, salesperson_name, origin_icao, destination_icao, customer")
      .eq("tail_number", flight.tail_number)
      .lte("trip_start", depDate)
      .gte("trip_end", depDate);

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
      const depTime = formatTimeLocal(flight.scheduled_departure);
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
    ...(errors.length > 0 ? { errors } : {}),
  });
}

/** Format ISO timestamp to readable local time: "5pm EST" or "5:30pm EST" */
function formatTimeLocal(iso: string): string {
  const d = new Date(iso);
  const h = parseInt(d.toLocaleString("en-US", { hour: "numeric", hour12: true, timeZone: "America/New_York" }));
  const m = d.toLocaleString("en-US", { minute: "2-digit", timeZone: "America/New_York" });
  const ampm = d.toLocaleString("en-US", { hour: "numeric", hour12: true, timeZone: "America/New_York" }).slice(-2).toLowerCase();
  const timeStr = m === "00" ? `${h}${ampm}` : `${h}:${m}${ampm}`;
  return `${timeStr} Aircraft Time`;
}

/** Strip leading K from ICAO for display: "KTEB" → "TEB" */
function formatIcao(icao: string | null): string {
  if (!icao) return "???";
  if (icao.length === 4 && icao.startsWith("K")) return icao.slice(1);
  return icao;
}
