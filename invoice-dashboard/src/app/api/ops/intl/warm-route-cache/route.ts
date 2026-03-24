import { NextRequest, NextResponse } from "next/server";
import { verifyCronSecret } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";
import { getAirportInfo } from "@/lib/airportCoords";
import { detectOverflightsFromIcao } from "@/lib/overflightDetector";
import { isInternationalIcao } from "@/lib/intlUtils";

export const dynamic = "force-dynamic";
export const maxDuration = 300; // 5 min max for Vercel Pro

const FF_BASE = "https://public-api.foreflight.com/public/api";

/** Aircraft config — registration → default cruise profile */
const AIRCRAFT: Record<string, { mach: string; altitude: number }> = {
  N106PC: { mach: ".85", altitude: 430 },
  N520FX: { mach: ".78", altitude: 410 },
};

// Default tail to use for ForeFlight route queries
const DEFAULT_TAIL = "N520FX";

/**
 * POST /api/ops/intl/warm-route-cache
 *
 * Batch-processes uncached international route pairs through ForeFlight.
 * Designed to run overnight via Cloud Scheduler.
 *
 * - Finds all unique international route pairs from upcoming flights
 * - Skips pairs already in intl_route_cache
 * - Processes each pair with a 8-second delay to respect ForeFlight rate limits
 * - Query param: ?max=20 (default 20, max routes per invocation)
 * - Auth: requires CRON_SECRET header or service role
 */
