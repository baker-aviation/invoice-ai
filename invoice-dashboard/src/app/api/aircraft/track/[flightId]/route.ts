import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthed } from "@/lib/api-auth";
import { getFlightTrack, type FaTrackPoint } from "@/lib/flightaware";
import { getRedis } from "@/lib/redis";

export const dynamic = "force-dynamic";

// In-memory fallback cache (used when Redis is unavailable)
const memCache = new Map<string, { data: FaTrackPoint[]; ts: number }>();
const CACHE_TTL = 5 * 60_000;
const MAX_MEM_SIZE = 30;
const REDIS_TTL_SEC = 300; // 5 minutes

async function getCached(flightId: string): Promise<FaTrackPoint[] | null> {
  const redis = getRedis();
  if (redis) {
    try {
      const val = await redis.get<FaTrackPoint[]>(`track:${flightId}`);
      if (val) return val;
    } catch { /* fall through to memory */ }
  }
  const mem = memCache.get(flightId);
  if (mem && Date.now() - mem.ts < CACHE_TTL) return mem.data;
  return null;
}

async function setCache(flightId: string, data: FaTrackPoint[]): Promise<void> {
  const redis = getRedis();
  if (redis) {
    try { await redis.set(`track:${flightId}`, data, { ex: REDIS_TTL_SEC }); } catch { /* ignore */ }
  }
  // Always update memory cache as local fallback
  if (memCache.size >= MAX_MEM_SIZE) {
    const oldest = [...memCache.entries()].sort((a, b) => a[1].ts - b[1].ts)[0];
    if (oldest) memCache.delete(oldest[0]);
  }
  memCache.set(flightId, { data, ts: Date.now() });
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ flightId: string }> },
) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;

  const { flightId } = await params;

  if (!process.env.FLIGHTAWARE_API_KEY) {
    return NextResponse.json({
      positions: [],
      error: "FLIGHTAWARE_API_KEY not configured",
    });
  }

  // Return cache if fresh
  const cached = await getCached(flightId);
  if (cached) {
    return NextResponse.json({ positions: cached, cached: true });
  }

  try {
    const positions = await getFlightTrack(flightId);
    if (positions.length > 0) {
      await setCache(flightId, positions);
    }
    return NextResponse.json({ positions, cached: false });
  } catch {
    // On error, try to return stale memory cache
    const stale = memCache.get(flightId);
    return NextResponse.json({
      positions: stale?.data ?? [],
      error: "FlightAware track query failed",
      cached: true,
    });
  }
}
