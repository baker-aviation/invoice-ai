import "server-only";
import type { FlightInfo } from "./flightaware";
import { createServiceClient } from "./supabase/service";

/**
 * Two-layer flight cache:
 *  1. In-memory (fast, but lost on serverless cold start)
 *  2. Supabase `flight_cache` table (single row, survives cold starts)
 *
 * Reads check memory first, then Supabase.
 * Writes update both layers.
 */

let memCache: { data: FlightInfo[]; ts: number } | null = null;

// Stale lock timeout — if an instance crashes mid-refresh, the lock auto-expires
const LOCK_TIMEOUT_MS = 3 * 60_000; // 3 minutes

/**
 * Check if another instance is currently refreshing (shared across all Vercel instances).
 */
export async function isRefreshing(): Promise<boolean> {
  try {
    const supa = createServiceClient();
    const { data: row } = await supa
      .from("flight_cache")
      .select("refreshing_since")
      .eq("id", 1)
      .single();

    if (!row?.refreshing_since) return false;
    const elapsed = Date.now() - new Date(row.refreshing_since).getTime();
    return elapsed < LOCK_TIMEOUT_MS;
  } catch {
    return false; // On error, allow refresh
  }
}

/**
 * Atomically claim the refresh lock. Returns true if THIS instance won the lock.
 * Uses a conditional update so only one instance can claim it.
 */
export async function tryClaimRefresh(): Promise<boolean> {
  try {
    const supa = createServiceClient();
    const staleThreshold = new Date(Date.now() - LOCK_TIMEOUT_MS).toISOString();

    // Atomic: only claim if no one holds a non-stale lock
    // Uses .or() to match: no lock set, OR lock is stale
    const { data, error } = await supa
      .from("flight_cache")
      .update({ refreshing_since: new Date().toISOString() })
      .eq("id", 1)
      .or(`refreshing_since.is.null,refreshing_since.lt.${staleThreshold}`)
      .select("id");

    if (error || !data || data.length === 0) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * Release the refresh lock.
 */
export async function clearRefreshing(): Promise<void> {
  try {
    const supa = createServiceClient();
    await supa
      .from("flight_cache")
      .update({ refreshing_since: null })
      .eq("id", 1);
  } catch {
    // Non-fatal
  }
}

// Dynamic TTL: poll every 5 min when aircraft are airborne, 2h otherwise.
// Webhooks handle discrete events (filed, departure, arrival) but frequent
// polling gives us live ETA/position updates for en-route flights.
const AIRBORNE_TTL = 5 * 60_000;   // 5 minutes (was 3 — reduced FA API costs)
const IDLE_TTL = 2 * 60 * 60_000;  // 2 hours

function hasAirborneFlights(flights: FlightInfo[]): boolean {
  return flights.some((f) => f.status === "En Route" || f.status === "Diverted");
}

export function getCacheTtl(): number {
  if (memCache && hasAirborneFlights(memCache.data)) return AIRBORNE_TTL;
  return IDLE_TTL;
}

export async function getCache(): Promise<{ data: FlightInfo[]; ts: number } | null> {
  // Fast path: in-memory
  if (memCache) return memCache;

  // Cold start: load from Supabase
  try {
    const supa = createServiceClient();
    const { data: row } = await supa
      .from("flight_cache")
      .select("data, updated_at")
      .eq("id", 1)
      .single();

    if (row && row.data && Array.isArray(row.data) && row.data.length > 0) {
      const ts = new Date(row.updated_at).getTime();
      memCache = { data: row.data as FlightInfo[], ts };
      return memCache;
    }
  } catch {
    // Supabase unavailable — no cache
  }

  return null;
}

export async function setCache(data: FlightInfo[]): Promise<void> {
  const ts = Date.now();
  memCache = { data, ts };

  // Persist to Supabase
  try {
    const supa = createServiceClient();
    const { error } = await supa
      .from("flight_cache")
      .update({ data: data as unknown as Record<string, unknown>[], updated_at: new Date(ts).toISOString() })
      .eq("id", 1);
    if (error) {
      console.error("[FlightCache] Supabase write failed:", error.message, "data size:", JSON.stringify(data).length, "bytes");
    } else {
      console.log("[FlightCache] Wrote", data.length, "flights to Supabase cache");
    }
  } catch (err) {
    console.error("[FlightCache] Supabase write error:", err);
  }
}

export function invalidateCache(): void {
  memCache = null;
  // Also clear Supabase (fire-and-forget)
  try {
    const supa = createServiceClient();
    supa
      .from("flight_cache")
      .update({ data: [], updated_at: new Date(0).toISOString() })
      .eq("id", 1)
      .then(() => {});
  } catch {
    // Non-fatal
  }
}

export async function isCacheFresh(): Promise<boolean> {
  const cached = await getCache();
  return cached !== null && Date.now() - cached.ts < getCacheTtl();
}

/**
 * Update or insert a single flight in the cache without a full FA re-poll.
 * Used by webhook events to keep cache current between daily polls.
 */
export async function updateFlightInCache(
  tail: string,
  update: Partial<FlightInfo> & { fa_flight_id: string },
): Promise<void> {
  const cached = await getCache();
  if (!cached || cached.data.length === 0) return; // no cache to update

  const flights = [...cached.data];
  const idx = flights.findIndex(
    (f) => f.fa_flight_id === update.fa_flight_id,
  );

  if (idx >= 0) {
    // Merge update into existing entry
    flights[idx] = { ...flights[idx], ...update };
  } else {
    // New flight not in cache — add it with tail
    flights.push({ ...({ tail } as FlightInfo), ...update } as FlightInfo);
  }

  await setCache(flights);
}
