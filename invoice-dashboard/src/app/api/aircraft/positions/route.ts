import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { requireAuth, isAuthed } from "@/lib/api-auth";
import { TRIPS } from "@/lib/maintenanceData";

export const dynamic = "force-dynamic";
export const maxDuration = 30; // seconds — hex lookups for fleet can take 10-20s

// Airplanes.live API — free, no API key, 1 req/sec rate limit
const ADSB_API = "https://api.airplanes.live/v2";

// Fallback: unique tail numbers from the hardcoded TRIPS list
const FALLBACK_TAILS = [...new Set(TRIPS.map((t) => t.tail))];

export type AircraftPosition = {
  tail: string;
  lat: number;
  lon: number;
  alt_baro: number | null;    // feet
  gs: number | null;          // ground speed (knots)
  track: number | null;       // heading (degrees)
  baro_rate: number | null;   // vertical rate (ft/min)
  on_ground: boolean;
  squawk: string | null;
  flight: string | null;      // callsign
  seen: number | null;        // seconds since last message
  hex: string | null;         // ICAO hex code
  aircraft_type: string | null; // e.g. "C750"
  description: string | null;   // e.g. "CESSNA 750 Citation 10"
};

// Simple in-memory cache to respect rate limits
let cachedResult: { data: AircraftPosition[]; ts: number } | null = null;
const CACHE_TTL_MS = 30_000; // 30 seconds

// ---------------------------------------------------------------------------
// N-number → ICAO hex code conversion
// Ported from https://gist.github.com/jwoschitz/9a5195b36f0cc7d25455283923df083f
// US registrations N1–N99999 map to ICAO range A00001–ADF7C7.
// ---------------------------------------------------------------------------
const BASE9 = "123456789";
const BASE10 = "0123456789";
const BASE34 = "ABCDEFGHJKLMNPQRSTUVWXYZ0123456789"; // no I or O
const ICAO_OFFSET = 0xA00001;
const B1 = 101711; // block size per first digit
const B2 = 10111;  // block size per second digit

function encSuffix(suf: string): number {
  if (suf.length === 0) return 0;
  const r0 = BASE34.indexOf(suf[0]);
  const r1 = suf.length > 1 ? BASE34.indexOf(suf[1]) + 1 : 0;
  if (r0 < 24) return r0 * 25 + r1 + 1;  // letter first → base 25
  return r0 * 35 + r1 - 239;              // digit first → base 35
}

function nNumberToHex(tail: string): string | null {
  tail = tail.toUpperCase();
  if (!tail.startsWith("N") || tail.length < 2) return null;

  let icao = ICAO_OFFSET;
  const i1 = BASE9.indexOf(tail[1]);
  if (i1 === -1) return null;
  icao += i1 * B1;

  if (tail.length === 2) return icao.toString(16);

  const d2 = BASE10.indexOf(tail[2]);
  if (d2 === -1) {
    // Form N1A or N1AB
    icao += encSuffix(tail.substring(2, 4));
  } else {
    icao += d2 * B2 + 601;
    if (tail.length > 3) {
      const d3 = BASE10.indexOf(tail[3]);
      if (d3 > -1) {
        // Form N111, N111A, N111AB, N1111, N11111
        icao += d3 * 951 + 601;
        if (tail.length > 4) icao += encSuffix(tail.substring(4, 6));
      } else {
        // Form N11A or N11AB
        icao += encSuffix(tail.substring(3, 5));
      }
    }
  }
  return icao.toString(16);
}

