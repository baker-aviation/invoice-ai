import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthed } from "@/lib/api-auth";
import { getFlightTrack, type FaTrackPoint } from "@/lib/flightaware";
import { getRedis } from "@/lib/redis";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// In-memory fallback cache
const memCache = new Map<string, { data: FaTrackPoint[]; ts: number }>();
const CACHE_TTL = 5 * 60_000;
const MAX_MEM_SIZE = 50;
const REDIS_TTL_SEC = 300;

const PAUSE_MS = 600; // pause between sequential FA calls (rate limit: 1 req/sec)

async function getCached(id: string): Promise<FaTrackPoint[] | null> {
  const redis = getRedis();
  if (redis) {
    try {
      const val = await redis.get<FaTrackPoint[]>(`track:${id}`);
      if (val) return val;
    } catch { /* fall through */ }
  }
  const mem = memCache.get(id);
  if (mem && Date.now() - mem.ts < CACHE_TTL) return mem.data;
  return null;
}

async function setCache(id: string, data: FaTrackPoint[]): Promise<void> {
  const redis = getRedis();
  if (redis) {
    try { await redis.set(`track:${id}`, data, { ex: REDIS_TTL_SEC }); } catch { /* ignore */ }
  }
  if (memCache.size >= MAX_MEM_SIZE) {
    const oldest = [...memCache.entries()].sort((a, b) => a[1].ts - b[1].ts)[0];
    if (oldest) memCache.delete(oldest[0]);
  }
  memCache.set(id, { data, ts: Date.now() });
}

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

    const cached = await getCached(id);
    if (cached) {
      tracks[id] = cached;
      cached_count++;
      continue;
    }

    if (fetched > 0) {
      await new Promise((r) => setTimeout(r, PAUSE_MS));
    }

    try {
      const positions = await getFlightTrack(id);
      tracks[id] = positions;
      fetched++;
      console.log(`[Tracks Batch] ${id}: ${positions.length} positions`);

      if (positions.length > 0) {
        await setCache(id, positions);
      }
    } catch (err) {
      console.error(`[Tracks Batch] ${id}: error`, err instanceof Error ? err.message : err);
      const stale = memCache.get(id);
      tracks[id] = stale?.data ?? [];
    }
  }

  console.log(`[Tracks Batch] Done: ${fetched} fetched, ${cached_count} cached`);
  return NextResponse.json({ tracks, fetched, cached: cached_count });
}
