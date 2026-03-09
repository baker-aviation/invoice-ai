import { NextRequest, NextResponse } from "next/server";

/**
 * GET /api/cron/trip-notifications
 *
 * Called by Vercel Cron every 15 minutes.
 * - Always runs the departure check (flights departing within 75 min)
 * - At 6pm EST (23:00 UTC in winter, 22:00 UTC in summer), also sends the daily summary
 *
 * Authenticated via CRON_SECRET header (Vercel injects this automatically).
 */
export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json({ error: "CRON_SECRET not configured" }, { status: 503 });
  }

  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const baseUrl = process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : "http://localhost:3000";

  const results: Record<string, unknown> = {};

  // Always run departure check
  try {
    const res = await fetch(`${baseUrl}/api/cron/trip-notifications/check`, {
      method: "POST",
      headers: { authorization: `Bearer ${cronSecret}` },
    });
    results.departure = await res.json();
  } catch (err) {
    results.departure = { error: err instanceof Error ? err.message : "unknown" };
  }

  // Run daily summary at 6pm EST
  // EST = UTC-5, EDT = UTC-4. Check if current hour in ET is 18 (6pm)
  const estHour = parseInt(
    new Date().toLocaleString("en-US", { hour: "numeric", hour12: false, timeZone: "America/New_York" })
  );
  if (estHour === 18) {
    try {
      const res = await fetch(`${baseUrl}/api/cron/trip-notifications/daily-summary`, {
        method: "POST",
        headers: { authorization: `Bearer ${cronSecret}` },
      });
      results.dailySummary = await res.json();
    } catch (err) {
      results.dailySummary = { error: err instanceof Error ? err.message : "unknown" };
    }
  }

  return NextResponse.json({ ok: true, ...results });
}
