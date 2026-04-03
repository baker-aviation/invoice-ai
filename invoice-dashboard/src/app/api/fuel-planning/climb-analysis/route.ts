import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { requireAuth } from "@/lib/api-auth";

/**
 * GET /api/fuel-planning/climb-analysis
 * Returns flight phase data (climb/cruise/descent) joined with pilot and fuel data.
 * Used for analyzing climb efficiency per pilot.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if ("error" in auth) return auth.error;

  const months = Number(req.nextUrl.searchParams.get("months")) || 3;
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - months);
  const cutoffStr = cutoff.toISOString().split("T")[0];

  const supa = createServiceClient();

  // Fetch flight phases joined with predictions
  const { data: phases } = await supa
    .from("foreflight_flight_phases")
    .select(`
      foreflight_id, climb_min, cruise_min, descent_min, total_min,
      climb_pct, cruise_pct, descent_pct,
      initial_alt_fl, max_alt_fl, final_cruise_fl, step_climbs, cruise_profile,
      foreflight_predictions!inner (
        tail_number, departure_icao, destination_icao, flight_date,
        fuel_to_dest_lbs, flight_fuel_lbs, total_fuel_lbs,
        takeoff_weight, time_to_dest_min, route_nm, wind_component
      )
    `)
    .gte("foreflight_predictions.flight_date", cutoffStr);

  // Fetch post-flight actuals to match
  const { data: actuals } = await supa
    .from("post_flight_data")
    .select("pic, sic, aircraft_type, origin, destination, flight_date, tail_number, flight_hrs, fuel_burn_lbs, fuel_start_lbs, fuel_end_lbs, takeoff_wt_lbs, nautical_miles")
    .gte("flight_date", cutoffStr);

  if (!phases?.length) {
    return NextResponse.json({ pilots: [], fleetStats: null, message: "No flight phase data. Run 'Pull ForeFlight Plans' first." });
  }

  // Build actual lookup
  const actualMap = new Map<string, {
    pic: string; type: string; hrs: number; burn: number; startFuel: number; endFuel: number; tow: number;
  }>();
  for (const a of actuals ?? []) {
    if (!a.pic || !a.flight_hrs || !a.fuel_burn_lbs) continue;
    const dep = (a.origin ?? "").replace(/^K/, "");
    const dest = (a.destination ?? "").replace(/^K/, "");
    const key = `${a.tail_number}:${dep}:${dest}:${a.flight_date}`;
    actualMap.set(key, {
      pic: a.pic, type: a.aircraft_type, hrs: a.flight_hrs,
      burn: a.fuel_burn_lbs, startFuel: a.fuel_start_lbs ?? 0,
      endFuel: a.fuel_end_lbs ?? 0, tow: a.takeoff_wt_lbs ?? 0,
    });
  }

  // Match phases to actuals by pilot
  type PilotPhase = {
    climbMin: number; cruiseMin: number; descentMin: number; totalMin: number;
    climbPct: number; initialAlt: number; maxAlt: number; stepClimbs: number;
    cruiseProfile: string; ffBurn: number; actualBurn: number; actualHrs: number;
    route: string; date: string; tail: string; type: string; routeNm: number;
  };

  const pilotData = new Map<string, PilotPhase[]>();

  for (const p of phases) {
    const pred = (p as Record<string, unknown>).foreflight_predictions as Record<string, unknown>;
    if (!pred) continue;

    const dep = ((pred.departure_icao as string) ?? "").replace(/^K/, "");
    const dest = ((pred.destination_icao as string) ?? "").replace(/^K/, "");
    const key = `${pred.tail_number}:${dep}:${dest}:${pred.flight_date}`;
    const actual = actualMap.get(key);
    if (!actual) continue;

    const existing = pilotData.get(actual.pic) ?? [];
    existing.push({
      climbMin: Number(p.climb_min) || 0,
      cruiseMin: Number(p.cruise_min) || 0,
      descentMin: Number(p.descent_min) || 0,
      totalMin: Number(p.total_min) || 0,
      climbPct: Number(p.climb_pct) || 0,
      initialAlt: p.initial_alt_fl ?? 0,
      maxAlt: p.max_alt_fl ?? 0,
      stepClimbs: p.step_climbs ?? 0,
      cruiseProfile: p.cruise_profile ?? "",
      ffBurn: Number(pred.fuel_to_dest_lbs) || 0,
      actualBurn: actual.burn,
      actualHrs: actual.hrs,
      route: `${pred.departure_icao}-${pred.destination_icao}`,
      date: pred.flight_date as string,
      tail: pred.tail_number as string,
      type: actual.type,
      routeNm: Number(pred.route_nm) || 0,
    });
    pilotData.set(actual.pic, existing);
  }

  // Aggregate per pilot
  const pilots = [...pilotData.entries()]
    .filter(([, flights]) => flights.length >= 3)
    .map(([name, flights]) => {
      const n = flights.length;
      const avgClimbMin = flights.reduce((s, f) => s + f.climbMin, 0) / n;
      const avgCruiseMin = flights.reduce((s, f) => s + f.cruiseMin, 0) / n;
      const avgDescentMin = flights.reduce((s, f) => s + f.descentMin, 0) / n;
      const avgClimbPct = flights.reduce((s, f) => s + f.climbPct, 0) / n;
      const avgInitialAlt = flights.reduce((s, f) => s + f.initialAlt, 0) / n;
      const avgMaxAlt = flights.reduce((s, f) => s + f.maxAlt, 0) / n;
      const totalStepClimbs = flights.reduce((s, f) => s + f.stepClimbs, 0);
      const avgBurnRate = flights.reduce((s, f) => s + f.actualBurn, 0) / flights.reduce((s, f) => s + f.actualHrs, 0);
      const totalFfBurn = flights.reduce((s, f) => s + f.ffBurn, 0);
      const totalActualBurn = flights.reduce((s, f) => s + f.actualBurn, 0);
      const ffVariance = totalFfBurn > 0 ? Math.round(((totalActualBurn - totalFfBurn) / totalFfBurn) * 100) : 0;

      // Climb efficiency: burn rate on flights with high climb % vs low climb %
      const highClimb = flights.filter((f) => f.climbPct > 15);
      const lowClimb = flights.filter((f) => f.climbPct <= 15 && f.totalMin > 60);
      const highClimbRate = highClimb.length > 0
        ? highClimb.reduce((s, f) => s + f.actualBurn, 0) / highClimb.reduce((s, f) => s + f.actualHrs, 0)
        : null;
      const lowClimbRate = lowClimb.length > 0
        ? lowClimb.reduce((s, f) => s + f.actualBurn, 0) / lowClimb.reduce((s, f) => s + f.actualHrs, 0)
        : null;

      return {
        name,
        flights: n,
        avgClimbMin: Math.round(avgClimbMin * 10) / 10,
        avgCruiseMin: Math.round(avgCruiseMin * 10) / 10,
        avgDescentMin: Math.round(avgDescentMin * 10) / 10,
        avgClimbPct: Math.round(avgClimbPct * 10) / 10,
        avgInitialAlt: Math.round(avgInitialAlt),
        avgMaxAlt: Math.round(avgMaxAlt),
        totalStepClimbs,
        avgBurnRate: Math.round(avgBurnRate),
        ffVariance,
        highClimbRate: highClimbRate ? Math.round(highClimbRate) : null,
        lowClimbRate: lowClimbRate ? Math.round(lowClimbRate) : null,
        recentFlights: flights.slice(0, 20).map((f) => ({
          ...f,
          climbMin: Math.round(f.climbMin * 10) / 10,
          cruiseMin: Math.round(f.cruiseMin * 10) / 10,
          descentMin: Math.round(f.descentMin * 10) / 10,
          burnRate: f.actualHrs > 0 ? Math.round(f.actualBurn / f.actualHrs) : 0,
          ffVariance: f.ffBurn > 0 ? Math.round(((f.actualBurn - f.ffBurn) / f.ffBurn) * 100) : 0,
        })),
      };
    })
    .sort((a, b) => b.avgClimbPct - a.avgClimbPct);

  // Fleet-wide stats
  const allFlights = [...pilotData.values()].flat();
  const fleetStats = {
    totalFlights: allFlights.length,
    avgClimbMin: Math.round(allFlights.reduce((s, f) => s + f.climbMin, 0) / allFlights.length * 10) / 10,
    avgClimbPct: Math.round(allFlights.reduce((s, f) => s + f.climbPct, 0) / allFlights.length * 10) / 10,
    avgInitialAlt: Math.round(allFlights.reduce((s, f) => s + f.initialAlt, 0) / allFlights.length),
    avgMaxAlt: Math.round(allFlights.reduce((s, f) => s + f.maxAlt, 0) / allFlights.length),
  };

  return NextResponse.json({ pilots, fleetStats });
}