// ---------------------------------------------------------------------------
// ADS-B fetch helpers
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function tryAdsbEndpoint(url: string): Promise<any | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) {
      console.warn(`[ADS-B] ${url} → HTTP ${res.status}`);
      return null;
    }
    const json = await res.json();
    const ac = json.ac?.[0];
    if (!ac || ac.lat == null || ac.lon == null) return null;
    return ac;
  } catch (err) {
    console.warn(`[ADS-B] ${url} → error:`, err instanceof Error ? err.message : err);
    return null;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toPosition(tail: string, ac: any): AircraftPosition {
  return {
    tail,
    lat: ac.lat,
    lon: ac.lon,
    alt_baro: typeof ac.alt_baro === "number" ? ac.alt_baro : null,
    gs: typeof ac.gs === "number" ? ac.gs : null,
    track: typeof ac.track === "number" ? ac.track : null,
    baro_rate: typeof ac.baro_rate === "number" ? ac.baro_rate : null,
    on_ground: ac.alt_baro === "ground" || ac.on_ground === true,
    squawk: ac.squawk ?? null,
    flight: ac.flight?.trim() ?? null,
    seen: typeof ac.seen === "number" ? ac.seen : null,
    hex: ac.hex ?? null,
    aircraft_type: ac.t ?? null,
    description: ac.desc ?? null,
  };
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

  const dbTails = [...new Set(
    (flights ?? [])
      .map((f) => f.tail_number as string | null)
      .filter((t): t is string => !!t),
  )];

  // Use DB tails if available, otherwise fall back to hardcoded fleet list
  const tails = dbTails.length > 0 ? dbTails : FALLBACK_TAILS;

  if (tails.length === 0) {
    return NextResponse.json({ aircraft: [], count: 0, cached: false });
  }

  // Quick connectivity probe — test one known-active hex to detect IP blocks
  let adsbReachable = false;
  try {
    const probe = await fetch(`${ADSB_API}/hex/a4eae7`, { signal: AbortSignal.timeout(5000) });
    adsbReachable = probe.ok;
    if (!probe.ok) console.warn(`[ADS-B] Probe failed: HTTP ${probe.status}`);
  } catch (err) {
    console.warn("[ADS-B] Probe error:", err instanceof Error ? err.message : err);
  }

  // Phase 1: Try hex lookups in small batches (most reliable strategy).
  // Pre-compute all ICAO hex codes and batch 5 at a time with delays.
  const positions: AircraftPosition[] = [];
  const foundTails = new Set<string>();
  const BATCH = 5;

  // Build hex→tail map
  const hexMap = new Map<string, string>();
  for (const tail of tails) {
    const hex = nNumberToHex(tail.replace(/-/g, ""));
    if (hex) hexMap.set(tail, hex);
  }

  const hexEntries = [...hexMap.entries()];
  for (let i = 0; i < hexEntries.length; i += BATCH) {
    const batch = hexEntries.slice(i, i + BATCH);
    const results = await Promise.all(
      batch.map(async ([tail, hex]) => {
        const ac = await tryAdsbEndpoint(`${ADSB_API}/hex/${hex}`);
        return ac ? toPosition(tail, ac) : null;
      }),
    );
    for (const r of results) {
      if (r) { positions.push(r); foundTails.add(r.tail); }
    }
    if (i + BATCH < hexEntries.length) {
      await new Promise((resolve) => setTimeout(resolve, 600));
    }
  }

  // Phase 2: For tails not found via hex, try reg then callsign (serialized).
  const missingTails = tails.filter((t) => !foundTails.has(t));
  for (const tail of missingTails) {
    const reg = tail.replace(/-/g, "");
    let ac = await tryAdsbEndpoint(`${ADSB_API}/reg/${reg}`);
    if (!ac) {
      const numMatch = reg.match(/^N(\d+)/i);
      if (numMatch) {
        ac = await tryAdsbEndpoint(`${ADSB_API}/callsign/KOW${numMatch[1]}`);
      }
    }
    if (ac) { positions.push(toPosition(tail, ac)); foundTails.add(tail); }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  cachedResult = { data: positions, ts: Date.now() };

  return NextResponse.json({
    aircraft: positions,
    count: positions.length,
    total_tails: tails.length,
    tails_queried: tails,
    source: dbTails.length > 0 ? "flights_db" : "fallback_trips",
    adsb_reachable: adsbReachable,
    cached: false,
  });
}
