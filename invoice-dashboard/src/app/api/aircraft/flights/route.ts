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
// 10 min during business hours (7AM–11PM CT), 20 min overnight
function getCacheTtl(): number {
  const ct = new Date().toLocaleString("en-US", { timeZone: "America/Chicago", hour: "numeric", hour12: false });
  const hour = parseInt(ct, 10);
  return (hour >= 7 && hour < 23) ? 600_000 : 1_200_000;
}

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

  // Return cache if fresh (unless ?refresh=true)
  const forceRefresh = req.nextUrl.searchParams.get("refresh") === "true";
  if (!forceRefresh && cachedResult && Date.now() - cachedResult.ts < getCacheTtl()) {
    return NextResponse.json({
      flights: cachedResult.data,
      count: cachedResult.data.length,
      cached: true,
      cached_at: new Date(cachedResult.ts).toISOString(),
      cache_age_s: Math.round((Date.now() - cachedResult.ts) / 1000),
    });
  }

  // Get tail numbers (same logic as positions route)
  const supa = createServiceClient();
  const now = new Date();
  const past = new Date(now.getTime() - 48 * 60 * 60 * 1000).toISOString();
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
      cached_at: new Date(cachedResult!.ts).toISOString(),
      cache_age_s: 0,
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
