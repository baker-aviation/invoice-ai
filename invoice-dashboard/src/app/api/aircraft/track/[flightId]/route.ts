import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthed } from "@/lib/api-auth";
import { getFlightTrack, type FaTrackPoint } from "@/lib/flightaware";

export const dynamic = "force-dynamic";

// Cache multiple flights, 5-minute TTL (tracks don't change fast)
const trackCache = new Map<string, { data: FaTrackPoint[]; ts: number }>();
const CACHE_TTL = 5 * 60_000;
const MAX_ENTRIES = 30;

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
  const cached = trackCache.get(flightId);
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    return NextResponse.json({ positions: cached.data, cached: true });
  }

  try {
    const positions = await getFlightTrack(flightId);
    trackCache.set(flightId, { data: positions, ts: Date.now() });
    // Evict old entries if cache grows too large
    if (trackCache.size > MAX_ENTRIES) {
      const oldest = [...trackCache.entries()].sort((a, b) => a[1].ts - b[1].ts)[0];
      if (oldest) trackCache.delete(oldest[0]);
    }
    return NextResponse.json({ positions, cached: false });
  } catch {
    return NextResponse.json({
      positions: cached?.data ?? [],
      error: "FlightAware track query failed",
      cached: true,
    });
  }
}
