/**
 * Commercial Flight Schedule Cache
 *
 * Pre-loads all US domestic commercial flights from FlightAware AeroAPI
 * for relevant airports on the swap date. Stores in commercial_flight_cache
 * table so the optimizer can instantly look up all route options.
 *
 * Replaces per-route HasData scraping for flight DISCOVERY.
 * HasData is still used for real pricing on top candidates.
 *
 * Schedule:
 *  - Monday 11pm ET (seed): full load of all airports
 *  - Tuesday 6am ET (refresh): re-fetch to pick up schedule changes
 */

import "server-only";
import { createServiceClient } from "@/lib/supabase/service";
import { fetchScheduledDepartures, type ScheduledFlight } from "./flightaware";
import { DEFAULT_AIRPORT_ALIASES } from "./airportAliases";
import { BUDGET_CARRIERS } from "./swapRules";
import type { FlightOffer } from "./amadeus";

// ─── Types ──────────────────────────────────────────────────────────────────

export type CachedFlight = {
  cache_date: string;
  origin_icao: string;
  origin_iata: string;
  destination_icao: string;
  destination_iata: string;
  flight_number: string;
  airline_iata: string;
  scheduled_departure: string;
  scheduled_arrival: string;
  duration_minutes: number;
  aircraft_type: string | null;
  estimated_price: number | null;
  hasdata_price: number | null;
  fa_flight_id: string | null;
  is_direct: boolean;
};

export type CacheResult = {
  airports_fetched: number;
  flights_cached: number;
  errors: string[];
  duration_ms: number;
  /** When batching: which slice of airports was processed */
  batch_offset?: number;
  batch_limit?: number;
  total_airports?: number;
};

// ─── Airport collection ─────────────────────────────────────────────────────

/**
 * Collect all airports that matter for the swap optimizer:
 * 1. All crew home airports (where crew fly FROM/TO)
 * 2. All FBO commercial equivalents (where swaps happen)
 * 3. Preferred connection hubs
 *
 * Returns ICAO codes.
 */
export async function getRelevantAirports(): Promise<string[]> {
  const supa = createServiceClient();
  const airports = new Set<string>();

  // 1. All active crew home airports
  const { data: crew } = await supa
    .from("crew_members")
    .select("home_airports")
    .eq("active", true);

  for (const c of crew ?? []) {
    for (const ap of (c.home_airports as string[]) ?? []) {
      const icao = ap.length === 3 ? `K${ap}` : ap;
      airports.add(icao.toUpperCase());
    }
  }

  // 2. All FBO aliases (commercial side)
  const { data: aliases } = await supa
    .from("airport_aliases")
    .select("commercial_icao");

  for (const a of aliases ?? []) {
    airports.add((a.commercial_icao as string).toUpperCase());
  }

  // Also add default aliases
  for (const a of DEFAULT_AIRPORT_ALIASES) {
    airports.add(a.commercial_icao.toUpperCase());
  }

  // 3. Top connection hubs only (crew home airports already cover most of these)
  const HUBS = ["KATL", "KDFW", "KORD", "KDEN", "KCLT", "KIAH"];
  for (const h of HUBS) airports.add(h);

  return [...airports].sort();
}

// ─── Cache building ─────────────────────────────────────────────────────────

/**
 * Fetch all commercial flights from all relevant airports on a given date
 * and store in commercial_flight_cache.
 *
 * @param date - YYYY-MM-DD format
 * @param mode - "seed" clears existing data first, "refresh" upserts over existing
 * @param offset - start index into the airport list (for batching across requests)
 * @param limit - how many airports to process this call (default: all)
 */
