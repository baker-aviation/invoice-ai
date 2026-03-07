import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthed } from "@/lib/api-auth";
import { getActiveFlights } from "@/lib/flightaware";
import { TRIPS } from "@/lib/maintenanceData";
import { createServiceClient } from "@/lib/supabase/service";
import { getCache, setCache, isCacheFresh } from "@/lib/flightCache";
import { refreshAlerts } from "@/lib/faAlerts";

export const dynamic = "force-dynamic";

// Fallback tail numbers
const FALLBACK_TAILS = [...new Set(TRIPS.map((t) => t.tail))];

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;

  // If FA key is missing, serve from shared Supabase cache (written by prod) — no API calls
  if (!process.env.FLIGHTAWARE_API_KEY) {
    const stale = await getCache();
    return NextResponse.json({
      flights: stale?.data ?? [],
      count: stale?.data.length ?? 0,
      cached: true,
      cached_at: stale ? new Date(stale.ts).toISOString() : null,
      cache_age_s: stale ? Math.round((Date.now() - stale.ts) / 1000) : null,
      cache_only: true,
    });
  }

  // Return cache if fresh (unless ?refresh=true)
  const forceRefresh = req.nextUrl.searchParams.get("refresh") === "true";
  if (!forceRefresh && await isCacheFresh()) {
    const cachedResult = await getCache();
    if (cachedResult) {
      return NextResponse.json({
        flights: cachedResult.data,
        count: cachedResult.data.length,
        cached: true,
        cached_at: new Date(cachedResult.ts).toISOString(),
        cache_age_s: Math.round((Date.now() - cachedResult.ts) / 1000),
      });
    }
  }

  // Get tail numbers from flights table
  const supa = createServiceClient();
  const now = new Date();
  const past = new Date(now.getTime() - 48 * 60 * 60 * 1000).toISOString();
  const future = new Date(now.getTime() + 48 * 60 * 60 * 1000).toISOString();

  const { data: dbFlights } = await supa
    .from("flights")
    .select("tail_number")
    .gte("scheduled_departure", past)
    .lte("scheduled_departure", future);

  const dbTails = [...new Set(
    (dbFlights ?? [])
      .map((f) => f.tail_number as string | null)
      .filter((t): t is string => !!t),
  )];

  const tails = dbTails.length > 0 ? dbTails : FALLBACK_TAILS;

  try {
    const flights = await getActiveFlights(tails);
    await setCache(flights);

    // Auto-register FA webhook alerts for any new tails (fire-and-forget)
    refreshAlerts(tails).catch(() => {});

    // Count flights per tail for debugging
    const perTail: Record<string, number> = {};
    for (const f of flights) {
      perTail[f.tail] = (perTail[f.tail] ?? 0) + 1;
    }

    return NextResponse.json({
      flights,
      count: flights.length,
      total_tails: tails.length,
      tails_queried: tails,
      flights_per_tail: perTail,
      cached: false,
      cached_at: new Date().toISOString(),
      cache_age_s: 0,
    });
  } catch (err) {
    const stale = await getCache();
    return NextResponse.json({
      flights: stale?.data ?? [],
      count: stale?.data.length ?? 0,
      error: "FlightAware query failed",
      cached: true,
    });
  }
}
