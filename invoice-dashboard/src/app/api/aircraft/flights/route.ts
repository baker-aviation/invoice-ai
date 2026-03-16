import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthed } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";
import type { FlightInfo } from "@/lib/flightaware";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;

  const supabase = createServiceClient();
  const cutoff = new Date(Date.now() - 36 * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from("fa_flights")
    .select("*")
    .gt("updated_at", cutoff)
    .order("departure_time", { ascending: true, nullsFirst: false });

  if (error) {
    console.error("[Flights] fa_flights query failed:", error);
    return NextResponse.json(
      { error: "Failed to query flights", detail: error.message },
      { status: 500 },
    );
  }

  const flights: FlightInfo[] = (data ?? []).map((row) => ({
    tail: row.tail,
    ident: row.ident,
    fa_flight_id: row.fa_flight_id,
    origin_icao: row.origin_icao,
    origin_name: row.origin_name,
    destination_icao: row.destination_icao,
    destination_name: row.destination_name,
    status: row.status,
    progress_percent: row.progress_percent,
    departure_time: row.departure_time ? new Date(row.departure_time).toISOString() : null,
    arrival_time: row.arrival_time ? new Date(row.arrival_time).toISOString() : null,
    scheduled_arrival: row.scheduled_arrival ? new Date(row.scheduled_arrival).toISOString() : null,
    actual_departure: row.actual_departure ? new Date(row.actual_departure).toISOString() : null,
    actual_arrival: row.actual_arrival ? new Date(row.actual_arrival).toISOString() : null,
    route: row.route,
    route_distance_nm: row.route_distance_nm,
    filed_altitude: row.filed_altitude,
    diverted: row.diverted ?? false,
    cancelled: row.cancelled ?? false,
    aircraft_type: row.aircraft_type,
    latitude: row.latitude,
    longitude: row.longitude,
    altitude: row.altitude,
    groundspeed: row.groundspeed,
    heading: row.heading,
  }));

  return NextResponse.json({ flights, count: flights.length, cached: false });
}
