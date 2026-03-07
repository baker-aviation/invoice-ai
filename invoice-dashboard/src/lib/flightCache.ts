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

// 10 min during business hours (7AM–11PM CT), 20 min overnight
export function getCacheTtl(): number {
  const ct = new Date().toLocaleString("en-US", {
    timeZone: "America/Chicago",
    hour: "numeric",
    hour12: false,
  });
  const hour = parseInt(ct, 10);
  return hour >= 7 && hour < 23 ? 600_000 : 1_200_000;
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
