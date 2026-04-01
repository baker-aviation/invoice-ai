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
 * - At 6pm ET, sends the normal daily summary to ALL salespeople (tomorrow's legs)
 * - At any hour, sends an EXTRA custom summary to salespeople whose
 *   custom_summary_hour matches (for their configured day: today or tomorrow)
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

  // At 6pm ET, send the normal daily summary to EVERYONE (tomorrow's legs)
  if (hour === 18) {
    try {
      const summaryReq = new NextRequest(req.url, {
        method: "POST",
        headers: { authorization: req.headers.get("authorization") ?? "" },
      });
      const res = await runDailySummary(summaryReq);
      results.dailySummary = await res.json();
    } catch (err) {
      results.dailySummary = { error: err instanceof Error ? err.message : "unknown" };
    }
  }

  // Check if any salesperson has a custom_summary_hour matching NOW
  const supa = createServiceClient();
  const { data: customPeople } = await supa
    .from("salesperson_slack_map")
    .select("salesperson_name, custom_summary_hour, custom_summary_day")
    .eq("custom_summary_hour", hour);

  if (customPeople && customPeople.length > 0) {
    try {
      const customUrl = new URL(req.url);
      customUrl.searchParams.set("summary_type", "custom");
      customUrl.searchParams.set("target_hour", String(hour));
      const customReq = new NextRequest(customUrl, {
        method: "POST",
        headers: { authorization: req.headers.get("authorization") ?? "" },
      });
      const res = await runDailySummary(customReq);
      results.customSummary = await res.json();
    } catch (err) {
      results.customSummary = { error: err instanceof Error ? err.message : "unknown" };
    }
  }

  return NextResponse.json({ ok: true, hour, ...results });
}
