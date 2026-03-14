import { NextRequest, NextResponse } from "next/server";
import { after } from "next/server";
import { requireAuth, isAuthed } from "@/lib/api-auth";
import { getActiveFlights } from "@/lib/flightaware";
import { TRIPS } from "@/lib/maintenanceData";
import { createServiceClient } from "@/lib/supabase/service";
import { getCache, setCache, isCacheFresh, isRefreshing, tryClaimRefresh, clearRefreshing } from "@/lib/flightCache";
import { refreshAlerts } from "@/lib/faAlerts";

export const dynamic = "force-dynamic";

// Fallback tail numbers
const FALLBACK_TAILS = [...new Set(TRIPS.map((t) => t.tail))];

/** Fetch tail numbers from DB + fallback list.
 *  Returns { allTails, activeTails } where activeTails are tails with flights
 *  in the ±48h window (used for FA alert registration to limit push costs). */
async function getTails(): Promise<{ allTails: string[]; activeTails: string[] }> {
  const supa = createServiceClient();
  const now = new Date();
  const past = new Date(now.getTime() - 48 * 60 * 60 * 1000).toISOString();
  const future = new Date(now.getTime() + 48 * 60 * 60 * 1000).toISOString();

  const { data: dbFlights } = await supa
    .from("flights")
    .select("tail_number")
    .gte("scheduled_departure", past)
    .lte("scheduled_departure", future);

  const activeTails = [...new Set(
    (dbFlights ?? [])
      .map((f) => f.tail_number as string | null)
      .filter((t): t is string => !!t),
  )];

  const allTails = [...new Set([...activeTails, ...FALLBACK_TAILS])];
  return { allTails, activeTails };
}

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
  const cacheFresh = await isCacheFresh();
  const cachedResult = await getCache();

  // Stale-while-revalidate: return stale cache immediately, refresh in background
  // Uses atomic Supabase lock so only one Vercel instance refreshes at a time
  const refreshing = await isRefreshing();
  if (!forceRefresh && cachedResult && !cacheFresh && !refreshing) {
    const claimed = await tryClaimRefresh();
    if (claimed) {
      // This instance won the lock — kick off background refresh
      after(async () => {
        try {
          const { allTails, activeTails } = await getTails();
          console.log("[SWR] Background refresh starting for", activeTails.length, "active tails (of", allTails.length, "total)");
          const flights = await getActiveFlights(activeTails);
          await setCache(flights);
          console.log("[SWR] Background refresh complete,", flights.length, "flights");
          await refreshAlerts(allTails, activeTails).catch(() => {});
        } catch (err) {
          console.error("[SWR] Background refresh failed:", err);
        } finally {
          await clearRefreshing();
        }
      });
    }

    return NextResponse.json({
      flights: cachedResult.data,
      count: cachedResult.data.length,
      cached: true,
      stale: true,
      cached_at: new Date(cachedResult.ts).toISOString(),
      cache_age_s: Math.round((Date.now() - cachedResult.ts) / 1000),
    });
  }

  // Fresh cache — return immediately
  if (!forceRefresh && cacheFresh && cachedResult) {
    // Ensure webhook alerts are registered even on cached responses
    after(async () => {
      try {
          const { allTails: at, activeTails: act } = await getTails();
          await refreshAlerts(at, act);
        } catch {}
    });
    return NextResponse.json({
      flights: cachedResult.data,
      count: cachedResult.data.length,
      cached: true,
      stale: false,
      cached_at: new Date(cachedResult.ts).toISOString(),
      cache_age_s: Math.round((Date.now() - cachedResult.ts) / 1000),
    });
  }

  // No cache at all (first load) or force refresh — block and fetch
  // Only query tails with flights in ±48h to reduce FA API costs
  const { allTails: tails, activeTails } = await getTails();

  try {
    const flights = await getActiveFlights(activeTails);
    await setCache(flights);
    await clearRefreshing(); // in case a background refresh was somehow flagged

    // Auto-register FA webhook alerts for active tails only — runs after response is sent
    after(async () => {
      try {
        console.log("[FA Alerts] after() starting refreshAlerts for", activeTails.length, "active tails (of", tails.length, "total)");
        await refreshAlerts(tails, activeTails);
        console.log("[FA Alerts] after() completed");
      } catch (err) {
        console.error("[FA Alerts] after() failed:", err);
      }
    });

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
      stale: false,
      cached_at: new Date().toISOString(),
      cache_age_s: 0,
    });
  } catch (err) {
    const stale = await getCache();
    return NextResponse.json({
      flights: stale?.data ?? [],
      count: stale?.data.length ?? 0,
      error: "FlightAware query failed",
      stale: true,
      cached: true,
    });
  }
}
