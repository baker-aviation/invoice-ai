import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, isRateLimited } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";
import { getAirportTimezone } from "@/lib/airportTimezones";
import { getRandomQuote } from "@/lib/quotes";

/**
 * POST /api/admin/trip-notifications/daily-summary
 *
 * Sends each salesperson a Slack DM with their sold legs for the next day.
 * If a salesperson has no legs, they get a "no sold legs" message.
 *
 * Intended to run daily at 6pm EST (via cron or manual trigger).
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

  // Determine target day: "today" or "tomorrow" (default: tomorrow)
  const dayParam = new URL(req.url).searchParams.get("day");
  const estNow = new Date(
    new Date().toLocaleString("en-US", { timeZone: "America/New_York" })
  );
  const targetDate = new Date(estNow);
  if (dayParam !== "today") {
    targetDate.setDate(targetDate.getDate() + 1);
  }
  const tomorrowStr = targetDate.toISOString().slice(0, 10); // YYYY-MM-DD
  const dateLabel = formatDateLabel(targetDate);
  const isToday = dayParam === "today";
  const greeting = isToday ? "Good Morning" : "Good Evening";
  const intro = isToday ? "Today" : "Tomorrow";

  // 1. Load all salesperson → Slack mappings (these are the people we DM)
  const { data: slackMap } = await supa
    .from("salesperson_slack_map")
    .select("salesperson_name, slack_user_id, quotes_enabled");

  if (!slackMap || slackMap.length === 0) {
    return NextResponse.json({ ok: true, sent: 0, message: "No salesperson Slack mappings configured" });
  }

  const slackLookup = new Map<string, string>();
  const quotesLookup = new Map<string, boolean>();
  for (const m of slackMap) {
    slackLookup.set(m.salesperson_name.toLowerCase(), m.slack_user_id);
    quotesLookup.set(m.salesperson_name.toLowerCase(), m.quotes_enabled ?? false);
  }

  // 2. Query trip_salespersons for tomorrow's legs
  //    scheduled_departure is stored as timestamptz, so filter by date in UTC
  //    Tomorrow EST = could span two UTC days, so use a wide window
  const tomorrowStart = new Date(`${tomorrowStr}T00:00:00-05:00`); // midnight EST
  const tomorrowEnd = new Date(`${tomorrowStr}T23:59:59-05:00`);   // end of day EST

  const LIVE_TYPES = ["Revenue", "Owner", "Charter"];

  // Join with flights to get flight_type and confirm the leg exists in the schedule
  const { data: legs, error: legsErr } = await supa
    .from("trip_salespersons")
    .select("trip_id, tail_number, origin_icao, destination_icao, scheduled_departure, salesperson_name, customer")
    .gte("scheduled_departure", tomorrowStart.toISOString())
    .lte("scheduled_departure", tomorrowEnd.toISOString());

  if (legsErr) {
    return NextResponse.json({ error: "Failed to query trip_salespersons", detail: legsErr.message }, { status: 500 });
  }

  // Filter to live legs only by checking against flights table
  const liveLegsByPerson = new Map<string, typeof filteredLegs>();
  type LegRow = NonNullable<typeof legs>[number];
  const filteredLegs: (LegRow & { flight_type?: string; jetinsight_url?: string | null })[] = [];

  for (const leg of legs ?? []) {
    // Check if there's a matching flight with a live type
    const { data: matchingFlights } = await supa
      .from("flights")
      .select("flight_type, jetinsight_url")
      .eq("tail_number", leg.tail_number)
      .eq("departure_icao", leg.origin_icao)
      .eq("arrival_icao", leg.destination_icao)
      .gte("scheduled_departure", new Date(new Date(leg.scheduled_departure).getTime() - 2 * 3600_000).toISOString())
      .lte("scheduled_departure", new Date(new Date(leg.scheduled_departure).getTime() + 2 * 3600_000).toISOString())
      .in("flight_type", LIVE_TYPES)
      .limit(1);

    if (matchingFlights && matchingFlights.length > 0) {
      filteredLegs.push({ ...leg, flight_type: matchingFlights[0].flight_type, jetinsight_url: matchingFlights[0].jetinsight_url });
    }
  }

  // Pre-fetch all flights for tomorrow to find prior legs
  const { data: allTomorrowFlights } = await supa
    .from("flights")
    .select("tail_number, departure_icao, arrival_icao, scheduled_departure, flight_type, jetinsight_url")
    .gte("scheduled_departure", tomorrowStart.toISOString())
    .lte("scheduled_departure", tomorrowEnd.toISOString())
    .not("tail_number", "is", null)
    .order("scheduled_departure", { ascending: true });

  // 3. Group legs by salesperson (lowercase for matching)
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
  const errors: string[] = [];
  const sentDetails: { salesperson: string; legCount: number }[] = [];

  for (const [spNameLower, slackUserId] of slackLookup) {
    // Find the display name (original casing)
    const displayName =
      slackMap.find((m) => m.salesperson_name.toLowerCase() === spNameLower)
        ?.salesperson_name ?? spNameLower;

    const firstName = displayName.split(" ")[0];
    const personLegs = liveLegsByPerson.get(spNameLower);

    let message: string;
    const wantsQuote = quotesLookup.get(spNameLower) === true;

    if (!personLegs || personLegs.length === 0) {
      message = `${greeting} ${firstName},\n\nFor ${dateLabel}, you have no sold legs.`;
    } else {
      const legLines: string[] = [];
      for (const leg of personLegs) {
        const dep = formatIcao(leg.origin_icao);
        const arr = formatIcao(leg.destination_icao);
        const time = formatDepTime(leg.scheduled_departure, leg.origin_icao);
        const broker = leg.customer || "Unknown";
        legLines.push(`• ${dep}-${arr} ${time} ${leg.tail_number} Broker - ${broker}`);

        // Prior leg alert
        const priorLeg = findPriorLeg(allTomorrowFlights ?? [], leg.tail_number, leg.origin_icao, leg.scheduled_departure);
        if (priorLeg) {
          const pDep = formatIcao(priorLeg.departure_icao);
          const pArr = formatIcao(priorLeg.arrival_icao);
          const pTime = formatDepTime(priorLeg.scheduled_departure, priorLeg.departure_icao);
          const pType = priorLeg.flight_type || "Positioning";
          legLines.push(`  Prior leg: ${pDep}-${pArr} dep ${pTime} (${pType})`);
        }

        // Always use the salesperson's trip_id for the URL (not the flight's jetinsight_url)
        if (leg.trip_id) {
          legLines.push(`  <https://portal.jetinsight.com/trips/${leg.trip_id}|Open in JetInsight>`);
        } else if (leg.jetinsight_url) {
          legLines.push(`  <${leg.jetinsight_url}|Open in JetInsight>`);
        }
      }

      message = [
        `${greeting} ${firstName},`,
        "",
        `${intro} you have sold the following legs:`,
        "",
        ...legLines,
      ].join("\n");
    }

    // Append motivational quote if enabled for this salesperson
    if (wantsQuote) {
      const quote = await getRandomQuote();
      if (quote) {
        message += `\n\n${quote}`;
      }
    }

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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Format departure time in the departure airport's local timezone: "1100EST" */
function formatDepTime(iso: string | null, originIcao: string | null): string {
  if (!iso) return "TBD";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "TBD";

  const tz = getAirportTimezone(originIcao) ?? "America/New_York";

  // Get hours and minutes in that timezone
  const parts = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: false,
    timeZone: tz,
  }).formatToParts(d);

  const hour = parts.find((p) => p.type === "hour")?.value ?? "00";
  const minute = parts.find((p) => p.type === "minute")?.value ?? "00";
  const timeNum = `${hour.padStart(2, "0")}${minute}`;

  // Get timezone abbreviation (e.g. "EST", "PST", "CDT")
  const tzAbbr = new Intl.DateTimeFormat("en-US", {
    timeZoneName: "short",
    timeZone: tz,
  }).formatToParts(d).find((p) => p.type === "timeZoneName")?.value ?? "ET";

  return `${timeNum}${tzAbbr}`;
}

/** Format date as "MAR 9th" */
function formatDateLabel(d: Date): string {
  const months = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
  const month = months[d.getMonth()];
  const day = d.getDate();
  const suffix = ordinalSuffix(day);
  return `${month} ${day}${suffix}`;
}

function ordinalSuffix(n: number): string {
  if (n >= 11 && n <= 13) return "th";
  switch (n % 10) {
    case 1: return "st";
    case 2: return "nd";
    case 3: return "rd";
    default: return "th";
  }
}

/** Strip leading K from ICAO for display: "KTEB" → "TEB" */
function formatIcao(icao: string | null): string {
  if (!icao) return "???";
  if (icao.length === 4 && icao.startsWith("K")) return icao.slice(1);
  return icao;
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
