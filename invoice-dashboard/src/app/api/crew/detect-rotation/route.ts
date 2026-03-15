import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, isAuthed } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";
import { detectCurrentRotation } from "@/lib/crewRotationDetect";
import type { CrewMember, FlightLeg } from "@/lib/swapOptimizer";

export const dynamic = "force-dynamic";

/**
 * GET /api/crew/detect-rotation?date=2026-03-18
 *
 * Auto-detect offgoing/oncoming rotation from JetInsight flight data.
 * Scans flights in the 4 days before the swap date to identify who's
 * currently flying each tail.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (!isAuthed(auth)) return auth.error;

  const date = req.nextUrl.searchParams.get("date");
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return NextResponse.json({ error: "date query param required (YYYY-MM-DD)" }, { status: 400 });
  }

  const supa = createServiceClient();

  // Fetch flights ±4 days around swap date
  const swapDay = new Date(date);
  const start = new Date(swapDay.getTime() - 4 * 24 * 60 * 60 * 1000).toISOString();
  const end = new Date(swapDay.getTime() + 3 * 24 * 60 * 60 * 1000).toISOString();

  const [flightsRes, crewRes] = await Promise.all([
    supa
      .from("flights")
      .select("id, tail_number, departure_icao, arrival_icao, scheduled_departure, scheduled_arrival, flight_type, pic, sic")
      .gte("scheduled_departure", start)
      .lte("scheduled_departure", end)
      .order("scheduled_departure"),
    supa.from("crew_members").select("*").eq("active", true),
  ]);

  if (flightsRes.error) {
    return NextResponse.json({ error: flightsRes.error.message }, { status: 500 });
  }
  if (crewRes.error) {
    return NextResponse.json({ error: crewRes.error.message }, { status: 500 });
  }

  const flights: FlightLeg[] = (flightsRes.data ?? []).map((f) => ({
    id: f.id as string,
    tail_number: f.tail_number as string,
    departure_icao: f.departure_icao as string,
    arrival_icao: f.arrival_icao as string,
    scheduled_departure: f.scheduled_departure as string,
    scheduled_arrival: f.scheduled_arrival as string | null,
    flight_type: f.flight_type as string | null,
    pic: f.pic as string | null,
    sic: f.sic as string | null,
  }));

  const crewRoster: CrewMember[] = (crewRes.data ?? []).map((c) => ({
    id: c.id as string,
    name: c.name as string,
    role: c.role as "PIC" | "SIC",
    home_airports: (c.home_airports as string[]) ?? [],
    aircraft_types: (c.aircraft_types as string[]) ?? [],
    is_checkairman: (c.is_checkairman as boolean) ?? false,
    is_skillbridge: (c.is_skillbridge as boolean) ?? false,
    priority: (c.priority as number) ?? 0,
    rotation_group: (c.rotation_group as "A" | "B" | null) ?? null,
  }));

  const result = detectCurrentRotation(flights, crewRoster, date);

  return NextResponse.json({
    ok: true,
    swap_date: date,
    ...result,
  });
}
