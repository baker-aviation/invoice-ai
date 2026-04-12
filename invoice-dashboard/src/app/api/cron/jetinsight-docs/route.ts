import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { verifyCronSecret } from "@/lib/api-auth";
import { postSlackMessage } from "@/lib/slack";
import { shouldAlertJetInsightExpiry } from "@/lib/jetinsight/alert-throttle";
import {
  syncCrewIndex,
  syncCrewDocs,
  syncAircraftDocs,
  syncCompanyDocs,
} from "@/lib/jetinsight/scraper";
import { syncTripDocs } from "@/lib/jetinsight/trip-sync";
import { syncPostFlightData } from "@/lib/jetinsight/postflight-sync";

export const maxDuration = 300;

const CHARLIE_SLACK_ID = "D0AK75CPPJM";
const BATCH_SIZE = 3;

/**
 * GET /api/cron/jetinsight-docs — Daily doc refresh (crew, aircraft, trips)
 * Runs at 4am UTC. Skips unchanged docs (dedup by UUID + upload date).
 * Only downloads new or updated documents.
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

  let totalDownloaded = 0;
  let totalSkipped = 0;
  const errors: string[] = [];

  try {
    // Step 0: Pull post-flight data (last 1 month for daily refresh)
    const pfResult = await syncPostFlightData(1);
    totalDownloaded += pfResult.inserted;
    totalSkipped += pfResult.skipped;
    errors.push(...pfResult.errors);

    // Step 1: Refresh crew index (discover new crew)
    await syncCrewIndex(cookie);

    // Step 2: Sync crew docs (reads from crew_list config)
    const { data: crewListRow } = await supa
      .from("jetinsight_config")
      .select("config_value")
      .eq("config_key", "crew_list")
      .single();

    if (crewListRow?.config_value) {
      const allCrew: Array<{ name: string; uuid: string }> = JSON.parse(
        crewListRow.config_value,
      );

      // Look up pilot profile mappings
      const { data: profiles } = await supa
        .from("pilot_profiles")
        .select("id, jetinsight_uuid")
        .not("jetinsight_uuid", "is", null);
      const profileByUuid = new Map(
        (profiles ?? []).map((p) => [p.jetinsight_uuid, String(p.id)]),
      );

      // Process all crew (will be fast for unchanged docs — dedup skips instantly)
      for (let i = 0; i < allCrew.length; i += BATCH_SIZE) {
        const batch = allCrew.slice(i, i + BATCH_SIZE);
        for (const c of batch) {
          const entityId = profileByUuid.get(c.uuid) ?? c.uuid;
          const r = await syncCrewDocs(entityId, c.uuid, cookie);
          totalDownloaded += r.docsDownloaded;
          totalSkipped += r.docsSkipped;
          errors.push(...r.errors);
        }
      }
    }

    // Step 3: Sync aircraft docs
    const { data: sources } = await supa
      .from("ics_sources")
      .select("label")
      .eq("enabled", true);

    const tails = (sources ?? [])
      .map((s) => s.label)
      .filter((l): l is string => !!l && l.startsWith("N"));

    for (const tail of tails) {
      const r = await syncAircraftDocs(tail, cookie);
      totalDownloaded += r.docsDownloaded;
      totalSkipped += r.docsSkipped;
      errors.push(...r.errors);
    }

    // Step 4: Sync trip docs (intl only)
    const { data: intlFlights } = await supa
      .from("flights")
      .select("jetinsight_trip_id")
      .eq("international_leg", true)
      .not("jetinsight_trip_id", "is", null);

    const tripIds = [
      ...new Set(
        (intlFlights ?? [])
          .map((f) => f.jetinsight_trip_id as string)
          .filter(Boolean),
      ),
    ];

    for (const tripId of tripIds) {
      const r = await syncTripDocs(tripId, cookie);
      totalDownloaded += r.docsDownloaded;
      totalSkipped += r.docsSkipped;
      errors.push(...r.errors);
    }

    // Step 5: Sync company docs
    const companyResult = await syncCompanyDocs(cookie);
    totalDownloaded += companyResult.docsDownloaded;
    totalSkipped += companyResult.docsSkipped;
    errors.push(...companyResult.errors);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === "SESSION_EXPIRED" && (await shouldAlertJetInsightExpiry())) {
      await postSlackMessage({
        channel: CHARLIE_SLACK_ID,
        text: ":warning: *JetInsight session expired*\n\nThe daily doc sync cookie has expired. Tap below to update it:\n\n:point_right: <https://www.whitelabel-ops.com/jetinsight|Update Cookie on Whiteboard>\n\nDoc sync is paused until refreshed.",
      });
    }
    errors.push(msg);
  }

  // Log sync run
  await supa.from("jetinsight_sync_runs").insert({
    sync_type: "daily_docs",
    status: errors.length > 0 ? "partial" : "ok",
    docs_downloaded: totalDownloaded,
    docs_skipped: totalSkipped,
    errors: errors.map((e) => ({ entity: "daily", message: e })),
    completed_at: new Date().toISOString(),
  });

  return NextResponse.json({
    ok: true,
    totalDownloaded,
    totalSkipped,
    errors: errors.length,
  });
}
