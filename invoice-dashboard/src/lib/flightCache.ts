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

// Re-poll FA every 15 minutes to catch status changes (en route, landed, etc.)
// Webhook push events also update the cache between polls.
const CACHE_TTL = 15 * 60_000; // 15 minutes

export function getCacheTtl(): number {
  return CACHE_TTL;
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

  // Persist to Supabase (fire-and-forget)
  try {
    const supa = createServiceClient();
    await supa
      .from("flight_cache")
      .update({ data: data as unknown as Record<string, unknown>[], updated_at: new Date(ts).toISOString() })
      .eq("id", 1);
  } catch {
    // Non-fatal — in-memory cache still works
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
