/**
 * HasData City-Pair Flight Cache
 *
 * Seeds a cache of commercial flight options for every crew↔swap city pair
 * by querying HasData (Google Flights scraper). Returns real prices, direct
 * AND connecting itineraries — unlike FlightAware airport dumps which only
 * return direct flights and miss FBO airports entirely.
 *
 * One row per origin-destination pair, with full FlightOffer[] JSONB.
 *
 * Cost: ~$4.50/week for ~3,000 city-pair queries (vs $300/week FlightAware).
 */

import "server-only";
import { createServiceClient } from "@/lib/supabase/service";
import { searchFlights } from "@/lib/hasdata";
import { DEFAULT_AIRPORT_ALIASES } from "@/lib/airportAliases";
import { extractSwapPointsPublic, type FlightLeg } from "@/lib/swapOptimizer";
import type { FlightOffer } from "@/lib/amadeus";

// ─── Types ──────────────────────────────────────────────────────────────────

export type CityPair = {
  origin: string;      // IATA code
  destination: string;  // IATA code
};

export type HasdataCacheResult = {
  pairs_queried: number;
  offers_cached: number;
  errors: string[];
  duration_ms: number;
};

export type HasdataCacheStats = {
  total_pairs: number;
  total_offers: number;
  pairs_with_flights: number;
  pairs_with_direct: number;
  min_price_overall: number | null;
  last_fetched: string | null;
};

// ─── ICAO → IATA helper ────────────────────────────────────────────────────

function icaoToIata(code: string): string {
  if (code.length === 4 && code.startsWith("K")) return code.slice(1);
  return code;
}

// ─── City-pair matrix computation ───────────────────────────────────────────

/**
 * Compute all origin-destination pairs needed for the swap optimizer.
 *
 * 1. Crew home airports → unique IATA codes
 * 2. Swap locations from flights table → unique IATA codes (resolved through aliases)
 * 3. Generate directional pairs: home→swap (oncoming) + swap→home (offgoing)
 * 4. Deduplicate
 */
