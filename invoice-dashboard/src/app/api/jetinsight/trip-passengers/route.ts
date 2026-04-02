import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { requireAuth } from "@/lib/api-auth";

/**
 * GET /api/jetinsight/trip-passengers?trip_id=ABC123
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if ("error" in auth) return auth.error;

  const tripId = req.nextUrl.searchParams.get("trip_id");
  if (!tripId) {
    return NextResponse.json({ error: "trip_id required" }, { status: 400 });
  }

  const supa = createServiceClient();
  const { data } = await supa
    .from("jetinsight_trip_passengers")
    .select("passenger_name")
    .eq("jetinsight_trip_id", tripId)
    .order("passenger_name");

  return NextResponse.json({
    passengers: (data ?? []).map((r) => r.passenger_name),
  });
}
