import { NextRequest, NextResponse } from "next/server";
import { verifyCronSecret } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";
import { postSlackMessage } from "@/lib/slack";
import { backfillSalesperson } from "@/lib/salespersonBackfill";

export const maxDuration = 30;

const CHARLIE_DM = "D0AK75CPPJM";

// Thresholds
const SCHEDULE_SYNC_STALE_MIN = 60; // Alert if no schedule sync in 60 min
const SALESPERSON_GAP_THRESHOLD = 5; // Alert if >5 tomorrow flights missing salesperson
const TRIP_ID_GAP_THRESHOLD = 3; // Alert if >3 tomorrow charter flights missing trip_id

/**
 * GET /api/cron/sync-health — Runs at 5pm ET daily (1 hour before daily summary).
 * Checks for stale syncs and missing data that would cause bad summaries.
 * Alerts Charlie via Slack DM if issues found.
 */
export async function GET(req: NextRequest) {
  if (!verifyCronSecret(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supa = createServiceClient();
  const issues: string[] = [];

  // 1. Check schedule sync freshness
  const { data: lastSync } = await supa
    .from("jetinsight_sync_runs")
    .select("completed_at, status, errors")
    .eq("sync_type", "schedule")
    .order("completed_at", { ascending: false })
    .limit(1)
    .single();

  if (!lastSync) {
    issues.push(":red_circle: *Schedule sync has never run* — no sync records found");
  } else {
    const ageMin = Math.round(
      (Date.now() - new Date(lastSync.completed_at).getTime()) / 60000,
    );
    if (ageMin > SCHEDULE_SYNC_STALE_MIN) {
      issues.push(
        `:red_circle: *Schedule sync is stale* — last ran ${ageMin} min ago (threshold: ${SCHEDULE_SYNC_STALE_MIN} min)`,
      );
    }
    if (lastSync.status !== "ok") {
      const errCount = Array.isArray(lastSync.errors)
        ? lastSync.errors.length
        : 0;
      issues.push(
        `:warning: Last schedule sync had status "${lastSync.status}" with ${errCount} error(s)`,
      );
    }
  }

  // 2. Check JetInsight session cookie validity
  const { data: cookieRow } = await supa
    .from("jetinsight_config")
    .select("config_value")
    .eq("config_key", "session_cookie")
    .single();

  if (!cookieRow?.config_value) {
    issues.push(":red_circle: *No JetInsight session cookie configured*");
  }

  // 3. Check tomorrow's flights for missing salesperson data
  const estNow = new Date(
    new Date().toLocaleString("en-US", { timeZone: "America/New_York" }),
  );
  const tomorrow = new Date(estNow);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowStr = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, "0")}-${String(tomorrow.getDate()).padStart(2, "0")}`;

  const dayStart = new Date(`${tomorrowStr}T00:00:00-04:00`);
  const dayEnd = new Date(`${tomorrowStr}T23:59:59-04:00`);
  const LIVE_TYPES = ["Revenue", "Owner", "Charter"];

  const { data: tomorrowFlights } = await supa
    .from("flights")
    .select(
      "tail_number, departure_icao, arrival_icao, flight_type, salesperson, customer_name, jetinsight_trip_id",
    )
    .gte("scheduled_departure", dayStart.toISOString())
    .lte("scheduled_departure", dayEnd.toISOString())
    .in("flight_type", LIVE_TYPES);

  const flights = tomorrowFlights ?? [];

  // Backfill from trip_salespersons so we only alert on genuinely missing data
  await backfillSalesperson(supa, flights);

  const missingTripId = flights.filter((f) => !f.jetinsight_trip_id);
  const missingSalesperson = flights.filter(
    (f) => f.jetinsight_trip_id && !f.salesperson,
  );
  const totalCharter = flights.length;

  if (missingTripId.length > TRIP_ID_GAP_THRESHOLD) {
    const tails = [
      ...new Set(missingTripId.map((f) => f.tail_number)),
    ].join(", ");
    issues.push(
      `:warning: *${missingTripId.length}/${totalCharter} charter flights tomorrow missing trip ID* — tails: ${tails}`,
    );
  }

  if (missingSalesperson.length > SALESPERSON_GAP_THRESHOLD) {
    const tails = [
      ...new Set(missingSalesperson.map((f) => f.tail_number)),
    ].join(", ");
    issues.push(
      `:warning: *${missingSalesperson.length}/${totalCharter} charter flights tomorrow missing salesperson* — tails: ${tails}`,
    );
  }

  // 4. Check salesperson_slack_map completeness
  const { data: slackMap } = await supa
    .from("salesperson_slack_map")
    .select("salesperson_name");
  const mappedNames = new Set(
    (slackMap ?? []).map((m) => m.salesperson_name.toLowerCase()),
  );

  const unmappedSellers = [
    ...new Set(
      flights
        .filter((f) => f.salesperson && !mappedNames.has(f.salesperson.toLowerCase()))
        .map((f) => f.salesperson!),
    ),
  ];
  if (unmappedSellers.length > 0) {
    issues.push(
      `:warning: *Salesperson(s) not in Slack map* — ${unmappedSellers.join(", ")} (they won't get summaries)`,
    );
  }

  // Send alert if issues found
  if (issues.length > 0) {
    const message = [
      ":rotating_light: *Sync Health Check — Issues Found*",
      `_${tomorrowStr} pre-summary check_`,
      "",
      ...issues,
      "",
      `_${totalCharter} charter/revenue/owner flights found for tomorrow_`,
    ].join("\n");

    await postSlackMessage({ channel: CHARLIE_DM, text: message });
  }

  return NextResponse.json({
    ok: true,
    date: tomorrowStr,
    totalFlights: totalCharter,
    issues,
    healthy: issues.length === 0,
  });
}