export async function computeCityPairMatrix(swapDate: string): Promise<CityPair[]> {
  const supa = createServiceClient();

  // 1. All active crew home airports → IATA codes
  const { data: crew } = await supa
    .from("crew_members")
    .select("home_airports")
    .eq("active", true);

  const homeAirports = new Set<string>();
  for (const c of crew ?? []) {
    for (const ap of (c.home_airports as string[]) ?? []) {
      homeAirports.add(icaoToIata(ap.toUpperCase()));
    }
  }

  // 2. Swap locations from flights on/around swap date
  const wedDate = new Date(swapDate);
  const start = new Date(wedDate.getTime() - 1 * 24 * 60 * 60 * 1000).toISOString();
  const end = new Date(wedDate.getTime() + 1 * 24 * 60 * 60 * 1000).toISOString();

  const { data: flightsData } = await supa
    .from("flights")
    .select("id, tail_number, departure_icao, arrival_icao, scheduled_departure, scheduled_arrival, flight_type, pic, sic")
    .gte("scheduled_departure", start)
    .lte("scheduled_departure", end)
    .order("scheduled_departure");

  const flights: FlightLeg[] = (flightsData ?? []).map((f) => ({
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

  // Group by tail
  const byTail = new Map<string, FlightLeg[]>();
  for (const f of flights) {
    if (!byTail.has(f.tail_number)) byTail.set(f.tail_number, []);
    byTail.get(f.tail_number)!.push(f);
  }

  // Extract swap points from each tail
  const swapLocations = new Set<string>();
  for (const tail of byTail.keys()) {
    try {
      const { swapPoints } = extractSwapPointsPublic(tail, byTail, swapDate);
      for (const sp of swapPoints) {
        swapLocations.add(icaoToIata(sp.icao.toUpperCase()));
      }
    } catch {
      // Skip tails with extraction errors
    }
  }

  // If no swap points found from flights, use all unique departure/arrival airports
  if (swapLocations.size === 0) {
    for (const f of flights) {
      swapLocations.add(icaoToIata(f.departure_icao.toUpperCase()));
      swapLocations.add(icaoToIata(f.arrival_icao.toUpperCase()));
    }
  }

  // 3. Resolve all airports through aliases to commercial IATA codes
  // Build alias map: FBO IATA → preferred commercial IATA
  const aliasMap = new Map<string, string>();

  // DB aliases take precedence
  const { data: dbAliases } = await supa
    .from("airport_aliases")
    .select("fbo_icao, commercial_icao, preferred");

  for (const a of dbAliases ?? []) {
    const fbo = icaoToIata((a.fbo_icao as string).toUpperCase());
    const comm = icaoToIata((a.commercial_icao as string).toUpperCase());
    if (a.preferred || !aliasMap.has(fbo)) {
      aliasMap.set(fbo, comm);
    }
  }

  // Fill with defaults where DB doesn't have an entry
  for (const a of DEFAULT_AIRPORT_ALIASES) {
    const fbo = icaoToIata(a.fbo_icao.toUpperCase());
    const comm = icaoToIata(a.commercial_icao.toUpperCase());
    if (a.preferred && !aliasMap.has(fbo)) {
      aliasMap.set(fbo, comm);
    }
  }

  // Resolve swap locations to commercial airports
  const resolvedSwapLocations = new Set<string>();
  for (const loc of swapLocations) {
    const resolved = aliasMap.get(loc) ?? loc;
    resolvedSwapLocations.add(resolved);
  }

  // Resolve home airports too (some crew may list FBO codes)
  const resolvedHomeAirports = new Set<string>();
  for (const home of homeAirports) {
    const resolved = aliasMap.get(home) ?? home;
    resolvedHomeAirports.add(resolved);
  }

  // 4. Generate directional pairs and deduplicate
  const pairSet = new Set<string>();
  const pairs: CityPair[] = [];

  for (const home of resolvedHomeAirports) {
    for (const swap of resolvedSwapLocations) {
      if (home === swap) continue;

      // Oncoming: home → swap
      const onKey = `${home}-${swap}`;
      if (!pairSet.has(onKey)) {
        pairSet.add(onKey);
        pairs.push({ origin: home, destination: swap });
      }

      // Offgoing: swap → home
      const offKey = `${swap}-${home}`;
      if (!pairSet.has(offKey)) {
        pairSet.add(offKey);
        pairs.push({ origin: swap, destination: home });
      }
    }
  }

  console.log(`[HasdataCache] City-pair matrix: ${resolvedHomeAirports.size} home airports × ${resolvedSwapLocations.size} swap locations → ${pairs.length} unique pairs`);
  return pairs;
}

// ─── Cache seeding ──────────────────────────────────────────────────────────

/**
 * Seed the HasData cache by querying every city pair.
 *
 * @param swapDate - YYYY-MM-DD target date
 * @param mode
 *   "seed"    — clears existing rows first, then fetches all pairs (weekly fresh start)
 *   "refresh" — upserts over existing rows, re-fetches all pairs (force update)
 *   "fill"    — only fetches pairs not already in cache (resume after crash, or top-off)
 */
export async function buildHasdataCache(
  swapDate: string,
  mode: "seed" | "refresh" | "fill" = "seed",
): Promise<HasdataCacheResult> {
  const start = Date.now();
  const supa = createServiceClient();
  const errors: string[] = [];
  let offersCached = 0;

  let pairs = await computeCityPairMatrix(swapDate);

  if (mode === "seed") {
    await supa.from("hasdata_flight_cache").delete().eq("cache_date", swapDate);
    console.log(`[HasdataCache] Cleared existing cache for ${swapDate}`);
  } else if (mode === "fill") {
    // Only fetch pairs not already cached — skips pairs with any existing row
    const { data: existing } = await supa
      .from("hasdata_flight_cache")
      .select("origin_iata, destination_iata")
      .eq("cache_date", swapDate);
    const cached = new Set((existing ?? []).map((r) => `${r.origin_iata}-${r.destination_iata}`));
    const before = pairs.length;
    pairs = pairs.filter((p) => !cached.has(`${p.origin}-${p.destination}`));
    console.log(`[HasdataCache] Fill mode: ${pairs.length} uncached pairs (skipping ${before - pairs.length} already cached)`);
    if (pairs.length === 0) {
      console.log(`[HasdataCache] Cache is complete for ${swapDate} — nothing to fetch`);
      return { pairs_queried: 0, offers_cached: 0, errors: [], duration_ms: Date.now() - start };
    }
  }

  // Process in batches of 50 concurrent, 200ms delay between batches
  const BATCH_SIZE = 50;
  const DELAY_MS = 200;

  for (let i = 0; i < pairs.length; i += BATCH_SIZE) {
    const batch = pairs.slice(i, i + BATCH_SIZE);

    const results = await Promise.all(
      batch.map(async (pair) => {
        try {
          const result = await searchFlights({
            origin: pair.origin,
            destination: pair.destination,
            date: swapDate,
            max: 10,
          });
          return { pair, offers: result.offers, error: null };
        } catch (e) {
          const msg = `${pair.origin}-${pair.destination}: ${e instanceof Error ? e.message : "unknown"}`;
          return { pair, offers: [] as FlightOffer[], error: msg };
        }
      }),
    );

    // Upsert this batch immediately (survives timeouts)
    const rows = [];
    for (const r of results) {
      if (r.error) {
        errors.push(r.error);
        // Still upsert an empty row so we know we tried this pair
      }

      const offers = r.offers;
      const minPrice = offers.length > 0
        ? Math.min(...offers.map((o) => parseFloat(o.price.total)))
        : null;
      const hasDirect = offers.some((o) =>
        o.itineraries.length > 0 && o.itineraries[0].segments.length === 1,
      );

      rows.push({
        cache_date: swapDate,
        origin_iata: r.pair.origin,
        destination_iata: r.pair.destination,
        flight_offers: JSON.stringify(offers),
        offer_count: offers.length,
        min_price: minPrice != null ? Math.round(minPrice) : null,
        has_direct: hasDirect,
        fetched_at: new Date().toISOString(),
      });

      offersCached += offers.length;
    }

    if (rows.length > 0) {
      const { error } = await supa
        .from("hasdata_flight_cache")
        .upsert(rows, { onConflict: "cache_date,origin_iata,destination_iata" });

      if (error) {
        errors.push(`Upsert at batch ${i}: ${error.message}`);
      }
    }

    const progress = Math.min(i + BATCH_SIZE, pairs.length);
    if (progress % 50 === 0 || progress === pairs.length) {
      console.log(`[HasdataCache] ${progress}/${pairs.length} pairs queried, ${offersCached} offers cached`);
    }

    // Rate limit delay between batches
    if (i + BATCH_SIZE < pairs.length) {
      await new Promise((r) => setTimeout(r, DELAY_MS));
    }
  }

  const duration = Date.now() - start;
  console.log(`[HasdataCache] Done: ${pairs.length} pairs, ${offersCached} offers in ${(duration / 1000).toFixed(1)}s (${errors.length} errors)`);

  return {
    pairs_queried: pairs.length,
    offers_cached: offersCached,
    errors,
    duration_ms: duration,
  };
}

// ─── Cache reading (for optimizer) ──────────────────────────────────────────

/**
 * Load cached HasData flights as FlightOffer map for the optimizer.
 * Same return signature as getCachedFlightsForOptimizer() — drop-in replacement.
 */
export async function getHasdataCacheForOptimizer(
  date: string,
): Promise<{
  commercialFlights: Map<string, FlightOffer[]>;
  totalFlights: number;
}> {
  const supa = createServiceClient();

  // Only load rows that have flights (skip empty pairs — typically 40-50% of cache)
  const PAGE_SIZE = 5000;
  const allRows: { origin_iata: string; destination_iata: string; flight_offers: unknown; offer_count: number }[] = [];
  let from = 0;
  while (true) {
    const { data, error } = await supa
      .from("hasdata_flight_cache")
      .select("origin_iata, destination_iata, flight_offers, offer_count")
      .eq("cache_date", date)
      .gt("offer_count", 0) // skip empty pairs
      .range(from, from + PAGE_SIZE - 1);

    if (error) {
      console.warn(`[HasdataCache] Error loading page ${from} for ${date}:`, error.message);
      break;
    }
    if (!data || data.length === 0) break;

    allRows.push(...data);
    if (data.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }

  console.log(`[HasdataCache] Loaded ${allRows.length} rows with flights for ${date} (skipped empty pairs)`);

  const offerMap = new Map<string, FlightOffer[]>();
  let totalFlights = 0;

  for (const row of allRows) {
    const key = `${row.origin_iata}-${row.destination_iata}-${date}`;
    const offers = (typeof row.flight_offers === "string"
      ? JSON.parse(row.flight_offers as string)
      : row.flight_offers) as FlightOffer[];

    if (offers.length > 0) {
      offerMap.set(key, offers);
      totalFlights += offers.length;
    }
  }

  return { commercialFlights: offerMap, totalFlights };
}

// ─── Cache stats ────────────────────────────────────────────────────────────

/**
 * Get cache stats for a date — used by the UI to show cache status.
 */
export async function getHasdataCacheStats(date: string): Promise<HasdataCacheStats | null> {
  const supa = createServiceClient();

  // Use count query to avoid Supabase row limit (default 1000)
  const { count: totalPairs, error: countErr } = await supa
    .from("hasdata_flight_cache")
    .select("id", { count: "exact", head: true })
    .eq("cache_date", date);

  if (countErr || !totalPairs) return null;

  // Aggregate stats with paginated reads
  const PAGE = 5000;
  let totalOffers = 0, withFlights = 0, withDirect = 0;
  let minPrice: number | null = null;
  let latestFetch = "";

  let from = 0;
  while (true) {
    const { data, error } = await supa
      .from("hasdata_flight_cache")
      .select("offer_count, min_price, has_direct, fetched_at")
      .eq("cache_date", date)
      .range(from, from + PAGE - 1);

    if (error || !data || data.length === 0) break;

    for (const r of data) {
      const oc = r.offer_count as number;
      totalOffers += oc;
      if (oc > 0) withFlights++;
      if (r.has_direct) withDirect++;
      const p = r.min_price as number | null;
      if (p != null && (minPrice == null || p < minPrice)) minPrice = p;
      const t = r.fetched_at as string;
      if (t > latestFetch) latestFetch = t;
    }

    if (data.length < PAGE) break;
    from += PAGE;
  }

  return {
    total_pairs: totalPairs,
    total_offers: totalOffers,
    pairs_with_flights: withFlights,
    pairs_with_direct: withDirect,
    min_price_overall: minPrice,
    last_fetched: latestFetch || null,
  };
}
