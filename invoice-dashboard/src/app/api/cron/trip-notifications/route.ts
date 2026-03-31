import { NextRequest, NextResponse } from "next/server";
import { verifyCronSecret } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";
import { POST as runDepartureCheck } from "./check/route";
import { POST as runDailySummary } from "./daily-summary/route";

/**
 * GET /api/cron/trip-notifications
 *
 * Called by Vercel Cron every 15 minutes.
 * - Always runs the departure check (flights departing within 75 min)
 * - Sends the daily summary to salespeople whose custom_summary_hour
 *   matches the current ET hour (default 18 = 6pm for people with no override)
 *
 * Calls sub-routes directly (no HTTP fetch) to avoid Vercel auth protection
 * blocking internal requests on preview/dev deployments.
 */
export async function GET(req: NextRequest) {
  if (!verifyCronSecret(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const results: Record<string, unknown> = {};

  // Forward the original auth header so sub-routes accept it
  const subReq = new NextRequest(req.url, {
    method: "POST",
    headers: { authorization: req.headers.get("authorization") ?? "" },
  });

  // Always run departure check
  try {
    const res = await runDepartureCheck(subReq);
    results.departure = await res.json();
  } catch (err) {
    results.departure = { error: err instanceof Error ? err.message : "unknown" };
  }

  // Current ET hour
  const etHour = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    hour12: false,
    timeZone: "America/New_York",
  }).formatToParts(new Date()).find((p) => p.type === "hour");
  const hour = parseInt(etHour?.value ?? "-1", 10);

  // Check if any salesperson is due for their summary this hour
  const supa = createServiceClient();
  const { data: duePeople } = await supa
    .from("salesperson_slack_map")
    .select("salesperson_name, custom_summary_hour")
    .or(`custom_summary_hour.eq.${hour},${hour === 18 ? "custom_summary_hour.is.null" : "custom_summary_hour.eq.-999"}`);

  if (duePeople && duePeople.length > 0) {
    try {
      const summaryUrl = new URL(req.url);
      summaryUrl.searchParams.set("target_hour", String(hour));
      const summaryReq = new NextRequest(summaryUrl, {
        method: "POST",
        headers: { authorization: req.headers.get("authorization") ?? "" },
      });
      const res = await runDailySummary(summaryReq);
      results.dailySummary = await res.json();
    } catch (err) {
      results.dailySummary = { error: err instanceof Error ? err.message : "unknown" };
    }
  }

  return NextResponse.json({ ok: true, hour, ...results });
}