export async function GET(req: NextRequest) {
  if (!verifyCronSecret(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const ffKey = process.env.FOREFLIGHT_API_KEY;
  if (!ffKey) {
    return NextResponse.json({ error: "FOREFLIGHT_API_KEY not set" }, { status: 500 });
  }

  const maxRoutes = Math.min(
    Number(req.nextUrl.searchParams.get("max") ?? 20),
    50
  );

  const supa = createServiceClient();

  // 1. Get all unique international route pairs from flights (next 30 days)
  const now = new Date();
  const future = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();
  const past = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();

  const { data: flights } = await supa
    .from("flights")
    .select("departure_icao, arrival_icao, tail_number")
    .gte("scheduled_departure", past)
    .lte("scheduled_departure", future);

  if (!flights || flights.length === 0) {
    return NextResponse.json({ ok: true, message: "No flights found", processed: 0 });
  }

  // Deduplicate route pairs, only international
  const routeMap = new Map<string, { dep: string; arr: string; tail: string }>();
  for (const f of flights) {
    if (!f.departure_icao || !f.arrival_icao) continue;
    if (!isInternationalIcao(f.departure_icao) && !isInternationalIcao(f.arrival_icao)) continue;
    const key = `${f.departure_icao}|${f.arrival_icao}`;
    if (!routeMap.has(key)) {
      routeMap.set(key, {
        dep: f.departure_icao,
        arr: f.arrival_icao,
        tail: f.tail_number && AIRCRAFT[f.tail_number] ? f.tail_number : DEFAULT_TAIL,
      });
    }
  }

  // 2. Check which pairs are already cached
  const { data: cached } = await supa
    .from("intl_route_cache")
    .select("dep_icao, arr_icao");

  const cachedSet = new Set(
    (cached ?? []).map((r) => `${r.dep_icao}|${r.arr_icao}`)
  );

  const uncached = [...routeMap.values()].filter(
    (r) => !cachedSet.has(`${r.dep}|${r.arr}`)
  );

  if (uncached.length === 0) {
    return NextResponse.json({ ok: true, message: "All routes cached", processed: 0, total: routeMap.size });
  }

  // 3. Process uncached routes with throttling
  const toProcess = uncached.slice(0, maxRoutes);
  const results: { dep: string; arr: string; method: string; error?: string }[] = [];

  // Pre-fetch aircraft list once
  let cruiseUUIDs: Record<string, string> = {};
  try {
    const acRes = await fetch(`${FF_BASE}/aircraft`, {
      headers: { "x-api-key": ffKey },
    });
    if (acRes.ok) {
      const acData = await acRes.json();
      const acList = Array.isArray(acData) ? acData : acData?.aircraft ?? [];
      for (const ac of acList) {
        const reg = (ac.aircraftRegistration as string)?.toUpperCase();
        if (reg && ac.cruiseProfiles?.[0]?.uuid) {
          cruiseUUIDs[reg] = ac.cruiseProfiles[0].uuid;
        }
      }
    }
  } catch {
    // Continue without cruise profiles
  }

  for (let i = 0; i < toProcess.length; i++) {
    const route = toProcess[i];

    // Throttle: 8 seconds between requests (well within 10/min limit)
    if (i > 0) {
      await new Promise((resolve) => setTimeout(resolve, 8000));
    }

    const depInfo = getAirportInfo(route.dep) ?? getAirportInfo(route.dep.replace(/^K/, ""));
    const arrInfo = getAirportInfo(route.arr) ?? getAirportInfo(route.arr.replace(/^K/, ""));

    if (!depInfo || !arrInfo) {
      results.push({ dep: route.dep, arr: route.arr, method: "skipped", error: "Unknown airport" });
      continue;
    }

    // Great-circle baseline
    const gcOverflights = detectOverflightsFromIcao(
      route.dep, depInfo.lat, depInfo.lon,
      route.arr, arrInfo.lat, arrInfo.lon
    );

    // Try ForeFlight
    let ffRoute: string | null = null;
    let ffError: string | null = null;
    const tail = route.tail;
    const altitude = AIRCRAFT[tail]?.altitude ?? 410;

    try {
      const flightReq = {
        flight: {
          departure: route.dep,
          destination: route.arr,
          aircraftRegistration: tail,
          scheduledTimeOfDeparture: new Date(Date.now() + 3600_000).toISOString(),
          ...(cruiseUUIDs[tail] && { cruiseProfileUUID: cruiseUUIDs[tail] }),
          routeToDestination: {
            altitude: { altitude, unit: "FL" },
          },
          windOptions: { windModel: "Forecasted" },
        },
      };

      const flightRes = await fetch(`${FF_BASE}/Flights`, {
        method: "POST",
        headers: { "x-api-key": ffKey, "Content-Type": "application/json" },
        body: JSON.stringify(flightReq),
      });

      if (flightRes.ok) {
        const flightData = await flightRes.json();
        const flightId = flightData.flightId ?? null;

        const routeData = flightData.routeToDestination ?? flightData.route ?? {};
        ffRoute = routeData.route ?? routeData.routeString ?? null;

        const navlog = flightData.performance?.navlog ?? flightData.navlog;
        if (!ffRoute && navlog && Array.isArray(navlog)) {
          ffRoute = navlog
            .map((wp: Record<string, unknown>) => wp.ident ?? wp.name)
            .filter(Boolean)
            .join(" ");
        }

        // Cleanup flight plan
        if (flightId) {
          fetch(`${FF_BASE}/Flights/${encodeURIComponent(flightId)}`, {
            method: "DELETE",
            headers: { "x-api-key": ffKey },
          }).catch(() => {});
        }
      } else {
        ffError = `ForeFlight ${flightRes.status}`;
      }
    } catch (err) {
      ffError = err instanceof Error ? err.message : String(err);
    }

    const method = ffRoute ? "foreflight+great_circle" : "great_circle";

    // Write to cache
    await supa.from("intl_route_cache").upsert({
      dep_icao: route.dep,
      arr_icao: route.arr,
      ff_route: ffRoute,
      overflights: gcOverflights,
      method,
      tail_used: tail,
      cached_at: new Date().toISOString(),
    }, { onConflict: "dep_icao,arr_icao" });

    results.push({ dep: route.dep, arr: route.arr, method, error: ffError ?? undefined });
  }

  return NextResponse.json({
    ok: true,
    processed: results.length,
    remaining: uncached.length - toProcess.length,
    total_routes: routeMap.size,
    total_cached: cachedSet.size + results.filter((r) => r.method !== "skipped").length,
    results,
  });
}
