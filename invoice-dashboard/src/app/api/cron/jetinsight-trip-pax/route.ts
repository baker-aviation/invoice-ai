import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { verifyCronSecret } from "@/lib/api-auth";
import { postSlackMessage } from "@/lib/slack";
import { syncTripDocs } from "@/lib/jetinsight/trip-sync";

export const maxDuration = 120;

const CHARLIE_SLACK_ID = "D0AK75CPPJM";

/**
 * GET /api/cron/jetinsight-trip-pax — Sync passenger names + eAPIS status
 * for upcoming international trips. Lightweight — only hits JI trip pages,
 * no heavy doc downloads. Runs every 6 hours.
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

  // Get JI trip IDs for upcoming international trips (next 14 days + past 2 days)
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
        const r = await syncTripDocs(tripId, cookie);
        tripsProcessed++;
        errors.push(...r.errors);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg === "SESSION_EXPIRED") throw err;
        errors.push(`${tripId}: ${msg}`);
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === "SESSION_EXPIRED") {
      await postSlackMessage({
        channel: CHARLIE_SLACK_ID,
        text: ":warning: *JetInsight session expired*\n\nTrip passenger sync cookie has expired. Update it:\n\n:point_right: <https://www.whitelabel-ops.com/jetinsight|Update Cookie>",
      });
    }
    errors.push(msg);
  }

  // Count total passengers synced
  const { count } = await supa
    .from("jetinsight_trip_passengers")
    .select("id", { count: "exact", head: true })
    .in("jetinsight_trip_id", tripIds);
  totalPax = count ?? 0;

  return NextResponse.json({
    ok: true,
    trips: tripsProcessed,
    tripIds: tripIds.length,
    passengers: totalPax,
    errors: errors.length,
    errorDetails: errors.slice(0, 10),
  });
}
