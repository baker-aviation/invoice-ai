import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthed } from "@/lib/api-auth";
import { getFlightTrack, type FaTrackPoint } from "@/lib/flightaware";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Shared cache with single-flight endpoint (module-level, survives warm starts)
const cache = new Map<string, { data: FaTrackPoint[]; ts: number }>();
const CACHE_TTL = 5 * 60_000;
const MAX_CACHE_SIZE = 50;

const PAUSE_MS = 600; // pause between sequential FA calls (rate limit: 1 req/sec)

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;

  if (!process.env.FLIGHTAWARE_API_KEY) {
    return NextResponse.json({
      tracks: {},
      error: "FLIGHTAWARE_API_KEY not configured",
    });
  }

  const body = await req.json();
  const flightIds: string[] = body.flightIds ?? [];

  if (flightIds.length === 0 || flightIds.length > 30) {
    return NextResponse.json({
      tracks: {},
      error: flightIds.length === 0 ? "No flight IDs" : "Too many flight IDs",
    });
  }

  console.log(`[Tracks Batch] Received ${flightIds.length} flight IDs`);
  const tracks: Record<string, FaTrackPoint[]> = {};
  let fetched = 0;
  let cached_count = 0;

  for (let i = 0; i < flightIds.length; i++) {
    const id = flightIds[i];

    // Return cache if fresh
    const cachedEntry = cache.get(id);
    if (cachedEntry && Date.now() - cachedEntry.ts < CACHE_TTL) {
      tracks[id] = cachedEntry.data;
      cached_count++;
      continue;
    }

    // Rate-limit pause between actual FA API calls
    if (fetched > 0) {
      await new Promise((r) => setTimeout(r, PAUSE_MS));
    }

    try {
      const positions = await getFlightTrack(id);
      tracks[id] = positions;
      fetched++;
      console.log(`[Tracks Batch] ${id}: ${positions.length} positions`);

      // Only cache non-empty results
      if (positions.length > 0) {
        if (cache.size >= MAX_CACHE_SIZE) {
          const oldest = [...cache.entries()].sort((a, b) => a[1].ts - b[1].ts)[0];
          if (oldest) cache.delete(oldest[0]);
        }
        cache.set(id, { data: positions, ts: Date.now() });
      }
    } catch (err) {
      console.error(`[Tracks Batch] ${id}: error`, err instanceof Error ? err.message : err);
      tracks[id] = cachedEntry?.data ?? [];
    }
  }

  console.log(`[Tracks Batch] Done: ${fetched} fetched, ${cached_count} cached`);
  return NextResponse.json({ tracks, fetched, cached: cached_count });
}
