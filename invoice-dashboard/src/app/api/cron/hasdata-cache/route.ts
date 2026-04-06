import { NextRequest, NextResponse } from "next/server";
import { verifyCronSecret } from "@/lib/api-auth";
import { buildHasdataCache } from "@/lib/hasdataCache";

export const dynamic = "force-dynamic";
export const maxDuration = 300; // 5 min

/**
 * GET /api/cron/hasdata-cache
 *
 * Seeds the HasData city-pair flight cache for the next Wednesday.
 * Queries ~3,000 origin-destination pairs via HasData (Google Flights scraper).
 *
 * Cron schedule: Tuesday 4am UTC (Monday 11pm ET)
 * Manual: ?date=2026-03-18&mode=seed|refresh|fill
 */
export async function GET(req: NextRequest) {
  if (!verifyCronSecret(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const dateParam = req.nextUrl.searchParams.get("date");
  const modeParam = req.nextUrl.searchParams.get("mode") as "seed" | "refresh" | "fill" | null;

  const targetDate = dateParam ?? getNextWednesday();

  // Auto-detect mode: Tuesday early morning = fresh seed. Otherwise fill gaps only.
  // "seed" clears + re-fetches all. "fill" only fetches missing pairs (crash recovery, top-off).
  const etHour = parseInt(
    new Date().toLocaleString("en-US", { hour: "numeric", hour12: false, timeZone: "America/New_York" }),
  );
  const mode = modeParam ?? (etHour < 6 ? "seed" : "fill");

  console.log(`[HasdataCache Cron] Starting ${mode} for ${targetDate}`);

  try {
    const result = await buildHasdataCache(targetDate, mode);

    return NextResponse.json({
      ok: true,
      target_date: targetDate,
      mode,
      ...result,
    });
  } catch (e) {
    console.error("[HasdataCache Cron] Error:", e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Cache build failed" },
      { status: 500 },
    );
  }
}

function getNextWednesday(): string {
  const now = new Date();
  const day = now.getUTCDay();
  // Include today if it's Wednesday (manual trigger on swap day itself).
  // The weekly cron fires on Tuesday, so this only matters for manual triggers.
  const daysUntilWed = day === 3 ? 0 : (3 - day + 7) % 7 || 7;
  const wed = new Date(now.getTime() + daysUntilWed * 86400_000);
  return wed.toISOString().slice(0, 10);
}
