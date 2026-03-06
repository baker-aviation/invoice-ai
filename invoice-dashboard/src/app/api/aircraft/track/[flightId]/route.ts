import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthed } from "@/lib/api-auth";
import { getFlightTrack, type FaTrackPoint } from "@/lib/flightaware";

export const dynamic = "force-dynamic";

// Cache: 60 seconds
let cache: { data: FaTrackPoint[]; flightId: string; ts: number } | null =
  null;
const CACHE_TTL = 60_000;

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

  // Return cache if fresh and same flightId
  if (
    cache &&
    cache.flightId === flightId &&
    Date.now() - cache.ts < CACHE_TTL
  ) {
    return NextResponse.json({ positions: cache.data, cached: true });
  }

  try {
    const positions = await getFlightTrack(flightId);
    cache = { data: positions, flightId, ts: Date.now() };
    return NextResponse.json({ positions, cached: false });
  } catch {
    return NextResponse.json({
      positions: cache?.flightId === flightId ? cache.data : [],
      error: "FlightAware track query failed",
      cached: true,
    });
  }
}
