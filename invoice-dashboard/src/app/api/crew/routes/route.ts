import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, isAuthed } from "@/lib/api-auth";
import { buildHasdataCache, getHasdataCacheStats, seedTargetedPairs } from "@/lib/hasdataCache";
import { createServiceClient } from "@/lib/supabase/service";
import { getPoolFlightSearches, getRequiredFlightSearches, type OncomingPool, type SwapAssignment, type CrewMember, type FlightLeg } from "@/lib/swapOptimizer";
import { DEFAULT_AIRPORT_ALIASES } from "@/lib/airportAliases";
import { detectCurrentRotation } from "@/lib/crewRotationDetect";

export const dynamic = "force-dynamic";
export const maxDuration = 300; // 5 min

/**
 * POST /api/crew/routes
 * Body: { swap_date: "2026-03-25", mode?: "seed" | "fill" | "refresh" }
 *
 * Smart flight seeding: auto-detects rotation to identify which crew need flights,
 * then seeds only the targeted pairs (~300-500) instead of the full matrix (~7000).
 * Falls back to full matrix if auto-detect fails.
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

    const supa = createServiceClient();

    // ── Try smart seeding: auto-detect rotation → targeted pairs ──────────
    let smartPairs: { origin: string; destination: string; date: string }[] | null = null;
    try {
      // Load flights and crew roster (same as optimize route)
      const swapDay = new Date(swapDate);
      const start = new Date(swapDay.getTime() - 4 * 24 * 60 * 60 * 1000).toISOString();
      const end = new Date(swapDay.getTime() + 3 * 24 * 60 * 60 * 1000).toISOString();

      const [flightsRes, crewRes, aliasRes] = await Promise.all([
        supa.from("flights")
          .select("id, tail_number, departure_icao, arrival_icao, scheduled_departure, scheduled_arrival, flight_type, pic, sic")
          .gte("scheduled_departure", start)
          .lte("scheduled_departure", end)
          .order("scheduled_departure"),
        supa.from("crew_members").select("*"),
        supa.from("airport_aliases").select("fbo_icao, commercial_icao, preferred"),
      ]);

      if (!flightsRes.error && !crewRes.error) {
        const flights: FlightLeg[] = (flightsRes.data ?? []).map((f) => ({
          id: f.id as string,
          tail_number: f.tail_number as string,
          departure_icao: f.departure_icao as string,
          arrival_icao: f.arrival_icao as string,
          scheduled_departure: f.scheduled_departure as string,
          scheduled_arrival: f.scheduled_arrival as string | null,
          flight_type: f.flight_type as string | null,
          pic: f.pic as string | null,
          sic: f.sic as string | null,
        }));

        const crewRoster: CrewMember[] = (crewRes.data ?? []).map((c) => ({
          id: c.id as string,
          name: c.name as string,
          jetinsight_name: (c.jetinsight_name as string | null) ?? null,
          role: c.role as "PIC" | "SIC",
          home_airports: (c.home_airports as string[]) ?? [],
          aircraft_types: (c.aircraft_types as string[]) ?? [],
          is_checkairman: (c.is_checkairman as boolean) ?? false,
          checkairman_types: (c.checkairman_types as string[]) ?? [],
          is_skillbridge: (c.is_skillbridge as boolean) ?? false,
          grade: (c.grade as number) ?? 3,
          restrictions: (c.restrictions as Record<string, boolean>) ?? {},
          priority: (c.priority as number) ?? 0,
          rotation_group: (c.rotation_group as "A" | "B" | null) ?? null,
        }));

        // Build aliases
        const dbAliases = (aliasRes.data ?? []).map((a) => ({
          fbo_icao: (a.fbo_icao as string).toUpperCase(),
          commercial_icao: (a.commercial_icao as string).toUpperCase(),
          preferred: a.preferred as boolean,
        }));
        const dbFboKeys = new Set(dbAliases.map((a) => `${a.fbo_icao}|${a.commercial_icao}`));
        const aliases = [
          ...dbAliases,
          ...DEFAULT_AIRPORT_ALIASES.filter((a) => !dbFboKeys.has(`${a.fbo_icao}|${a.commercial_icao}`)),
        ];

        // Auto-detect rotation
        const detected = detectCurrentRotation(flights, crewRoster, swapDate);
        const swapAssignments = detected.swap_assignments;
        const oncomingPool = detected.oncoming_pool;

        if (Object.keys(swapAssignments).length > 0) {
          const pairSet = new Set<string>();
          const pairs: { origin: string; destination: string; date: string }[] = [];

          // Oncoming pool → swap locations (all pool members × all swap airports)
          const oncomingPairs = getPoolFlightSearches({
            oncomingPool,
            aliases,
            swapAssignments,
            flights,
            swapDate,
          });
          for (const p of oncomingPairs) {
            const key = `${p.origin}-${p.destination}-${p.date}`;
            if (!pairSet.has(key)) { pairSet.add(key); pairs.push(p); }
          }

          // All assigned crew (oncoming + offgoing) → both directions
          const requiredPairs = getRequiredFlightSearches({
            crewRoster,
            aliases,
            swapAssignments,
            flights,
            swapDate,
          });
          for (const p of requiredPairs) {
            const key = `${p.origin}-${p.destination}-${p.date}`;
            if (!pairSet.has(key)) { pairSet.add(key); pairs.push(p); }
          }

          // Also add next-day pairs for offgoing crew (they may need Thursday flights)
          const nextDay = new Date(swapDate);
          nextDay.setDate(nextDay.getDate() + 1);
          const nextDayStr = nextDay.toISOString().slice(0, 10);
          const nextDayPairs: { origin: string; destination: string; date: string }[] = [];
          for (const p of requiredPairs) {
            const key = `${p.origin}-${p.destination}-${nextDayStr}`;
            if (!pairSet.has(key)) { pairSet.add(key); nextDayPairs.push({ ...p, date: nextDayStr }); }
          }
          pairs.push(...nextDayPairs);

          smartPairs = pairs;
          console.log(`[Routes API] Smart seeding: ${detected.stats.tails_detected} tails, ${oncomingPool.pic.length} PICs + ${oncomingPool.sic.length} SICs → ${pairs.length} targeted pairs (vs ~7000 full matrix)`);
        }
      }
    } catch (e) {
      console.warn(`[Routes API] Smart seeding failed, falling back to full matrix:`, e instanceof Error ? e.message : e);
    }

    // ── Seed: smart pairs if available, otherwise full matrix ─────────────
    if (smartPairs && smartPairs.length > 0) {
      // Filter out already-cached pairs in fill mode
      let pairsToSeed = smartPairs;
      if (mode === "fill") {
        const skipPairs = new Set<string>();
        const recentCutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
        const dates = [...new Set(smartPairs.map((p) => p.date))];
        for (const d of dates) {
          const { data: existing } = await supa
            .from("hasdata_flight_cache")
            .select("origin_iata, destination_iata, offer_count, fetched_at")
            .eq("cache_date", d);
          for (const r of existing ?? []) {
            const key = `${r.origin_iata}-${r.destination_iata}-${d}`;
            if ((r.offer_count as number) > 0 || (r.fetched_at && (r.fetched_at as string) > recentCutoff)) {
              skipPairs.add(key);
            }
          }
        }
        const before = pairsToSeed.length;
        pairsToSeed = pairsToSeed.filter((p) => !skipPairs.has(`${p.origin}-${p.destination}-${p.date}`));
        console.log(`[Routes API] Fill mode: ${pairsToSeed.length} to fetch (${before - pairsToSeed.length} already cached)`);
      }

      if (pairsToSeed.length === 0) {
        return NextResponse.json({
          ok: true, swap_date: swapDate, mode: "smart-fill",
          pairs_queried: 0, offers_cached: 0, errors: [], duration_ms: 0,
          message: "Smart cache already complete",
        });
      }

      const result = await seedTargetedPairs(pairsToSeed, { batchSize: 50, delayMs: 100 });
      return NextResponse.json({
        ok: true, swap_date: swapDate, mode: "smart",
        total_targeted: smartPairs.length,
        ...result,
      });
    }

    // Fallback: full matrix seeding
    console.log(`[Routes API] Falling back to full matrix seeding for ${swapDate}`);
    const result = await buildHasdataCache(swapDate, mode);
    return NextResponse.json({
      ok: true, swap_date: swapDate, mode,
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
