import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { requireAuth } from "@/lib/api-auth";

/**
 * GET /api/pilots/[id]/flight-stats — Aggregate flight stats for a pilot
 * Queries post_flight_data + flights by pilot name.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAuth(req);
  if ("error" in auth) return auth.error;

  const { id } = await params;
  const supa = createServiceClient();

  // Get pilot name for matching
  const { data: pilot } = await supa
    .from("pilot_profiles")
    .select("full_name, role, crew_member_id")
    .eq("id", id)
    .single();

  if (!pilot?.full_name) {
    return NextResponse.json({ error: "Pilot not found" }, { status: 404 });
  }

  const name = pilot.full_name;

  // Also get crew_members name variants for matching
  let crewName: string | null = null;
  if (pilot.crew_member_id) {
    const { data: crew } = await supa
      .from("crew_members")
      .select("name")
      .eq("id", pilot.crew_member_id)
      .single();
    crewName = crew?.name ?? null;
  }

  // Names to match against (pilot_profiles full_name + crew_members name)
  const names = [name];
  if (crewName && crewName !== name) names.push(crewName);

  // Query post_flight_data for all matches (as PIC or SIC)
  const { data: picFlights } = await supa
    .from("post_flight_data")
    .select(
      "flight_date, aircraft_type, origin, destination, flight_hrs, block_hrs, fuel_burn_lbs, fuel_burn_lbs_hour, takeoff_wt_lbs, pax, nautical_miles, tail_number",
    )
    .in("pic", names)
    .order("flight_date", { ascending: false });

  const { data: sicFlights } = await supa
    .from("post_flight_data")
    .select(
      "flight_date, aircraft_type, origin, destination, flight_hrs, block_hrs, fuel_burn_lbs, fuel_burn_lbs_hour, takeoff_wt_lbs, pax, nautical_miles, tail_number",
    )
    .in("sic", names)
    .order("flight_date", { ascending: false });

  const pic = picFlights ?? [];
  const sic = sicFlights ?? [];
  const all = [...pic, ...sic];

  // Aggregate stats
  const totalFlightHrsPic = pic.reduce((s, f) => s + (f.flight_hrs ?? 0), 0);
  const totalFlightHrsSic = sic.reduce((s, f) => s + (f.flight_hrs ?? 0), 0);
  const totalBlockHrs = all.reduce((s, f) => s + (f.block_hrs ?? 0), 0);
  const totalNauticalMiles = all.reduce(
    (s, f) => s + (f.nautical_miles ?? 0),
    0,
  );
  const totalPax = all.reduce((s, f) => s + (f.pax ?? 0), 0);
  const totalFuelBurn = all.reduce((s, f) => s + (f.fuel_burn_lbs ?? 0), 0);

  // Aircraft types flown
  const typeSet = new Set(all.map((f) => f.aircraft_type).filter(Boolean));

  // Monthly breakdown (last 6 months)
  const monthlyMap = new Map<string, { picHrs: number; sicHrs: number; flights: number }>();
  for (const f of pic) {
    const month = f.flight_date?.slice(0, 7); // YYYY-MM
    if (!month) continue;
    const entry = monthlyMap.get(month) ?? { picHrs: 0, sicHrs: 0, flights: 0 };
    entry.picHrs += f.flight_hrs ?? 0;
    entry.flights++;
    monthlyMap.set(month, entry);
  }
  for (const f of sic) {
    const month = f.flight_date?.slice(0, 7);
    if (!month) continue;
    const entry = monthlyMap.get(month) ?? { picHrs: 0, sicHrs: 0, flights: 0 };
    entry.sicHrs += f.flight_hrs ?? 0;
    entry.flights++;
    monthlyMap.set(month, entry);
  }

  const monthly = [...monthlyMap.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .slice(0, 6)
    .map(([month, data]) => ({ month, ...data }));

  // Recent flights (last 20)
  const recent = all
    .sort(
      (a, b) =>
        new Date(b.flight_date).getTime() - new Date(a.flight_date).getTime(),
    )
    .slice(0, 20)
    .map((f) => ({
      date: f.flight_date,
      tail: f.tail_number,
      type: f.aircraft_type,
      route: `${f.origin} - ${f.destination}`,
      flightHrs: f.flight_hrs,
      fuelBurn: f.fuel_burn_lbs,
      burnRate: f.fuel_burn_lbs_hour,
      pax: f.pax,
      asPic: pic.includes(f),
    }));

  // Average fuel burn rate per aircraft type (this pilot)
  const burnByType = new Map<string, { total: number; count: number }>();
  for (const f of all) {
    if (!f.fuel_burn_lbs_hour || !f.aircraft_type) continue;
    const entry = burnByType.get(f.aircraft_type) ?? { total: 0, count: 0 };
    entry.total += f.fuel_burn_lbs_hour;
    entry.count++;
    burnByType.set(f.aircraft_type, entry);
  }
  const avgBurnByType = [...burnByType.entries()].map(([type, { total, count }]) => ({
    type,
    avgBurnRate: Math.round(total / count),
  }));

  return NextResponse.json({
    stats: {
      totalFlights: all.length,
      flightsAsPic: pic.length,
      flightsAsSic: sic.length,
      totalFlightHrs: Math.round((totalFlightHrsPic + totalFlightHrsSic) * 10) / 10,
      picHrs: Math.round(totalFlightHrsPic * 10) / 10,
      sicHrs: Math.round(totalFlightHrsSic * 10) / 10,
      totalBlockHrs: Math.round(totalBlockHrs * 10) / 10,
      totalNauticalMiles: Math.round(totalNauticalMiles),
      totalPax,
      totalFuelBurn: Math.round(totalFuelBurn),
      aircraftTypes: [...typeSet],
      avgBurnByType,
      dateRange: {
        first: all.length > 0 ? all[all.length - 1].flight_date : null,
        last: all.length > 0 ? all[0].flight_date : null,
      },
    },
    monthly,
    recentFlights: recent,
  });
}
