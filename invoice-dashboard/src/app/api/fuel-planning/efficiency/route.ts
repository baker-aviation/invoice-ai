import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { requireAuth } from "@/lib/api-auth";

/**
 * GET /api/fuel-planning/efficiency — Fuel efficiency analysis per pilot
 * Compares each pilot's burn rate to fleet average by aircraft type.
 * Flags pilots who consistently burn above average.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if ("error" in auth) return auth.error;

  const months = Number(req.nextUrl.searchParams.get("months")) || 3;
  const cutoffDate = new Date();
  cutoffDate.setMonth(cutoffDate.getMonth() - months);

  const supa = createServiceClient();

  // Fetch all post-flight data within the date range
  const { data: flights } = await supa
    .from("post_flight_data")
    .select(
      "pic, aircraft_type, origin, destination, flight_hrs, fuel_burn_lbs, fuel_burn_lbs_hour, takeoff_wt_lbs, fuel_start_lbs, fuel_end_lbs, flight_date, tail_number, nautical_miles",
    )
    .gte("flight_date", cutoffDate.toISOString().split("T")[0])
    .not("pic", "is", null)
    .not("fuel_burn_lbs_hour", "is", null)
    .gt("fuel_burn_lbs_hour", 0)
    .order("flight_date", { ascending: false });

  if (!flights || flights.length === 0) {
    return NextResponse.json({ pilots: [], fleetAvg: {}, totalFlights: 0 });
  }

  // Compute fleet average burn rate per aircraft type
  const fleetByType = new Map<
    string,
    { totalBurn: number; totalHrs: number; count: number }
  >();

  for (const f of flights) {
    if (!f.aircraft_type || !f.fuel_burn_lbs_hour) continue;
    const entry = fleetByType.get(f.aircraft_type) ?? {
      totalBurn: 0,
      totalHrs: 0,
      count: 0,
    };
    entry.totalBurn += f.fuel_burn_lbs ?? 0;
    entry.totalHrs += f.flight_hrs ?? 0;
    entry.count++;
    fleetByType.set(f.aircraft_type, entry);
  }

  const fleetAvg: Record<string, number> = {};
  for (const [type, data] of fleetByType) {
    fleetAvg[type] =
      data.totalHrs > 0
        ? Math.round(data.totalBurn / data.totalHrs)
        : 0;
  }

  // Aggregate per pilot
  const pilotMap = new Map<
    string,
    {
      name: string;
      flights: number;
      totalHrs: number;
      totalBurn: number;
      totalTakeoffWt: number;
      totalStartFuel: number;
      byType: Map<
        string,
        { hrs: number; burn: number; count: number; rates: number[] }
      >;
      recentFlights: Array<{
        date: string;
        tail: string;
        type: string;
        route: string;
        hrs: number;
        burnRate: number;
        fleetAvg: number;
        variance: number;
        startFuel: number;
        takeoffWt: number;
      }>;
    }
  >();

  for (const f of flights) {
    const name = f.pic;
    if (!name || !f.aircraft_type) continue;

    let pilot = pilotMap.get(name);
    if (!pilot) {
      pilot = {
        name,
        flights: 0,
        totalHrs: 0,
        totalBurn: 0,
        totalTakeoffWt: 0,
        totalStartFuel: 0,
        byType: new Map(),
        recentFlights: [],
      };
      pilotMap.set(name, pilot);
    }

    pilot.flights++;
    pilot.totalHrs += f.flight_hrs ?? 0;
    pilot.totalBurn += f.fuel_burn_lbs ?? 0;
    pilot.totalTakeoffWt += f.takeoff_wt_lbs ?? 0;
    pilot.totalStartFuel += f.fuel_start_lbs ?? 0;

    // Per aircraft type
    let typeEntry = pilot.byType.get(f.aircraft_type);
    if (!typeEntry) {
      typeEntry = { hrs: 0, burn: 0, count: 0, rates: [] };
      pilot.byType.set(f.aircraft_type, typeEntry);
    }
    typeEntry.hrs += f.flight_hrs ?? 0;
    typeEntry.burn += f.fuel_burn_lbs ?? 0;
    typeEntry.count++;
    if (f.fuel_burn_lbs_hour) typeEntry.rates.push(f.fuel_burn_lbs_hour);

    // Recent flights (keep last 10 per pilot)
    if (pilot.recentFlights.length < 10) {
      const avg = fleetAvg[f.aircraft_type] ?? 0;
      const rate = f.fuel_burn_lbs_hour ?? 0;
      pilot.recentFlights.push({
        date: f.flight_date,
        tail: f.tail_number,
        type: f.aircraft_type,
        route: `${f.origin}-${f.destination}`,
        hrs: f.flight_hrs ?? 0,
        burnRate: Math.round(rate),
        fleetAvg: avg,
        variance: avg > 0 ? Math.round(((rate - avg) / avg) * 100) : 0,
        startFuel: f.fuel_start_lbs ?? 0,
        takeoffWt: f.takeoff_wt_lbs ?? 0,
      });
    }
  }

  // Build response
  const pilots = [...pilotMap.values()]
    .map((p) => {
      const avgBurnRate =
        p.totalHrs > 0 ? Math.round(p.totalBurn / p.totalHrs) : 0;

      // Weighted fleet average based on this pilot's type mix
      let weightedFleetAvg = 0;
      let totalTypeHrs = 0;
      for (const [type, data] of p.byType) {
        const avg = fleetAvg[type] ?? 0;
        weightedFleetAvg += avg * data.hrs;
        totalTypeHrs += data.hrs;
      }
      weightedFleetAvg =
        totalTypeHrs > 0 ? Math.round(weightedFleetAvg / totalTypeHrs) : 0;

      const variancePct =
        weightedFleetAvg > 0
          ? Math.round(
              ((avgBurnRate - weightedFleetAvg) / weightedFleetAvg) * 100,
            )
          : 0;

      // Average start fuel (indicator of tankering)
      const avgStartFuel =
        p.flights > 0 ? Math.round(p.totalStartFuel / p.flights) : 0;

      const byType = [...p.byType.entries()].map(([type, data]) => ({
        type,
        flights: data.count,
        hours: Math.round(data.hrs * 10) / 10,
        avgBurnRate:
          data.hrs > 0 ? Math.round(data.burn / data.hrs) : 0,
        fleetAvg: fleetAvg[type] ?? 0,
      }));

      return {
        name: p.name,
        flights: p.flights,
        totalHrs: Math.round(p.totalHrs * 10) / 10,
        avgBurnRate,
        weightedFleetAvg,
        variancePct,
        avgStartFuel,
        byType,
        recentFlights: p.recentFlights,
      };
    })
    .filter((p) => p.flights >= 3) // Need enough data to be meaningful
    .sort((a, b) => b.variancePct - a.variancePct); // Heaviest flyers first

  return NextResponse.json({
    pilots,
    fleetAvg,
    totalFlights: flights.length,
    dateRange: {
      start: cutoffDate.toISOString().split("T")[0],
      end: new Date().toISOString().split("T")[0],
    },
  });
}
