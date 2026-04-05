import { NextRequest, NextResponse } from "next/server";
import { verifyCronSecret } from "@/lib/api-auth";
import { syncTripFuelChoices } from "@/lib/jetinsight/trip-notes-sync";

export const maxDuration = 300;

/**
 * GET /api/cron/jetinsight-fuel-choices
 *
 * Scrape JetInsight trip notes to extract sales rep fuel choices.
 * Query params:
 *   - days: how many days back to look (default 7)
 *   - limit: max trips to scrape (for testing)
 */
export async function GET(req: NextRequest) {
  if (process.env.NODE_ENV === "production" && !verifyCronSecret(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const days = parseInt(req.nextUrl.searchParams.get("days") ?? "7", 10);
  const limit = req.nextUrl.searchParams.get("limit")
    ? parseInt(req.nextUrl.searchParams.get("limit")!, 10)
    : undefined;

  const result = await syncTripFuelChoices(days, limit);
  return NextResponse.json({ ok: !result.sessionExpired, ...result });
}
