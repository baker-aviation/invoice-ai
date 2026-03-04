import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { requireAuth, isAuthed } from "@/lib/api-auth";

export const dynamic = "force-dynamic";

// Airplanes.live API — free, no API key, 1 req/sec rate limit
const ADSB_API = "https://api.airplanes.live/v2";

export type AircraftPosition = {
  tail: string;
  lat: number;
  lon: number;
  alt_baro: number | null;    // feet
  gs: number | null;          // ground speed (knots)
  track: number | null;       // heading (degrees)
  on_ground: boolean;
  squawk: string | null;
  flight: string | null;      // callsign
  seen: number | null;        // seconds since last message
  hex: string | null;         // ICAO hex code
};

// Simple in-memory cache to respect rate limits
let cachedResult: { data: AircraftPosition[]; ts: number } | null = null;
const CACHE_TTL_MS = 30_000; // 30 seconds

async function fetchAdsbPosition(tail: string): Promise<AircraftPosition | null> {
  try {
    // Airplanes.live expects registration without dashes
    const reg = tail.replace(/-/g, "");
    const res = await fetch(`${ADSB_API}/reg/${reg}`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const json = await res.json();
    const ac = json.ac?.[0];
    if (!ac || ac.lat == null || ac.lon == null) return null;

    return {
      tail,
      lat: ac.lat,
      lon: ac.lon,
      alt_baro: typeof ac.alt_baro === "number" ? ac.alt_baro : null,
      gs: typeof ac.gs === "number" ? ac.gs : null,
      track: typeof ac.track === "number" ? ac.track : null,
      on_ground: ac.alt_baro === "ground" || ac.on_ground === true,
      squawk: ac.squawk ?? null,
      flight: ac.flight?.trim() ?? null,
      seen: typeof ac.seen === "number" ? ac.seen : null,
      hex: ac.hex ?? null,
    };
  } catch {
    return null;
  }
}

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;

  // Return cache if fresh
  if (cachedResult && Date.now() - cachedResult.ts < CACHE_TTL_MS) {
    return NextResponse.json({
      aircraft: cachedResult.data,
      count: cachedResult.data.length,
      cached: true,
    });
  }

  // Get unique tail numbers from flights table (upcoming flights)
  const supa = createServiceClient();
  const now = new Date();
  const past = new Date(now.getTime() - 12 * 60 * 60 * 1000).toISOString();
  const future = new Date(now.getTime() + 48 * 60 * 60 * 1000).toISOString();

  const { data: flights } = await supa
    .from("flights")
    .select("tail_number")
    .gte("scheduled_departure", past)
    .lte("scheduled_departure", future);

  const tails = [...new Set(
    (flights ?? [])
      .map((f) => f.tail_number as string | null)
      .filter((t): t is string => !!t),
  )];

  if (tails.length === 0) {
    return NextResponse.json({ aircraft: [], count: 0, cached: false });
  }

  // Query airplanes.live in batches (respect 1 req/sec rate limit)
  // Batch 5 concurrent requests, then pause 1s between batches
  const positions: AircraftPosition[] = [];
  const BATCH_SIZE = 5;

  for (let i = 0; i < tails.length; i += BATCH_SIZE) {
    const batch = tails.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(batch.map(fetchAdsbPosition));
    for (const r of results) {
      if (r) positions.push(r);
    }
    // Rate limit pause between batches (skip after last batch)
    if (i + BATCH_SIZE < tails.length) {
      await new Promise((resolve) => setTimeout(resolve, 1200));
    }
  }

  cachedResult = { data: positions, ts: Date.now() };

  return NextResponse.json({
    aircraft: positions,
    count: positions.length,
    total_tails: tails.length,
    cached: false,
  });
}
