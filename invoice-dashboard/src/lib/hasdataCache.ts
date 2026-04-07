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
import { isCommercialAirport, findNearbyCommercialAirports, hasCoords } from "@/lib/driveTime";
import type { FlightOffer } from "@/lib/amadeus";

// ─── Types ──────────────────────────────────────────────────────────────────

export type CityPair = {
  origin: string;      // IATA code
  destination: string;  // IATA code
  date?: string;        // YYYY-MM-DD — when set, seeds for this specific date
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

  // Resolve swap locations to ALL commercial airports (not just preferred)
  // This ensures DEN→LAX is cached when VNY maps to both BUR and LAX
  const resolvedSwapLocations = new Set<string>();
  const allAliasMap = new Map<string, Set<string>>(); // FBO → all commercial alternatives
  for (const a of DEFAULT_AIRPORT_ALIASES) {
    const fbo = icaoToIata(a.fbo_icao.toUpperCase());
    const comm = icaoToIata(a.commercial_icao.toUpperCase());
    if (!allAliasMap.has(fbo)) allAliasMap.set(fbo, new Set());
    allAliasMap.get(fbo)!.add(comm);
  }
  for (const a of dbAliases ?? []) {
    const fbo = icaoToIata((a.fbo_icao as string).toUpperCase());
    const comm = icaoToIata((a.commercial_icao as string).toUpperCase());
    if (!allAliasMap.has(fbo)) allAliasMap.set(fbo, new Set());
    allAliasMap.get(fbo)!.add(comm);
  }
  for (const loc of swapLocations) {
    const allComm = allAliasMap.get(loc);
    if (allComm) {
      for (const comm of allComm) resolvedSwapLocations.add(comm);
    } else {
      resolvedSwapLocations.add(aliasMap.get(loc) ?? loc);
    }
  }

  // Resolve home airports through ALL aliases (not just preferred).
  // Crew at VNY need both BUR and LAX cached — the optimizer tries all alternatives.
  const resolvedHomeAirports = new Set<string>();
  for (const home of homeAirports) {
    const allComm = allAliasMap.get(home);
    if (allComm) {
      for (const comm of allComm) resolvedHomeAirports.add(comm);
    } else {
      resolvedHomeAirports.add(aliasMap.get(home) ?? home);
    }
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

// ─── Targeted pair seeding ───────────────────────────────────────────────────

/**
 * Seed specific city pairs into the HasData cache.
 *
 * Takes explicit CityPair[] (each pair must have origin, destination, date)
 * and processes them in batches, upserting results to hasdata_flight_cache.
 *
 * Used by buildHasdataCache() internally and by the on-demand seed-flights API.
 */
export async function seedTargetedPairs(
  pairs: CityPair[],
  options?: { batchSize?: number; delayMs?: number },
): Promise<HasdataCacheResult> {
  const start = Date.now();
  const supa = createServiceClient();
  const errors: string[] = [];
  let offersCached = 0;

  const BATCH_SIZE = options?.batchSize ?? 25;
  const DELAY_MS = options?.delayMs ?? 200;

  for (let i = 0; i < pairs.length; i += BATCH_SIZE) {
    const batch = pairs.slice(i, i + BATCH_SIZE);

    const results = await Promise.all(
      batch.map(async (pair) => {
        try {
          const result = await searchFlights({
            origin: pair.origin,
            destination: pair.destination,
            date: pair.date!,
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
        cache_date: r.pair.date!,
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
    if (progress % BATCH_SIZE === 0 || progress === pairs.length) {
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

  // Seed both swap day and next day. The optimizer searches next-day flights
  // for offgoing crew (late arrivals need Thursday morning flights home).
  const nextDay = new Date(swapDate);
  nextDay.setDate(nextDay.getDate() + 1);
  const nextDayStr = nextDay.toISOString().slice(0, 10);
  const datesToSeed = [swapDate, nextDayStr];

  const pairs = await computeCityPairMatrix(swapDate);
  // Duplicate pairs for next day
  const nextDayPairs = pairs.map((p) => ({ ...p, date: nextDayStr }));
  const swapDayPairs = pairs.map((p) => ({ ...p, date: swapDate }));
  let allPairs = [...swapDayPairs, ...nextDayPairs];

  if (mode === "seed") {
    // NEVER delete the cache — too expensive to rebuild. Just upsert over existing.
    // The old behavior wiped everything, losing manually-seeded pairs.
    console.log(`[HasdataCache] Seed mode: will upsert over existing (no delete)`);
  }
  if (mode === "fill") {
    // Fetch pairs that are either missing OR failed (offer_count = 0).
    // Previous behavior only skipped pairs with any existing row, which meant
    // 429/timeout failures (stored as empty rows) were never retried.
    const cachedWithFlights = new Set<string>();
    for (const d of datesToSeed) {
      const { data: existing } = await supa
        .from("hasdata_flight_cache")
        .select("origin_iata, destination_iata, offer_count")
        .eq("cache_date", d);
      for (const r of existing ?? []) {
        // Only skip pairs that actually have flights — retry empty ones
        if ((r.offer_count as number) > 0) {
          cachedWithFlights.add(`${r.origin_iata}-${r.destination_iata}-${d}`);
        }
      }
    }
    const before = allPairs.length;
    allPairs = allPairs.filter((p) => !cachedWithFlights.has(`${p.origin}-${p.destination}-${p.date}`));
    console.log(`[HasdataCache] Fill mode: ${allPairs.length} pairs to fetch (${before - allPairs.length} already have flights, retrying empty/failed pairs)`);
    if (allPairs.length === 0) {
      console.log(`[HasdataCache] Cache is complete for ${datesToSeed.join("+")} — nothing to fetch`);
      return { pairs_queried: 0, offers_cached: 0, errors: [], duration_ms: Date.now() - start };
    }
  }

  // Delegate to seedTargetedPairs with cron-sized batches (50 concurrent, 200ms delay)
  const result = await seedTargetedPairs(allPairs, { batchSize: 50, delayMs: 200 });

  return result;
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

  // Load swap-day AND next-day flights. The optimizer searches Thursday
  // (day after swap) for offgoing crew with late arrivals, and for oncoming
  // volunteers who can go a day early/late.
  const nextDay = new Date(date);
  nextDay.setDate(nextDay.getDate() + 1);
  const nextDayStr = nextDay.toISOString().slice(0, 10);
  const datesToLoad = [date, nextDayStr];

  const PAGE_SIZE = 5000;
  const allRows: { cache_date: string; origin_iata: string; destination_iata: string; flight_offers: unknown; offer_count: number }[] = [];

  for (const d of datesToLoad) {
    let from = 0;
    while (true) {
      const { data, error } = await supa
        .from("hasdata_flight_cache")
        .select("cache_date, origin_iata, destination_iata, flight_offers, offer_count")
        .eq("cache_date", d)
        .gt("offer_count", 0)
        .range(from, from + PAGE_SIZE - 1);

      if (error) {
        console.warn(`[HasdataCache] Error loading page ${from} for ${d}:`, error.message);
        break;
      }
      if (!data || data.length === 0) break;

      allRows.push(...(data as typeof allRows));
      if (data.length < PAGE_SIZE) break;
      from += PAGE_SIZE;
    }
  }

  console.log(`[HasdataCache] Loaded ${allRows.length} rows with flights for ${datesToLoad.join("+")} (skipped empty pairs)`);

  const offerMap = new Map<string, FlightOffer[]>();
  let totalFlights = 0;

  for (const row of allRows) {
    const key = `${row.origin_iata}-${row.destination_iata}-${row.cache_date}`;
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

// ─── New Airport Detection ──────────────────────────────────────────────────

export type NewAirportAlert = {
  icao: string;
  iata: string;
  is_commercial: boolean;
  suggested_alias: string | null; // nearest commercial ICAO
  suggested_alias_iata: string | null;
  distance_miles: number | null;
  appears_in_flights: number; // how many flights reference this airport
  first_seen_date: string; // earliest flight date
};

/**
 * Detect airports that appear in the flights table but have no alias mapping.
 * Returns a list of unaliased non-commercial airports with suggested aliases
 * based on proximity to the nearest commercial airport.
 *
 * Run after JI schedule sync to catch new airports before swap planning.
 */
export async function detectNewAirports(options?: {
  lookAheadDays?: number;  // default 14 — scan flights this many days ahead
}): Promise<{
  new_airports: NewAirportAlert[];
  auto_aliased: { fbo: string; commercial: string; distance: number }[];
  total_flight_airports: number;
  already_aliased: number;
  commercial: number;
}> {
  const supa = createServiceClient();
  const lookAhead = options?.lookAheadDays ?? 14;

  const start = new Date().toISOString();
  const end = new Date(Date.now() + lookAhead * 86400_000).toISOString();

  // Get all airports from upcoming flights
  const { data: flights } = await supa
    .from("flights")
    .select("departure_icao, arrival_icao, scheduled_departure")
    .gte("scheduled_departure", start)
    .lte("scheduled_departure", end);

  const airportFlightCount = new Map<string, { count: number; earliest: string }>();
  for (const f of flights ?? []) {
    for (const icao of [f.departure_icao, f.arrival_icao]) {
      if (!icao) continue;
      const upper = icao.toUpperCase();
      const existing = airportFlightCount.get(upper);
      const dep = f.scheduled_departure as string;
      if (existing) {
        existing.count++;
        if (dep < existing.earliest) existing.earliest = dep;
      } else {
        airportFlightCount.set(upper, { count: 1, earliest: dep });
      }
    }
  }

  // Build set of known aliases (both DB and defaults)
  const { data: dbAliases } = await supa
    .from("airport_aliases")
    .select("fbo_icao");
  const aliasedSet = new Set<string>();
  for (const a of dbAliases ?? []) aliasedSet.add(a.fbo_icao.toUpperCase());
  for (const a of DEFAULT_AIRPORT_ALIASES) aliasedSet.add(a.fbo_icao.toUpperCase());

  // Find gaps
  const newAirports: NewAirportAlert[] = [];
  const autoAliased: { fbo: string; commercial: string; distance: number }[] = [];
  let commercial = 0;
  let aliased = 0;

  for (const [icao, info] of airportFlightCount) {
    const iata = icao.length === 4 && icao.startsWith("K") ? icao.slice(1) : icao;

    if (isCommercialAirport(icao)) {
      commercial++;
      continue;
    }
    if (aliasedSet.has(icao)) {
      aliased++;
      continue;
    }

    // This airport has no alias — find nearest commercial (500mi radius — always show closest)
    let suggested: string | null = null;
    let suggestedIata: string | null = null;
    let distance: number | null = null;

    if (hasCoords(icao)) {
      const nearby = findNearbyCommercialAirports(icao, 500);
      if (nearby.length > 0) {
        suggested = nearby[0].icao;
        suggestedIata = suggested.length === 4 && suggested.startsWith("K") ? suggested.slice(1) : suggested;
        distance = nearby[0].distanceMiles;
      }
    }

    // Auto-alias if a commercial airport is within 80mi (~1hr drive)
    if (suggested && distance != null && distance <= 80) {
      const { error: upsertErr } = await supa.from("airport_aliases").upsert({
        fbo_icao: icao,
        commercial_icao: suggested,
        preferred: true,
      }, { onConflict: "fbo_icao" });

      if (!upsertErr) {
        autoAliased.push({ fbo: icao, commercial: suggested, distance: Math.round(distance) });
        aliasedSet.add(icao); // prevent re-processing
        console.log(`[DetectAirports] Auto-aliased ${icao} → ${suggested} (${Math.round(distance)}mi)`);
        continue; // don't add to new_airports — it's handled
      }
      // If upsert failed, fall through to report as new_airport
      console.error(`[DetectAirports] Failed to auto-alias ${icao} → ${suggested}: ${upsertErr.message}`);
    }

    newAirports.push({
      icao,
      iata,
      is_commercial: false,
      suggested_alias: suggested,
      suggested_alias_iata: suggestedIata,
      distance_miles: distance,
      appears_in_flights: info.count,
      first_seen_date: info.earliest.slice(0, 10),
    });
  }

  // Sort by flight count descending (most impactful gaps first)
  newAirports.sort((a, b) => b.appears_in_flights - a.appears_in_flights);

  return {
    new_airports: newAirports,
    auto_aliased: autoAliased,
    total_flight_airports: airportFlightCount.size,
    already_aliased: aliased,
    commercial,
  };
}

/**
 * Detect city pairs needed for a swap date that aren't cached yet.
 * Returns the missing pairs so they can be seeded.
 */
export async function detectMissingCachePairs(swapDate: string): Promise<{
  missing_pairs: CityPair[];
  total_needed: number;
  already_cached: number;
}> {
  const needed = await computeCityPairMatrix(swapDate);

  const supa = createServiceClient();
  const { data: cached } = await supa
    .from("hasdata_flight_cache")
    .select("origin_iata, destination_iata")
    .eq("cache_date", swapDate);

  const cachedSet = new Set<string>();
  for (const r of cached ?? []) {
    cachedSet.add(`${r.origin_iata}|${r.destination_iata}`);
  }

  const missing = needed.filter(p => !cachedSet.has(`${p.origin}|${p.destination}`));

  return {
    missing_pairs: missing,
    total_needed: needed.length,
    already_cached: cachedSet.size,
  };
}
