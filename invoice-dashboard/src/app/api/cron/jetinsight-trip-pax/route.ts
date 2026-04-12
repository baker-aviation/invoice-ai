import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { verifyCronSecret } from "@/lib/api-auth";
import { postSlackMessage } from "@/lib/slack";
import { shouldAlertJetInsightExpiry } from "@/lib/jetinsight/alert-throttle";
import { scrapeEapisStatus } from "@/lib/jetinsight/trip-sync";
import * as cheerio from "cheerio";

export const maxDuration = 120;

const BASE_URL = "https://portal.jetinsight.com";
const DELAY_MS = 800;
const CHARLIE_SLACK_ID = "D0AK75CPPJM";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Extract passenger names from the JI trip passengers page.
 */
function extractPassengerNames(html: string): string[] {
  const names: string[] = [];

  // Strategy 1: customs_docs_data — passengers assigned to segments
  const customsMatch = html.match(/customs_docs_data\s*=\s*(\{[\s\S]*?\});/);
  if (customsMatch) {
    try {
      const customsData = JSON.parse(customsMatch[1]) as Record<string, Record<string, unknown>>;
      const paxIds = new Set<string>();
      for (const segment of Object.values(customsData)) {
        for (const paxId of Object.keys(segment)) paxIds.add(paxId);
      }
      if (paxIds.size > 0) {
        const paxMatch = html.match(/passenger_data\s*=\s*(\[[\s\S]*?\]);/);
        if (paxMatch) {
          const paxData = JSON.parse(paxMatch[1]) as Array<{ name: string; id: string }>;
          for (const p of paxData) {
            if (paxIds.has(p.id) && p.name?.trim()) names.push(p.name.trim());
          }
          if (names.length > 0) return [...new Set(names)];
        }
      }
    } catch { /* fall through */ }
  }

  // Strategy 2: passenger_data with is_allocated
  const jsonMatch = html.match(/passenger_data\s*=\s*(\[[\s\S]*?\]);/);
  if (jsonMatch) {
    try {
      const paxData = JSON.parse(jsonMatch[1]) as Array<{ name: string; is_allocated: boolean }>;
      const allocated = paxData.filter((p) => p.is_allocated);
      if (allocated.length > 0) {
        for (const p of allocated) {
          if (p.name?.trim()) names.push(p.name.trim());
        }
        return [...new Set(names)];
      }
      if (paxData.length <= 12) {
        for (const p of paxData) {
          if (p.name?.trim()) names.push(p.name.trim());
        }
        return [...new Set(names)];
      }
      return [];
    } catch { /* fall through */ }
  }

  // Fallback: HTML table
  const $ = cheerio.load(html);
  $("td").each((_i, el) => {
    const text = $(el).text().trim();
    if (text.length > 3 && text.length < 60 && text.includes(" ") &&
        !text.match(/\d{2}\/\d{2}/) && !text.match(/^\d/)) {
      names.push(text);
    }
  });
  return [...new Set(names)];
}

/**
 * Scrape just passengers + eAPIS for a single trip. No doc downloads.
 */
async function syncTripPax(
  tripId: string,
  cookie: string,
  supa: ReturnType<typeof createServiceClient>,
): Promise<{ paxCount: number; errors: string[] }> {
  const errors: string[] = [];
  let paxCount = 0;

  // Fetch passenger names
  await sleep(DELAY_MS);
  try {
    const paxRes = await fetch(`${BASE_URL}/trips/${tripId}/passengers`, {
      method: "GET",
      headers: {
        Cookie: cookie,
        "User-Agent": "Mozilla/5.0 Baker-Aviation-Sync/1.0",
      },
      signal: AbortSignal.timeout(15_000),
    });

    if (paxRes.ok) {
      const html = await paxRes.text();
      if (html.includes("Sign in") || html.includes("/users/sign_in")) {
        throw new Error("SESSION_EXPIRED");
      }
      const names = extractPassengerNames(html);
      paxCount = names.length;

      for (const name of names) {
        await supa.from("jetinsight_trip_passengers").upsert(
          {
            jetinsight_trip_id: tripId,
            passenger_name: name,
            synced_at: new Date().toISOString(),
          },
          { onConflict: "jetinsight_trip_id,passenger_name" },
        );
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === "SESSION_EXPIRED") throw err;
    errors.push(`pax: ${msg}`);
  }

  // Scrape eAPIS status
  await sleep(DELAY_MS);
  try {
    const eapisStatuses = await scrapeEapisStatus(tripId, cookie);
    if (eapisStatuses.length > 0) {
      await supa
        .from("intl_trips")
        .update({ eapis_status: eapisStatuses })
        .eq("jetinsight_trip_id", tripId);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === "SESSION_EXPIRED") throw err;
    errors.push(`eapis: ${msg}`);
  }

  return { paxCount, errors };
}

/**
 * GET /api/cron/jetinsight-trip-pax — Sync passenger names + eAPIS status
 * for upcoming international trips. Lightweight — no doc downloads.
 * Runs every 6 hours.
 */
export async function GET(req: NextRequest) {
  if (!verifyCronSecret(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supa = createServiceClient();

  // Get session cookie
  const { data: cookieRow } = await supa
    .from("jetinsight_config")
    .select("config_value")
    .eq("config_key", "session_cookie")
    .single();

  const cookie = cookieRow?.config_value;
  if (!cookie) {
    return NextResponse.json({ ok: false, error: "No session cookie" });
  }

  // Get JI trip IDs for upcoming international trips (past 2 days + next 14 days)
  const now = new Date();
  const lookback = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const lookahead = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const { data: trips } = await supa
    .from("intl_trips")
    .select("jetinsight_trip_id, tail_number, trip_date")
    .not("jetinsight_trip_id", "is", null)
    .gte("trip_date", lookback)
    .lte("trip_date", lookahead);

  const tripIds = [...new Set(
    (trips ?? []).map((t) => t.jetinsight_trip_id as string).filter(Boolean),
  )];

  if (tripIds.length === 0) {
    return NextResponse.json({ ok: true, trips: 0, passengers: 0 });
  }

  let totalPax = 0;
  let tripsProcessed = 0;
  const errors: string[] = [];

  try {
    for (const tripId of tripIds) {
      try {
        const { paxCount, errors: tripErrors } = await syncTripPax(tripId, cookie, supa);
        totalPax += paxCount;
        tripsProcessed++;
        errors.push(...tripErrors);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg === "SESSION_EXPIRED") throw err;
        errors.push(`${tripId}: ${msg}`);
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === "SESSION_EXPIRED" && (await shouldAlertJetInsightExpiry())) {
      await postSlackMessage({
        channel: CHARLIE_SLACK_ID,
        text: ":warning: *JetInsight session expired*\n\nTrip passenger sync cookie has expired. Update it:\n\n:point_right: <https://www.whitelabel-ops.com/jetinsight|Update Cookie>",
      });
    }
    errors.push(msg);
  }

  return NextResponse.json({
    ok: true,
    trips: tripsProcessed,
    totalTrips: tripIds.length,
    passengers: totalPax,
    errors: errors.length,
    errorDetails: errors.slice(0, 10),
  });
}
