import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, isRateLimited } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";
import { getAirportTimezone } from "@/lib/airportTimezones";
import { backfillSalesperson } from "@/lib/salespersonBackfill";

/**
 * POST /api/admin/trip-notifications/check
 *
 * Check for flights departing within ~1 hour and send Slack DMs to
 * the assigned salesperson. Deduplicates via salesperson_notifications_sent.
 *
 * Alert timing: fires ~1hr before the earliest leg in the chain.
 * If a positioning/repo leg feeds into the client leg on the same tail,
 * the alert fires 1hr before the repo departs (not the client leg).
 */
export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if ("error" in auth) return auth.error;
  if (await isRateLimited(auth.userId, 5)) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const slackToken = process.env.SLACK_BOT_TOKEN;
  if (!slackToken) {
    return NextResponse.json({ error: "SLACK_BOT_TOKEN not configured" }, { status: 503 });
  }

  const supa = createServiceClient();
  const now = new Date();
  const windowEnd = new Date(now.getTime() + 75 * 60 * 1000);

  // 1. Get all today's flights (all types) for prior-leg lookups
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);
  const todayEnd = new Date(now);
  todayEnd.setHours(23, 59, 59, 999);

  const LIVE_TYPES = ["Revenue", "Owner", "Charter"];

  const [{ data: allTodayFlights }, { data: liveTodayFlights, error: flightsErr }] = await Promise.all([
    supa
      .from("flights")
      .select("id, tail_number, departure_icao, arrival_icao, scheduled_departure, flight_type, jetinsight_url")
      .gte("scheduled_departure", todayStart.toISOString())
      .lte("scheduled_departure", todayEnd.toISOString())
      .not("tail_number", "is", null)
      .order("scheduled_departure", { ascending: true }),
    supa
      .from("flights")
      .select("id, tail_number, departure_icao, arrival_icao, scheduled_departure, flight_type, summary, jetinsight_url, salesperson, customer_name, jetinsight_trip_id")
      .gte("scheduled_departure", todayStart.toISOString())
      .lte("scheduled_departure", todayEnd.toISOString())
      .not("tail_number", "is", null)
      .in("flight_type", LIVE_TYPES),
  ]);

  if (flightsErr) {
    return NextResponse.json({ error: "Failed to query flights", detail: flightsErr.message }, { status: 500 });
  }

  if (!liveTodayFlights || liveTodayFlights.length === 0) {
    return NextResponse.json({ ok: true, checked: 0, sent: 0, skipped: 0, message: "No live flights today" });
  }

  // Backfill missing salesperson from trip_salespersons
  await backfillSalesperson(supa, liveTodayFlights);

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
  let checked = 0;
  const errors: string[] = [];
  const sentDetails: { salesperson: string; tail: string; route: string; time: string }[] = [];

  for (const flight of liveTodayFlights) {
    // 3. Find prior positioning/repo leg on same tail arriving at this leg's departure
    const priorLeg = findPriorLeg(allTodayFlights ?? [], flight.tail_number, flight.departure_icao, flight.scheduled_departure);

    // Alert trigger = repo departure if exists, else live leg departure
    const alertTriggerTime = priorLeg
      ? new Date(priorLeg.scheduled_departure)
      : new Date(flight.scheduled_departure);

    // Only process if the trigger time falls within the 75-min window
    if (alertTriggerTime < now || alertTriggerTime > windowEnd) continue;
    checked++;

    // 4. Get salesperson from flights table directly (populated by JetInsight scraper)
    const spName = flight.salesperson;
    if (!spName) continue;

    const tripId = flight.jetinsight_trip_id ?? null;

    // 5. Check dedup (keyed on live flight, so alert only fires once per leg)
    const dedupQ = supa
      .from("salesperson_notifications_sent")
      .select("id")
      .eq("flight_id", flight.id);
    if (tripId) dedupQ.eq("trip_id", tripId);
    const { data: existing } = await dedupQ.limit(1);

    if (existing && existing.length > 0) {
      skipped++;
      continue;
    }

    const slackUserId = slackLookup.get(spName.toLowerCase());
    if (!slackUserId) {
      skipped++;
      continue;
    }

    // 6. Format and send DM
    const depTime = formatTimeLocal(flight.scheduled_departure, flight.departure_icao);
    const depIcao = formatIcao(flight.departure_icao);
    const arrIcao = formatIcao(flight.arrival_icao);
    const broker = flight.customer_name || "Unknown";

    const lines = [
      `You have a trip departing ${priorLeg ? "soon" : "in ~1hr"} (${depTime}) on tail *${flight.tail_number}* going ${depIcao} - ${arrIcao}.`,
      `Broker is ${broker}.`,
    ];
    if (priorLeg) {
      const pDep = formatIcao(priorLeg.departure_icao);
      const pArr = formatIcao(priorLeg.arrival_icao);
      const pTime = formatDepTimeMilitary(priorLeg.scheduled_departure, priorLeg.departure_icao);
      const pType = priorLeg.flight_type || "Positioning";
      lines.push(`Prior leg: ${pDep}-${pArr} dep ${pTime} (${pType}) — must land first`);
    }
    lines.push(`Crew should be at the FBO now.`);
    lines.push(`Please check in and manage.`);
    if (tripId) {
      lines.push(`<https://portal.jetinsight.com/trips/${tripId}|Open in JetInsight>`);
    } else if (flight.jetinsight_url) {
      lines.push(`<${flight.jetinsight_url}|Open in JetInsight>`);
    }
    const message = lines.join("\n");

    try {
      const slackRes = await fetch("https://slack.com/api/chat.postMessage", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${slackToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ channel: slackUserId, text: message }),
      });
      const slackData = await slackRes.json();

      if (!slackData.ok) {
        errors.push(`Slack error for ${spName}: ${slackData.error}`);
        continue;
      }

      await supa.from("salesperson_notifications_sent").insert({
        flight_id: flight.id,
        trip_id: tripId,
        salesperson_name: spName,
      });

      sentDetails.push({
        salesperson: spName,
        tail: flight.tail_number,
        route: `${depIcao} → ${arrIcao}`,
        time: depTime,
      });
      sent++;
    } catch (err) {
      errors.push(`Failed to DM ${spName}: ${err instanceof Error ? err.message : "unknown"}`);
    }
  }

  return NextResponse.json({
    ok: true,
    checked,
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

function formatDepTimeMilitary(iso: string | null, originIcao: string | null): string {
  if (!iso) return "TBD";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "TBD";
  const tz = getAirportTimezone(originIcao) ?? "America/New_York";
  const parts = new Intl.DateTimeFormat("en-US", {
    hour: "numeric", minute: "2-digit", hour12: false, timeZone: tz,
  }).formatToParts(d);
  const hour = parts.find((p) => p.type === "hour")?.value ?? "00";
  const minute = parts.find((p) => p.type === "minute")?.value ?? "00";
  const timeNum = `${hour.padStart(2, "0")}${minute}`;
  const tzAbbr = new Intl.DateTimeFormat("en-US", {
    timeZoneName: "short", timeZone: tz,
  }).formatToParts(d).find((p) => p.type === "timeZoneName")?.value ?? "ET";
  return `${timeNum}${tzAbbr}`;
}

function findPriorLeg(
  allFlights: { tail_number: string; departure_icao: string; arrival_icao: string; scheduled_departure: string; flight_type: string | null; jetinsight_url: string | null }[],
  tailNumber: string,
  departureIcao: string,
  scheduledDeparture: string | null,
): typeof allFlights[number] | null {
  if (!scheduledDeparture) return null;
  const depTime = new Date(scheduledDeparture).getTime();
  const candidates = allFlights.filter(
    (f) =>
      f.tail_number === tailNumber &&
      f.arrival_icao === departureIcao &&
      new Date(f.scheduled_departure).getTime() < depTime,
  );
  if (candidates.length === 0) return null;
  return candidates[candidates.length - 1];
}
