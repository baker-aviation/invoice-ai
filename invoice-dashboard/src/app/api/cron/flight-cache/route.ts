import { NextRequest, NextResponse } from "next/server";
import { verifyCronSecret } from "@/lib/api-auth";
import { buildFlightCache } from "@/lib/commercialFlightCache";

export const dynamic = "force-dynamic";
export const maxDuration = 300; // 5 min

/**
 * GET /api/cron/flight-cache
 *
 * Pre-loads commercial flight schedules from FlightAware into Supabase.
 * Flights are upserted incrementally — if the request times out, whatever
 * was already saved is kept. Just call again with mode=refresh to fill gaps.
 *
 * Cron schedule:
 *  - Monday 11pm ET → seed (clear + full reload)
 *  - Tuesday 6am ET → refresh (upsert over existing)
 *
 * Manual: ?date=2026-03-18&mode=seed
 *   First call: mode=seed (clears old data, starts fresh)
 *   If 504: mode=refresh (fills in remaining airports, no delete)
 */
export async function GET(req: NextRequest) {
  if (!verifyCronSecret(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const dateParam = req.nextUrl.searchParams.get("date");
  const modeParam = req.nextUrl.searchParams.get("mode") as "seed" | "refresh" | null;
  const offsetParam = req.nextUrl.searchParams.get("offset");
  const limitParam = req.nextUrl.searchParams.get("limit");

  const targetDate = dateParam ?? getNextWednesday();
  const offset = offsetParam != null ? parseInt(offsetParam, 10) : 0;
  const limit = limitParam != null ? parseInt(limitParam, 10) : undefined;

  // Auto-detect mode from time of day if not explicit
  const etHour = parseInt(
    new Date().toLocaleString("en-US", { hour: "numeric", hour12: false, timeZone: "America/New_York" }),
  );
  const mode = modeParam ?? (etHour < 6 ? "seed" : "refresh");

  console.log(`[FlightCache Cron] Starting ${mode} for ${targetDate}`);

  try {
    const result = await buildFlightCache(targetDate, mode, offset, limit);

    return NextResponse.json({
      ok: true,
      target_date: targetDate,
      mode,
      ...result,
    });
  } catch (e) {
    console.error("[FlightCache Cron] Error:", e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Cache build failed" },
      { status: 500 },
    );
  }
}

function getNextWednesday(): string {
  const now = new Date();
  const day = now.getUTCDay();
  const daysUntilWed = (3 - day + 7) % 7 || 7;
  const wed = new Date(now.getTime() + daysUntilWed * 86400_000);
  return wed.toISOString().slice(0, 10);
}
