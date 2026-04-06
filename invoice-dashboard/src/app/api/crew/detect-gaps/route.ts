import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, isAuthed } from "@/lib/api-auth";
import { detectNewAirports, detectMissingCachePairs } from "@/lib/hasdataCache";

export const dynamic = "force-dynamic";

/**
 * GET /api/crew/detect-gaps
 *
 * Scans for:
 *   1. New airports in upcoming flights with no FBO→commercial alias
 *   2. Missing city pairs in the flight cache for a swap date
 *
 * Query params:
 *   - swap_date: YYYY-MM-DD (required for cache gap detection)
 *   - look_ahead: days to scan ahead for new airports (default 14)
 */
export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (!isAuthed(auth)) return auth.error;

  const swapDate = req.nextUrl.searchParams.get("swap_date");
  const lookAhead = parseInt(req.nextUrl.searchParams.get("look_ahead") ?? "14");

  try {
    // Always check for new unaliased airports
    const airportGaps = await detectNewAirports({ lookAheadDays: lookAhead });

    // Check cache gaps if swap_date provided
    let cacheGaps = null;
    if (swapDate) {
      cacheGaps = await detectMissingCachePairs(swapDate);
    }

    return NextResponse.json({
      airports: airportGaps,
      cache: cacheGaps,
      has_issues: airportGaps.new_airports.length > 0 || (cacheGaps?.missing_pairs.length ?? 0) > 0,
      auto_aliased_count: airportGaps.auto_aliased.length,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Gap detection failed" },
      { status: 500 },
    );
  }
}
