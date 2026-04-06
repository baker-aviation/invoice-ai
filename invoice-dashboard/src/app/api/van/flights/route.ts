import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";

export const dynamic = "force-dynamic";

/**
 * GET /api/van/flights
 *
 * Public (no user auth) endpoint for the van driver page to refresh flights.
 * Returns flights within -12h to +36h, plus any extra flights specified by
 * `published_ids` query param (comma-separated flight IDs for backfilling
 * overnight arrivals from a published schedule).
 */
export async function GET(req: NextRequest) {
  const supa = createServiceClient();
  const now = new Date();
  const past = new Date(now.getTime() - 12 * 60 * 60 * 1000).toISOString();
  const future = new Date(now.getTime() + 36 * 60 * 60 * 1000).toISOString();

  const { data: flights } = await supa
    .from("flights")
    .select("id, tail_number, departure_icao, arrival_icao, scheduled_departure, scheduled_arrival, flight_type, status")
    .gte("scheduled_departure", past)
    .lte("scheduled_departure", future)
    .order("scheduled_departure", { ascending: true });

  const allFlights = flights ?? [];

  // Backfill published flight IDs that fall outside the time window
  const publishedIdsParam = req.nextUrl.searchParams.get("published_ids");
  if (publishedIdsParam) {
    const publishedIds = publishedIdsParam.split(",").filter(Boolean);
    const loadedIds = new Set(allFlights.map((f: any) => f.id));
    const missingIds = publishedIds.filter(
      (id) => !loadedIds.has(id) && !id.startsWith("unsched_"),
    );
    if (missingIds.length > 0) {
      const { data: extra } = await supa
        .from("flights")
        .select("id, tail_number, departure_icao, arrival_icao, scheduled_departure, scheduled_arrival, flight_type, status")
        .in("id", missingIds);
      if (extra) allFlights.push(...extra);
    }
  }

  return NextResponse.json({ flights: allFlights });
}