export async function buildFlightCache(
  date: string,
  mode: "seed" | "refresh" = "seed",
  offset = 0,
  limit?: number,
): Promise<CacheResult> {
  const start = Date.now();
  const supa = createServiceClient();
  const errors: string[] = [];

  const allAirports = await getRelevantAirports();
  const totalAirports = allAirports.length;

  // Slice to the requested batch
  const airports = limit != null
    ? allAirports.slice(offset, offset + limit)
    : allAirports.slice(offset);

  console.log(`[CommercialCache] ${mode} for ${date}: batch ${offset}..${offset + airports.length} of ${totalAirports} airports`);

  // If seeding AND this is the first batch, clear existing data for this date
  if (mode === "seed" && offset === 0) {
    await supa.from("commercial_flight_cache").delete().eq("cache_date", date);
  }

  // Fetch departures from each airport and upsert incrementally.
  // If the function times out, whatever was already upserted is safe in Supabase.
  // Re-run with mode=refresh to fill in the rest (no delete, upsert handles dupes).
  let inserted = 0;
  const BATCH_SIZE = 5;

  for (let i = 0; i < airports.length; i += BATCH_SIZE) {
    const batch = airports.slice(i, i + BATCH_SIZE);
    const batchFlights: CachedFlightRow[] = [];

    const results = await Promise.all(
      batch.map(async (icao) => {
        try {
          const flights = await fetchScheduledDepartures(icao, date);
          return { icao, flights, error: null };
        } catch (e) {
          const msg = `${icao}: ${e instanceof Error ? e.message : "unknown"}`;
          return { icao, flights: [] as ScheduledFlight[], error: msg };
        }
      }),
    );

    for (const r of results) {
      if (r.error) {
        errors.push(r.error);
        continue;
      }

      for (const f of r.flights) {
        // Only cache US domestic flights (both airports start with K)
        if (!f.origin_icao.startsWith("K") || !f.destination_icao.startsWith("K")) continue;

        batchFlights.push({
          cache_date: date,
          origin_icao: f.origin_icao,
          origin_iata: f.origin_iata,
          destination_icao: f.destination_icao,
          destination_iata: f.destination_iata,
          flight_number: f.flight_number,
          airline_iata: f.airline_iata,
          scheduled_departure: f.scheduled_departure,
          scheduled_arrival: f.scheduled_arrival,
          duration_minutes: f.duration_minutes,
          aircraft_type: f.aircraft_type,
          estimated_price: estimateFlightPrice(f.duration_minutes, f.airline_iata),
          fa_flight_id: null,
          is_direct: true,
        });
      }
    }

    // Upsert this batch immediately — survives timeouts
    if (batchFlights.length > 0) {
      const { error } = await supa
        .from("commercial_flight_cache")
        .upsert(batchFlights, { onConflict: "cache_date,flight_number,scheduled_departure" });

      if (error) {
        errors.push(`Upsert at airport ${offset + i}: ${error.message}`);
      } else {
        inserted += batchFlights.length;
      }
    }

    const progress = Math.min(i + BATCH_SIZE, airports.length);
    console.log(`[CommercialCache] ${offset + progress}/${totalAirports} airports, ${inserted} flights saved`);

    // Rate limit pause between batches
    if (i + BATCH_SIZE < airports.length) {
      await new Promise((r) => setTimeout(r, 400));
    }
  }

  const duration = Date.now() - start;
  console.log(`[CommercialCache] Done: ${inserted} flights in ${(duration / 1000).toFixed(1)}s (${errors.length} errors)`);

  return {
    airports_fetched: airports.length,
    flights_cached: inserted,
    errors,
    duration_ms: duration,
    batch_offset: offset,
    batch_limit: limit,
    total_airports: totalAirports,
  };
}

// ─── Cache reading (for optimizer) ──────────────────────────────────────────

/**
 * Load cached flights as FlightOffer map for the optimizer.
 * Same format as scheduledFlightsToOffers() from flightaware.ts.
 */
