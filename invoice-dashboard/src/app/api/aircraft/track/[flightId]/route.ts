import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthed } from "@/lib/api-auth";
import { getFlightTrack, type FaTrackPoint } from "@/lib/flightaware";

export const dynamic = "force-dynamic";

// Cache: 15 minutes per flight, keyed by flightId (reduced FA API costs)
const cache = new Map<string, { data: FaTrackPoint[]; ts: number }>();
const CACHE_TTL = 15 * 60_000;
const MAX_CACHE_SIZE = 30;

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
  const cached = cache.get(flightId);
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    return NextResponse.json({ positions: cached.data, cached: true });
  }

  try {
    const positions = await getFlightTrack(flightId);
    // Evict oldest entries if cache is full
    if (cache.size >= MAX_CACHE_SIZE) {
      const oldest = [...cache.entries()].sort((a, b) => a[1].ts - b[1].ts)[0];
      if (oldest) cache.delete(oldest[0]);
    }
    cache.set(flightId, { data: positions, ts: Date.now() });
    return NextResponse.json({ positions, cached: false });
  } catch {
    return NextResponse.json({
      positions: cached?.data ?? [],
      error: "FlightAware track query failed",
      cached: true,
    });
  }
}
