import { NextRequest, NextResponse } from "next/server";
import { verifyCronSecret } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";
import { getAirportTimezone } from "@/lib/airportTimezones";
import { getRandomQuote } from "@/lib/quotes";
import { backfillSalesperson } from "@/lib/salespersonBackfill";

/**
 * POST /api/cron/trip-notifications/daily-summary
 *
 * Cron-authenticated version of the daily summary.
 *
 * Query params (set by cron dispatcher):
 *   summary_type=custom  — only send to people with custom_summary_hour matching target_hour
 *   target_hour=N        — the ET hour to match (used with summary_type=custom)
 *
 * Without params, sends the normal 6pm summary to ALL salespeople (tomorrow's legs).
 */
export async function POST(req: NextRequest) {
  if (!verifyCronSecret(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const slackToken = process.env.SLACK_BOT_TOKEN;
  if (!slackToken) {
    return NextResponse.json({ error: "SLACK_BOT_TOKEN not configured" }, { status: 503 });
  }

  const supa = createServiceClient();
  const params = new URL(req.url).searchParams;
  const summaryType = params.get("summary_type") ?? "default";
  const isCustom = summaryType === "custom";
  const targetHour = params.get("target_hour");

  // 1. Load all salesperson → Slack mappings
  const { data: allSlackMap } = await supa
    .from("salesperson_slack_map")
    .select("salesperson_name, slack_user_id, quotes_enabled, custom_summary_hour, custom_summary_day");

  if (!allSlackMap || allSlackMap.length === 0) {
    return NextResponse.json({ ok: true, sent: 0, message: "No salesperson Slack mappings configured" });
  }

  // For custom sends, filter to only people with matching custom_summary_hour
  let slackMap = allSlackMap;
  if (isCustom && targetHour !== null) {
    const hr = parseInt(targetHour, 10);
    slackMap = allSlackMap.filter((m) => m.custom_summary_hour === hr);
    if (slackMap.length === 0) {
      return NextResponse.json({ ok: true, sent: 0, message: `No salespersons with custom hour ${hr}` });
    }
  }

  // Build per-person day map (custom sends use their custom_summary_day)
  const dayByPerson = new Map<string, "today" | "tomorrow">();
  for (const m of slackMap) {
    const day = isCustom ? (m.custom_summary_day as "today" | "tomorrow") ?? "tomorrow" : "tomorrow";
    dayByPerson.set(m.salesperson_name.toLowerCase(), day);
  }

  // Determine which dates we need to query
  const estNow = new Date(
    new Date().toLocaleString("en-US", { timeZone: "America/New_York" })
  );
  const today = new Date(estNow);
  const tomorrow = new Date(estNow);
  tomorrow.setDate(tomorrow.getDate() + 1);

  const todayStr = today.toISOString().slice(0, 10);
  const tomorrowStr = tomorrow.toISOString().slice(0, 10);

  const needsToday = [...dayByPerson.values()].includes("today");
  const needsTomorrow = [...dayByPerson.values()].includes("tomorrow");

  const slackLookup = new Map<string, string>();
  const quotesLookup = new Map<string, boolean>();
  for (const m of slackMap) {
    slackLookup.set(m.salesperson_name.toLowerCase(), m.slack_user_id);
    quotesLookup.set(m.salesperson_name.toLowerCase(), m.quotes_enabled ?? false);
  }

  // 2. Query flights directly using the salesperson field (from JetInsight sync)
  const LIVE_TYPES = ["Revenue", "Owner", "Charter"];

  async function loadLegsForDate(dateStr: string) {
    const dayStart = new Date(`${dateStr}T00:00:00-05:00`);
    const dayEnd = new Date(`${dateStr}T23:59:59-05:00`);

    // Query all flights for the day
    const { data: allDayFlights } = await supa
      .from("flights")
      .select("tail_number, departure_icao, arrival_icao, scheduled_departure, flight_type, jetinsight_url, jetinsight_trip_id, salesperson, customer_name")
      .gte("scheduled_departure", dayStart.toISOString())
      .lte("scheduled_departure", dayEnd.toISOString())
      .not("tail_number", "is", null)
      .order("scheduled_departure", { ascending: true });

    // Backfill missing salesperson from trip_salespersons + same-trip propagation
    const flights = allDayFlights ?? [];
    await backfillSalesperson(supa, flights);

    // Last resort: for flights STILL missing salesperson, check if any other flight
    // with the same trip_id (on any date) has salesperson populated by the scraper.
    const stillMissing = flights.filter(
      (f) => f.jetinsight_trip_id && !f.salesperson && LIVE_TYPES.includes(f.flight_type),
    );
    if (stillMissing.length > 0) {
      const missingTripIds = [...new Set(stillMissing.map((f) => f.jetinsight_trip_id as string))];
      const { data: knownLegs } = await supa
        .from("flights")
        .select("jetinsight_trip_id, salesperson")
        .in("jetinsight_trip_id", missingTripIds)
        .not("salesperson", "is", null)
        .limit(500);

      if (knownLegs && knownLegs.length > 0) {
        const tripToSP = new Map<string, string>();
        for (const leg of knownLegs) {
          if (leg.jetinsight_trip_id && leg.salesperson) {
            tripToSP.set(leg.jetinsight_trip_id, leg.salesperson);
          }
        }
        for (const f of stillMissing) {
          const sp = tripToSP.get(f.jetinsight_trip_id!);
          if (sp) f.salesperson = sp;
        }
      }
    }

    // Filter to sold legs with salesperson
    const filtered = flights
      .filter((f) => f.salesperson && LIVE_TYPES.includes(f.flight_type))
      .map((f) => ({
        trip_id: f.jetinsight_trip_id ?? "",
        tail_number: f.tail_number,
        origin_icao: f.departure_icao,
        destination_icao: f.arrival_icao,
        scheduled_departure: f.scheduled_departure,
        salesperson_name: f.salesperson!,
        customer: f.customer_name ?? "",
        flight_type: f.flight_type,
        jetinsight_url: f.jetinsight_url,
      }));

    return { filtered, allDayFlights: flights };
  }

  const todayData = needsToday ? await loadLegsForDate(todayStr) : null;
  const tomorrowData = needsTomorrow ? await loadLegsForDate(tomorrowStr) : null;

  // 3. Group legs by salesperson per date
  function groupByPerson(legs: { salesperson_name: string }[]) {
    const map = new Map<string, typeof legs>();
    for (const leg of legs) {
      const key = leg.salesperson_name.toLowerCase();
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(leg);
    }
    // Sort each person's legs by departure
    for (const [, personLegs] of map) {
      personLegs.sort((a: any, b: any) =>
        (a.scheduled_departure ?? "").localeCompare(b.scheduled_departure ?? "")
      );
    }
    return map;
  }

  const todayByPerson = todayData ? groupByPerson(todayData.filtered) : new Map();
  const tomorrowByPerson = tomorrowData ? groupByPerson(tomorrowData.filtered) : new Map();

  // 4. Send DMs
  let sent = 0;
  let skipped = 0;
  const errors: string[] = [];
  const sentDetails: { salesperson: string; legCount: number }[] = [];

  for (const [spNameLower, slackUserId] of slackLookup) {
    const displayName =
      slackMap.find((m) => m.salesperson_name.toLowerCase() === spNameLower)
        ?.salesperson_name ?? spNameLower;

    const personDay = dayByPerson.get(spNameLower) ?? "tomorrow";
    const dateStr = personDay === "today" ? todayStr : tomorrowStr;
    const targetDate = personDay === "today" ? today : tomorrow;
    const dateLabel = formatDateLabel(targetDate);
    const greeting = personDay === "today" ? "Good Morning" : "Good Evening";
    const intro = personDay === "today" ? "Today" : "Tomorrow";
    const legsByPerson = personDay === "today" ? todayByPerson : tomorrowByPerson;
    const allDayFlights = personDay === "today" ? todayData?.allDayFlights ?? [] : tomorrowData?.allDayFlights ?? [];

    // Dedup: check if already sent for this date + type
    const { data: alreadySent } = await supa
      .from("salesperson_summary_sent")
      .select("id")
      .eq("salesperson_name", displayName)
      .eq("summary_date", dateStr)
      .eq("summary_type", summaryType)
      .limit(1);
    if (alreadySent && alreadySent.length > 0) {
      skipped++;
      continue;
    }

    const firstName = displayName.split(" ")[0];
    const personLegs = legsByPerson.get(spNameLower) as any[] | undefined;

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

        const priorLeg = findPriorLeg(allDayFlights, leg.tail_number, leg.origin_icao, leg.scheduled_departure);
        if (priorLeg) {
          const pDep = formatIcao(priorLeg.departure_icao);
          const pArr = formatIcao(priorLeg.arrival_icao);
          const pTime = formatDepTime(priorLeg.scheduled_departure, priorLeg.departure_icao);
          const pType = priorLeg.flight_type || "Positioning";
          legLines.push(`  Prior leg: ${pDep}-${pArr} dep ${pTime} (${pType})`);
        }

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
        body: JSON.stringify({ channel: slackUserId, text: message }),
      });
      const slackData = await slackRes.json();

      if (!slackData.ok) {
        errors.push(`Slack error for ${displayName}: ${slackData.error}`);
        continue;
      }

      // Log to summary table with summary_type for separate dedup
      await supa.from("salesperson_summary_sent").upsert({
        salesperson_name: displayName,
        summary_date: dateStr,
        leg_count: personLegs?.length ?? 0,
        summary_type: summaryType,
      }, { onConflict: "salesperson_name,summary_date,summary_type" });

      sentDetails.push({ salesperson: displayName, legCount: personLegs?.length ?? 0 });
      sent++;
    } catch (err) {
      errors.push(`Failed to DM ${displayName}: ${err instanceof Error ? err.message : "unknown"}`);
    }
  }

  return NextResponse.json({
    ok: true,
    date: needsToday && needsTomorrow ? `${todayStr} / ${tomorrowStr}` : (needsToday ? todayStr : tomorrowStr),
    summaryType,
    sent,
    skipped,
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
