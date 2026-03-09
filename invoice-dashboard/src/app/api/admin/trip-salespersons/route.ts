import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthed } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";

/**
 * GET /api/admin/trip-salespersons
 *
 * Returns all trip-salesperson mappings for the ops display.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;

  const supa = createServiceClient();
  const { data, error } = await supa
    .from("trip_salespersons")
    .select("trip_id, tail_number, scheduled_departure, scheduled_arrival, origin_icao, destination_icao, salesperson_name, customer")
    .order("scheduled_departure", { ascending: false });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ trips: data ?? [] });
}
