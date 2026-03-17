import { NextRequest, NextResponse } from "next/server";
import { buildFlightCache, getCacheStats } from "@/lib/commercialFlightCache";

export const dynamic = "force-dynamic";
export const maxDuration = 300; // 5 min — fetching ~60+ airports from FlightAware

/**
 * GET /api/cron/flight-cache
 *
 * Vercel Cron handler for pre-loading commercial flight schedules.
 * Two scheduled runs:
 *  - Monday 11pm ET → "0 4 * * 2" (4:00 UTC Tuesday = 11pm ET Monday) — seed
 *  - Tuesday 6am ET → "0 10 * * 2" (10:00 UTC Tuesday = 6am ET) — refresh
 *
 * Auth: CRON_SECRET bearer token (Vercel auto-injects).
 * Also supports manual triggering via query params:
 *   ?date=2026-03-18&mode=seed
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

  // Determine target date: explicit param or next Wednesday
  const dateParam = req.nextUrl.searchParams.get("date");
  const modeParam = req.nextUrl.searchParams.get("mode") as "seed" | "refresh" | null;

  const targetDate = dateParam ?? getNextWednesday();

  // Determine mode from time of day if not explicit
  // Before 6am ET = seed (Monday night run), after = refresh (Tuesday morning run)
  const etHour = parseInt(
    new Date().toLocaleString("en-US", { hour: "numeric", hour12: false, timeZone: "America/New_York" }),
  );
  const mode = modeParam ?? (etHour < 6 ? "seed" : "refresh");

  console.log(`[FlightCache Cron] Starting ${mode} for ${targetDate} (ET hour: ${etHour})`);

  try {
    const result = await buildFlightCache(targetDate, mode);

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