export async function getCachedFlightsForOptimizer(
  date: string,
): Promise<{
  commercialFlights: Map<string, FlightOffer[]>;
  totalFlights: number;
}> {
  const supa = createServiceClient();

  const { data, error } = await supa
    .from("commercial_flight_cache")
    .select("*")
    .eq("cache_date", date);

  if (error || !data) {
    console.warn(`[CommercialCache] Error loading for ${date}:`, error?.message);
    return { commercialFlights: new Map(), totalFlights: 0 };
  }

  const offerMap = new Map<string, FlightOffer[]>();

  for (const f of data) {
    const key = `${f.origin_iata}-${f.destination_iata}-${date}`;
    if (!offerMap.has(key)) offerMap.set(key, []);

    const price = f.hasdata_price ?? f.estimated_price ?? estimateFlightPrice(f.duration_minutes, f.airline_iata);

    const offer: FlightOffer = {
      id: f.flight_number,
      price: { total: String(price), currency: "USD" },
      itineraries: [{
        duration: `PT${Math.floor(f.duration_minutes / 60)}H${f.duration_minutes % 60}M`,
        segments: [{
          departure: { iataCode: f.origin_iata, at: f.scheduled_departure },
          arrival: { iataCode: f.destination_iata, at: f.scheduled_arrival },
          carrierCode: f.airline_iata,
          number: f.flight_number.replace(/^[A-Z]{1,3}/, ""),
          duration: `PT${Math.floor(f.duration_minutes / 60)}H${f.duration_minutes % 60}M`,
          numberOfStops: 0,
        }],
      }],
      numberOfBookableSeats: 9,
    };

    offerMap.get(key)!.push(offer);
  }

  return { commercialFlights: offerMap, totalFlights: data.length };
}

/**
 * Get cached flights for a specific route.
 */
export async function getCachedRoute(
  originIata: string,
  destinationIata: string,
  date: string,
): Promise<CachedFlight[]> {
  const supa = createServiceClient();

  const { data } = await supa
    .from("commercial_flight_cache")
    .select("*")
    .eq("cache_date", date)
    .eq("origin_iata", originIata)
    .eq("destination_iata", destinationIata)
    .order("scheduled_departure");

  return (data ?? []) as CachedFlight[];
}

/**
 * Update pricing for specific flights using HasData real prices.
 */
export async function updateFlightPricing(
  date: string,
  updates: { flight_number: string; scheduled_departure: string; price: number }[],
): Promise<void> {
  const supa = createServiceClient();

  for (const u of updates) {
    await supa
      .from("commercial_flight_cache")
      .update({ hasdata_price: u.price })
      .eq("cache_date", date)
      .eq("flight_number", u.flight_number)
      .eq("scheduled_departure", u.scheduled_departure);
  }
}

/**
 * Get cache stats for a date — used by the UI to show cache status.
 */
export async function getCacheStats(date: string): Promise<{
  total_flights: number;
  airports: number;
  last_fetched: string | null;
  has_pricing: number;
} | null> {
  const supa = createServiceClient();

  const { data, error } = await supa
    .from("commercial_flight_cache")
    .select("origin_iata, fetched_at, hasdata_price")
    .eq("cache_date", date);

  if (error || !data || data.length === 0) return null;

  const uniqueAirports = new Set(data.map((f) => f.origin_iata as string));
  const hasPricing = data.filter((f) => f.hasdata_price != null).length;
  const latestFetch = data.reduce((latest, f) => {
    const t = f.fetched_at as string;
    return !latest || t > latest ? t : latest;
  }, "" as string);

  return {
    total_flights: data.length,
    airports: uniqueAirports.size,
    last_fetched: latestFetch || null,
    has_pricing: hasPricing,
  };
}

// ─── Internal types ─────────────────────────────────────────────────────────

type CachedFlightRow = {
  cache_date: string;
  origin_icao: string;
  origin_iata: string;
  destination_icao: string;
  destination_iata: string;
  flight_number: string;
  airline_iata: string;
  scheduled_departure: string;
  scheduled_arrival: string;
  duration_minutes: number;
  aircraft_type: string | null;
  estimated_price: number | null;
  fa_flight_id: string | null;
  is_direct: boolean;
};

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Estimate one-way economy fare from duration + airline */
function estimateFlightPrice(durationMin: number, airline: string): number {
  const budgetSet = new Set([...BUDGET_CARRIERS, "WN", "B6"]);
  const mult = budgetSet.has(airline) ? 0.7 : 1.0;
  return Math.min(Math.round((50 + durationMin * 1.5) * mult), 500);
}
