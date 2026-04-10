import { NextRequest, NextResponse } from "next/server";
import { syncDeclines } from "@/lib/hamilton/scraper";
import { verifyCronSecret } from "@/lib/api-auth";

export const maxDuration = 120;

/**
 * POST /api/cron/hamilton-declines — Sync declined trips from Hamilton
 *
 * Runs on a cron schedule. Fetches declined trips with departures in the
 * last 30 days and upserts them to the local DB.
 */
export async function POST(req: NextRequest) {
  if (!verifyCronSecret(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Default: departures from 30 days ago
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
    .toISOString()
    .split("T")[0];

  const dateFrom =
    new URL(req.url).searchParams.get("dateFrom") ?? thirtyDaysAgo;

  try {
    const result = await syncDeclines(dateFrom);

    console.log(
      `[hamilton-declines] Synced ${result.tripsUpserted} trips, ` +
        `total ${result.totalDeclines}, ` +
        `${result.agentSummary.length} agents, ` +
        `${result.errors.length} errors` +
        (result.sessionExpired ? " (SESSION EXPIRED)" : ""),
    );

    return NextResponse.json(result);
  } catch (err: unknown) {
    console.error("[hamilton-declines] sync error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 },
    );
  }
}
