import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { requireAuth } from "@/lib/api-auth";

/**
 * GET /api/fuel-planning/efficiency — Fuel efficiency analysis per pilot
 * Compares actual burn (post_flight_data) vs ForeFlight predicted (foreflight_predictions)
 * and vs fleet average by aircraft type.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if ("error" in auth) return auth.error;

  const months = Number(req.nextUrl.searchParams.get("months")) || 3;
  const cutoffDate = new Date();
  cutoffDate.setMonth(cutoffDate.getMonth() - months);
  const cutoff = cutoffDate.toISOString().split("T")[0];

  const supa = createServiceClient();

  // Fetch post-flight actuals
  const { data: flights } = await supa
    .from("post_flight_data")
    .select(
      "pic, aircraft_type, origin, destination, flight_hrs, fuel_burn_lbs, fuel_burn_lbs_hour, takeoff_wt_lbs, fuel_start_lbs, fuel_end_lbs, flight_date, tail_number, nautical_miles",
    )
    .gte("flight_date", cutoff)
    .not("pic", "is", null)
    .order("flight_date", { ascending: false });

  // Fetch ForeFlight predictions for same period
  const { data: predictions } = await supa
    .from("foreflight_predictions")
    .select(
      "tail_number, departure_icao, destination_icao, flight_date, fuel_to_dest_lbs, total_fuel_lbs, takeoff_weight, time_to_dest_min, route_nm, cruise_profile",
    )
    .gte("flight_date", cutoff);

  if (!flights || flights.length === 0) {
    return NextResponse.json({ pilots: [], fleetAvg: {}, totalFlights: 0, predictionsCount: predictions?.length ?? 0 });
  }

  // Build prediction lookup: tail+origin+dest+date → prediction
  const predMap = new Map<string, {
    fuelToDest: number;
    totalFuel: number;
    takeoffWeight: number | null;
    timeMin: number | null;
    routeNm: number | null;
  }>();

  for (const p of predictions ?? []) {
    // Normalize ICAO codes for matching (post-flight uses 3-letter, predictions use 4-letter)
    const depNorm = p.departure_icao?.replace(/^K/, "") ?? "";
    const destNorm = p.destination_icao?.replace(/^K/, "") ?? "";
    const key = `${p.tail_number}:${depNorm}:${destNorm}:${p.flight_date}`;
    predMap.set(key, {
      fuelToDest: p.fuel_to_dest_lbs,
      totalFuel: p.total_fuel_lbs,
      takeoffWeight: p.takeoff_weight,
      timeMin: p.time_to_dest_min,
      routeNm: p.route_nm,
    });
  }

  // Compute fleet average burn rate per aircraft type
  const fleetByType = new Map<string, { totalBurn: number; totalHrs: number; count: number }>();

  for (const f of flights) {
    if (!f.aircraft_type) continue;
    const burnLbs = f.fuel_burn_lbs ?? (f.fuel_start_lbs && f.fuel_end_lbs ? f.fuel_start_lbs - f.fuel_end_lbs : null);
    if (!burnLbs || !f.flight_hrs || f.flight_hrs <= 0) continue;

    const entry = fleetByType.get(f.aircraft_type) ?? { totalBurn: 0, totalHrs: 0, count: 0 };
    entry.totalBurn += burnLbs;
    entry.totalHrs += f.flight_hrs;
    entry.count++;
    fleetByType.set(f.aircraft_type, entry);
  }

  const fleetAvg: Record<string, number> = {};
  for (const [type, data] of fleetByType) {
    fleetAvg[type] = data.totalHrs > 0 ? Math.round(data.totalBurn / data.totalHrs) : 0;
  }

  // Aggregate per pilot
  const pilotMap = new Map<string, {
    name: string;
    flights: number;
    totalHrs: number;
    totalBurn: number;
    totalStartFuel: number;
    matchedPredictions: number;
    totalPredictedBurn: number;
    totalActualBurnOnMatched: number;
    byType: Map<string, { hrs: number; burn: number; count: number }>;
    recentFlights: Array<{
      date: string;
      tail: string;
      type: string;
      route: string;
      hrs: number;
      actualBurn: number;
      burnRate: number;
      fleetAvg: number;
      variance: number;
      startFuel: number;
      takeoffWt: number;
      predictedBurn: number | null;
      predictedVariance: number | null;
    }>;
  }>();

  for (const f of flights) {
    const name = f.pic;
    if (!name || !f.aircraft_type) continue;

    const actualBurn = f.fuel_burn_lbs ?? (f.fuel_start_lbs && f.fuel_end_lbs ? f.fuel_start_lbs - f.fuel_end_lbs : null);
    if (!actualBurn || actualBurn <= 0) continue;

    const burnRate = f.flight_hrs && f.flight_hrs > 0 ? actualBurn / f.flight_hrs : 0;

    let pilot = pilotMap.get(name);
    if (!pilot) {
      pilot = {
        name,
        flights: 0,
        totalHrs: 0,
        totalBurn: 0,
        totalStartFuel: 0,
        matchedPredictions: 0,
        totalPredictedBurn: 0,
        totalActualBurnOnMatched: 0,
        byType: new Map(),
        recentFlights: [],
      };
      pilotMap.set(name, pilot);
    }

    pilot.flights++;
    pilot.totalHrs += f.flight_hrs ?? 0;
    pilot.totalBurn += actualBurn;
    pilot.totalStartFuel += f.fuel_start_lbs ?? 0;

    // Per aircraft type
    let typeEntry = pilot.byType.get(f.aircraft_type);
    if (!typeEntry) {
      typeEntry = { hrs: 0, burn: 0, count: 0 };
      pilot.byType.set(f.aircraft_type, typeEntry);
    }
    typeEntry.hrs += f.flight_hrs ?? 0;
    typeEntry.burn += actualBurn;
    typeEntry.count++;

    // Match to ForeFlight prediction
    const origin = f.origin?.replace(/^K/, "") ?? "";
    const dest = f.destination?.replace(/^K/, "") ?? "";
    const predKey = `${f.tail_number}:${origin}:${dest}:${f.flight_date}`;
    const pred = predMap.get(predKey);

    let predictedBurn: number | null = null;
    let predictedVariance: number | null = null;

    if (pred) {
      predictedBurn = pred.fuelToDest;
      predictedVariance = predictedBurn > 0
        ? Math.round(((actualBurn - predictedBurn) / predictedBurn) * 100)
        : null;
      pilot.matchedPredictions++;
      pilot.totalPredictedBurn += predictedBurn;
      pilot.totalActualBurnOnMatched += actualBurn;
    }

    // Recent flights (last 15 per pilot)
    if (pilot.recentFlights.length < 15) {
      const avg = fleetAvg[f.aircraft_type] ?? 0;
      pilot.recentFlights.push({
        date: f.flight_date,
        tail: f.tail_number,
        type: f.aircraft_type,
        route: `${f.origin}-${f.destination}`,
        hrs: f.flight_hrs ?? 0,
        actualBurn: Math.round(actualBurn),
        burnRate: Math.round(burnRate),
        fleetAvg: avg,
        variance: avg > 0 ? Math.round(((burnRate - avg) / avg) * 100) : 0,
        startFuel: f.fuel_start_lbs ?? 0,
        takeoffWt: f.takeoff_wt_lbs ?? 0,
        predictedBurn,
        predictedVariance,
      });
    }
  }

  // Build response
  const pilots = [...pilotMap.values()]
    .map((p) => {
      const avgBurnRate = p.totalHrs > 0 ? Math.round(p.totalBurn / p.totalHrs) : 0;

      let weightedFleetAvg = 0;
      let totalTypeHrs = 0;
      for (const [type, data] of p.byType) {
        weightedFleetAvg += (fleetAvg[type] ?? 0) * data.hrs;
        totalTypeHrs += data.hrs;
      }
      weightedFleetAvg = totalTypeHrs > 0 ? Math.round(weightedFleetAvg / totalTypeHrs) : 0;

      const variancePct = weightedFleetAvg > 0
        ? Math.round(((avgBurnRate - weightedFleetAvg) / weightedFleetAvg) * 100)
        : 0;

      const avgStartFuel = p.flights > 0 ? Math.round(p.totalStartFuel / p.flights) : 0;

      // ForeFlight comparison stats
      const ffVariancePct = p.totalPredictedBurn > 0
        ? Math.round(((p.totalActualBurnOnMatched - p.totalPredictedBurn) / p.totalPredictedBurn) * 100)
        : null;

      const byType = [...p.byType.entries()].map(([type, data]) => ({
        type,
        flights: data.count,
        hours: Math.round(data.hrs * 10) / 10,
        avgBurnRate: data.hrs > 0 ? Math.round(data.burn / data.hrs) : 0,
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
        matchedPredictions: p.matchedPredictions,
        ffVariancePct,
        byType,
        recentFlights: p.recentFlights,
      };
    })
    .filter((p) => p.flights >= 3)
    .sort((a, b) => b.variancePct - a.variancePct);

  return NextResponse.json({
    pilots,
    fleetAvg,
    totalFlights: flights.length,
    predictionsCount: predictions?.length ?? 0,
    matchedCount: pilots.reduce((s, p) => s + p.matchedPredictions, 0),
    dateRange: { start: cutoff, end: new Date().toISOString().split("T")[0] },
  });
}
