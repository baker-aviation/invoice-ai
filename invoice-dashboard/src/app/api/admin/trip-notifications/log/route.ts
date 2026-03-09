import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, isRateLimited } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";

/**
 * GET /api/admin/trip-notifications/log
 *
 * Returns recent salesperson notification history joined with flight
 * and trip details so admins can troubleshoot delivery.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req);
  if ("error" in auth) return auth.error;
  if (isRateLimited(auth.userId, 10)) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const supa = createServiceClient();

  // Fetch recent notifications (last 7 days, newest first, cap at 100)
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const { data: notifications, error: notifErr } = await supa
    .from("salesperson_notifications_sent")
    .select("id, flight_id, trip_id, salesperson_name, sent_at")
    .gte("sent_at", since)
    .order("sent_at", { ascending: false })
    .limit(100);

  if (notifErr) {
    return NextResponse.json({ error: "Failed to query notifications", detail: notifErr.message }, { status: 500 });
  }

  if (!notifications || notifications.length === 0) {
    return NextResponse.json({ notifications: [] });
  }

  // Enrich with flight details
  const flightIds = [...new Set(notifications.map((n) => n.flight_id))];
  const { data: flights } = await supa
    .from("flights")
    .select("id, tail_number, departure_icao, arrival_icao, scheduled_departure, flight_type")
    .in("id", flightIds);

  const flightMap = new Map<string, (typeof flights extends (infer T)[] | null ? T : never)>();
  for (const f of flights ?? []) {
    flightMap.set(f.id, f);
  }

  // Enrich with trip salesperson details (customer info)
  const tripIds = [...new Set(notifications.map((n) => n.trip_id))];
  const { data: trips } = await supa
    .from("trip_salespersons")
    .select("trip_id, customer, tail_number, origin_icao, destination_icao")
    .in("trip_id", tripIds);

  const tripMap = new Map<string, (typeof trips extends (infer T)[] | null ? T : never)>();
  for (const t of trips ?? []) {
    tripMap.set(t.trip_id, t);
  }

  const enriched = notifications.map((n) => {
    const flight = flightMap.get(n.flight_id);
    const trip = tripMap.get(n.trip_id);
    return {
      id: n.id,
      salesperson_name: n.salesperson_name,
      sent_at: n.sent_at,
      tail_number: flight?.tail_number ?? trip?.tail_number ?? "—",
      departure_icao: flight?.departure_icao ?? trip?.origin_icao ?? "—",
      arrival_icao: flight?.arrival_icao ?? trip?.destination_icao ?? "—",
      scheduled_departure: flight?.scheduled_departure ?? null,
      flight_type: flight?.flight_type ?? null,
      customer: trip?.customer ?? null,
      trip_id: n.trip_id,
    };
  });

  return NextResponse.json({ notifications: enriched });
}
