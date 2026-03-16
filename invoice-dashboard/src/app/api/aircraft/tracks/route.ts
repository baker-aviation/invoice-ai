import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthed } from "@/lib/api-auth";
import { getFlightTrack, type FaTrackPoint } from "@/lib/flightaware";

export const dynamic = "force-dynamic";

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

  const tracks: Record<string, FaTrackPoint[]> = {};
  let fetched = 0;

  for (let i = 0; i < flightIds.length; i++) {
    const id = flightIds[i];

    // Return cache if fresh
    const cached = cache.get(id);
    if (cached && Date.now() - cached.ts < CACHE_TTL) {
      tracks[id] = cached.data;
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

      // Only cache non-empty results
      if (positions.length > 0) {
        if (cache.size >= MAX_CACHE_SIZE) {
          const oldest = [...cache.entries()].sort((a, b) => a[1].ts - b[1].ts)[0];
          if (oldest) cache.delete(oldest[0]);
        }
        cache.set(id, { data: positions, ts: Date.now() });
      }
    } catch {
      tracks[id] = cached?.data ?? [];
    }
  }

  return NextResponse.json({ tracks, fetched });
}
