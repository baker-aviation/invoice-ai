import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, isAuthed } from "@/lib/api-auth";
import { buildHasdataCache, getHasdataCacheStats } from "@/lib/hasdataCache";

export const dynamic = "force-dynamic";
export const maxDuration = 300; // 5 min — HasData seeding (~3000 city pairs at 50 concurrent)

/**
 * POST /api/crew/routes
 * Body: { swap_date: "2026-03-25", mode?: "seed" | "fill" | "refresh" }
 *
 * Seeds the HasData flight cache (Google Flights) for all crew × swap city pairs.
 * This is the sole flight data source for both the optimizer and flight picker.
 */
export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (!isAuthed(auth)) return auth.error;

  try {
    const body = await req.json();
    const swapDate = body.swap_date as string;
    const mode = (body.mode as "seed" | "fill" | "refresh") ?? "fill";

    if (!swapDate || !/^\d{4}-\d{2}-\d{2}$/.test(swapDate)) {
      return NextResponse.json({ error: "swap_date required (YYYY-MM-DD)" }, { status: 400 });
    }

    console.log(`[Routes API] Seeding HasData cache for ${swapDate} (mode: ${mode})`);
    const result = await buildHasdataCache(swapDate, mode);

    return NextResponse.json({
      ok: true,
      swap_date: swapDate,
      mode,
      pairs_queried: result.pairs_queried,
      offers_cached: result.offers_cached,
      duration_ms: result.duration_ms,
      errors: result.errors.length > 0 ? result.errors.slice(0, 20) : undefined,
    });
  } catch (e) {
    console.error("[Routes API] Error:", e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "HasData seeding failed" },
      { status: 500 },
    );
  }
}

/**
 * GET /api/crew/routes?date=2026-03-25
 *
 * Get HasData cache stats for a swap date.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (!isAuthed(auth)) return auth.error;

  const date = req.nextUrl.searchParams.get("date");
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return NextResponse.json({ error: "date query param required (YYYY-MM-DD)" }, { status: 400 });
  }

  const stats = await getHasdataCacheStats(date);
  if (!stats) {
    return NextResponse.json({
      swap_date: date,
      total_routes: 0,
      crew_count: 0,
      destination_count: 0,
      last_computed: null,
      is_stale: true,
    });
  }

  return NextResponse.json({
    swap_date: date,
    total_routes: stats.total_pairs,
    total_offers: stats.total_offers,
    pairs_with_flights: stats.pairs_with_flights,
    pairs_with_direct: stats.pairs_with_direct,
    min_price: stats.min_price_overall,
    last_computed: stats.last_fetched,
    is_stale: !stats.last_fetched || (Date.now() - new Date(stats.last_fetched).getTime()) > 12 * 60 * 60 * 1000,
  });
}
