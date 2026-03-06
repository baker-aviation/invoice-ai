import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthed } from "@/lib/api-auth";
import { getActiveFlights, type FlightInfo } from "@/lib/flightaware";
import { TRIPS } from "@/lib/maintenanceData";
import { createServiceClient } from "@/lib/supabase/service";

export const dynamic = "force-dynamic";

// Fallback tail numbers
const FALLBACK_TAILS = [...new Set(TRIPS.map((t) => t.tail))];

// Cache: FlightAware data changes slowly — cache 2 minutes
let cachedResult: { data: FlightInfo[]; ts: number } | null = null;
const CACHE_TTL_MS = 600_000; // 10 minutes

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;

  // Check if FlightAware is configured
  if (!process.env.FLIGHTAWARE_API_KEY) {
    return NextResponse.json({
      flights: [],
      count: 0,
      error: "FLIGHTAWARE_API_KEY not configured",
    });
  }

  // Return cache if fresh
  if (cachedResult && Date.now() - cachedResult.ts < CACHE_TTL_MS) {
    return NextResponse.json({
      flights: cachedResult.data,
      count: cachedResult.data.length,
      cached: true,
    });
  }

  // Get tail numbers (same logic as positions route)
  const supa = createServiceClient();
  const now = new Date();
  const past = new Date(now.getTime() - 12 * 60 * 60 * 1000).toISOString();
  const future = new Date(now.getTime() + 48 * 60 * 60 * 1000).toISOString();

  const { data: dbFlights } = await supa
    .from("flights")
    .select("tail_number")
    .gte("scheduled_departure", past)
    .lte("scheduled_departure", future);

  const dbTails = [...new Set(
    (dbFlights ?? [])
      .map((f) => f.tail_number as string | null)
      .filter((t): t is string => !!t),
  )];

  const tails = dbTails.length > 0 ? dbTails : FALLBACK_TAILS;

  try {
    const flights = await getActiveFlights(tails);
    cachedResult = { data: flights, ts: Date.now() };

    return NextResponse.json({
      flights,
      count: flights.length,
      total_tails: tails.length,
      cached: false,
    });
  } catch (err) {
    return NextResponse.json({
      flights: cachedResult?.data ?? [],
      count: cachedResult?.data.length ?? 0,
      error: "FlightAware query failed",
      cached: true,
    });
  }
}
