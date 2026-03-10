import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { getAirportTimezone } from "@/lib/airportTimezones";

/**
 * POST /api/cron/trip-notifications/daily-summary
 *
 * Cron-authenticated version of the daily summary.
 * Same logic as /api/admin/trip-notifications/daily-summary but uses CRON_SECRET.
 */
export async function POST(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || req.headers.get("authorization") !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const slackToken = process.env.SLACK_BOT_TOKEN;
  if (!slackToken) {
    return NextResponse.json({ error: "SLACK_BOT_TOKEN not configured" }, { status: 503 });
  }

  const supa = createServiceClient();

  // "Tomorrow" in EST
  const estNow = new Date(
    new Date().toLocaleString("en-US", { timeZone: "America/New_York" })
  );
  const tomorrow = new Date(estNow);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowStr = tomorrow.toISOString().slice(0, 10);
  const dateLabel = formatDateLabel(tomorrow);

  // 1. Load all salesperson → Slack mappings
  const { data: slackMap } = await supa
    .from("salesperson_slack_map")
    .select("salesperson_name, slack_user_id");

  if (!slackMap || slackMap.length === 0) {
    return NextResponse.json({ ok: true, sent: 0, message: "No salesperson Slack mappings configured" });
  }

  const slackLookup = new Map<string, string>();
  for (const m of slackMap) {
    slackLookup.set(m.salesperson_name.toLowerCase(), m.slack_user_id);
  }

  // 2. Query trip_salespersons for tomorrow's legs
  const tomorrowStart = new Date(`${tomorrowStr}T00:00:00-05:00`);
  const tomorrowEnd = new Date(`${tomorrowStr}T23:59:59-05:00`);
  const LIVE_TYPES = ["Revenue", "Owner", "Charter"];

  const { data: legs, error: legsErr } = await supa
    .from("trip_salespersons")
    .select("trip_id, tail_number, origin_icao, destination_icao, scheduled_departure, salesperson_name, customer")
    .gte("scheduled_departure", tomorrowStart.toISOString())
    .lte("scheduled_departure", tomorrowEnd.toISOString());

  if (legsErr) {
    return NextResponse.json({ error: "Failed to query trip_salespersons", detail: legsErr.message }, { status: 500 });
  }

  // Filter to live legs only
  type LegRow = NonNullable<typeof legs>[number];
  const filteredLegs: (LegRow & { flight_type?: string })[] = [];
  const liveLegsByPerson = new Map<string, typeof filteredLegs>();

  for (const leg of legs ?? []) {
    const { data: matchingFlights } = await supa
      .from("flights")
      .select("flight_type")
      .eq("tail_number", leg.tail_number)
      .eq("departure_icao", leg.origin_icao)
      .eq("arrival_icao", leg.destination_icao)
      .gte("scheduled_departure", new Date(new Date(leg.scheduled_departure).getTime() - 2 * 3600_000).toISOString())
      .lte("scheduled_departure", new Date(new Date(leg.scheduled_departure).getTime() + 2 * 3600_000).toISOString())
      .in("flight_type", LIVE_TYPES)
      .limit(1);

    if (matchingFlights && matchingFlights.length > 0) {
      filteredLegs.push({ ...leg, flight_type: matchingFlights[0].flight_type });
    }
  }

  // 3. Group legs by salesperson
  for (const leg of filteredLegs) {
    const key = leg.salesperson_name.toLowerCase();
    if (!liveLegsByPerson.has(key)) liveLegsByPerson.set(key, []);
    liveLegsByPerson.get(key)!.push(leg);
  }

  // 4. Sort each person's legs by departure time
  for (const [, personLegs] of liveLegsByPerson) {
    personLegs.sort((a, b) =>
      (a.scheduled_departure ?? "").localeCompare(b.scheduled_departure ?? "")
    );
  }

  // 5. Send DMs
  let sent = 0;
  let skipped = 0;
  const errors: string[] = [];
  const sentDetails: { salesperson: string; legCount: number }[] = [];

  for (const [spNameLower, slackUserId] of slackLookup) {
    const displayName =
      slackMap.find((m) => m.salesperson_name.toLowerCase() === spNameLower)
        ?.salesperson_name ?? spNameLower;

    // Skip if already sent for this date
    const { data: alreadySent } = await supa
      .from("salesperson_summary_sent")
      .select("id")
      .eq("salesperson_name", displayName)
      .eq("summary_date", tomorrowStr)
      .limit(1);
    if (alreadySent && alreadySent.length > 0) {
      skipped++;
      continue;
    }

    const firstName = displayName.split(" ")[0];
    const personLegs = liveLegsByPerson.get(spNameLower);

    let message: string;

    if (!personLegs || personLegs.length === 0) {
      message = `Good Evening ${firstName},\n\nFor ${dateLabel}, you have no sold legs.`;
    } else {
      const legLines = personLegs.map((leg) => {
        const dep = formatIcao(leg.origin_icao);
        const arr = formatIcao(leg.destination_icao);
        const time = formatDepTime(leg.scheduled_departure, leg.origin_icao);
        const broker = leg.customer || "Unknown";
        return `• ${dep}-${arr} ${time} ${leg.tail_number} Broker - ${broker}`;
      });

      message = [
        `Good Evening ${firstName},`,
        "",
        `Tomorrow you have sold the following legs:`,
        ...legLines,
      ].join("\n");
    }

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
        errors.push(`Slack error for ${displayName}: ${slackData.error}`);
        continue;
      }

      // Log to summary table
      await supa.from("salesperson_summary_sent").upsert({
        salesperson_name: displayName,
        summary_date: tomorrowStr,
        leg_count: personLegs?.length ?? 0,
      }, { onConflict: "salesperson_name,summary_date" });

      sentDetails.push({ salesperson: displayName, legCount: personLegs?.length ?? 0 });
      sent++;
    } catch (err) {
      errors.push(`Failed to DM ${displayName}: ${err instanceof Error ? err.message : "unknown"}`);
    }
  }

  return NextResponse.json({
    ok: true,
    date: tomorrowStr,
    sent,
    total: slackMap.length,
    sentDetails,
    ...(errors.length > 0 ? { errors } : {}),
  });
}

function formatDepTime(iso: string | null, originIcao: string | null): string {
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

function formatDateLabel(d: Date): string {
  const months = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
  const day = d.getDate();
  const suffix = day >= 11 && day <= 13 ? "th" : ["th", "st", "nd", "rd"][day % 10] ?? "th";
  return `${months[d.getMonth()]} ${day}${suffix}`;
}

function formatIcao(icao: string | null): string {
  if (!icao) return "???";
  if (icao.length === 4 && icao.startsWith("K")) return icao.slice(1);
  return icao;
}
