import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { requireAuth } from "@/lib/api-auth";

/**
 * GET /api/fuel-planning/unified-efficiency?months=3&type=all
 *
 * Consolidated fuel efficiency endpoint merging:
 *   - Pilot burn rates & ForeFlight prediction vs actuals (from efficiency/)
 *   - Flight phase climb/cruise/descent analysis (from climb-analysis/)
 *
 * Hero metric: lbs/NM (fuel_burn_lbs / nautical_miles)
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if ("error" in auth) return auth.error;

  const months = Number(req.nextUrl.searchParams.get("months")) || 3;
  const typeFilter = req.nextUrl.searchParams.get("type") || "all";

  const cutoffDate = new Date();
  cutoffDate.setMonth(cutoffDate.getMonth() - months);
  const cutoff = cutoffDate.toISOString().split("T")[0];
  const today = new Date().toISOString().split("T")[0];

  const supa = createServiceClient();

  // ---------------------------------------------------------------------------
  // Parallel data fetch — 4 tables at once
  // ---------------------------------------------------------------------------
  const [rawFlightsRes, predictionsRes, phasesRes, scheduledRes, tracksRes] =
    await Promise.all([
      // 1. Post-flight actuals
      supa
        .from("post_flight_data")
        .select(
          "pic, sic, aircraft_type, origin, destination, flight_hrs, block_hrs, " +
            "fuel_burn_lbs, fuel_burn_lbs_hour, takeoff_wt_lbs, fuel_start_lbs, " +
            "fuel_end_lbs, flight_date, tail_number, nautical_miles",
        )
        .gte("flight_date", cutoff)
        .not("fuel_burn_lbs", "is", null)
        .gt("fuel_burn_lbs", 0)
        .order("flight_date", { ascending: false }),

      // 2. ForeFlight predictions (wider field set)
      supa
        .from("foreflight_predictions")
        .select(
          "foreflight_id, tail_number, departure_icao, destination_icao, flight_date, " +
            "fuel_to_dest_lbs, total_fuel_lbs, flight_fuel_lbs, taxi_fuel_lbs, " +
            "takeoff_weight, landing_weight, time_to_dest_min, route_nm, cruise_profile",
        )
        .gte("flight_date", cutoff),

      // 3. Flight phases (all fields)
      supa
        .from("foreflight_flight_phases")
        .select(
          "foreflight_id, climb_min, cruise_min, descent_min, total_min, " +
            "climb_pct, cruise_pct, descent_pct, initial_alt_fl, max_alt_fl, " +
            "final_cruise_fl, step_climbs, cruise_profile",
        ),

      // 4. Flights table for PIC backfill
      supa
        .from("flights")
        .select("tail_number, departure_icao, pic, scheduled_departure")
        .gte("scheduled_departure", cutoffDate.toISOString())
        .not("pic", "is", null),

      // 5. FlightAware tracks with segments_summary for avg cruise FL
      supa
        .from("flightaware_tracks")
        .select("tail_number, origin_icao, destination_icao, flight_date, segments_summary, max_altitude")
        .gte("flight_date", cutoff)
        .gt("position_count", 5),
    ]);

  /* eslint-disable @typescript-eslint/no-explicit-any */
  const rawFlightsRaw = (rawFlightsRes.data ?? []) as any[];
  const predictions = (predictionsRes.data ?? []) as any[];
  const phases = (phasesRes.data ?? []) as any[];
  const scheduled = (scheduledRes.data ?? []) as any[];
  const tracks = (tracksRes.data ?? []) as any[];
  /* eslint-enable @typescript-eslint/no-explicit-any */

  // Dedupe: when multiple rows exist for same tail+origin+dest+date, keep the one
  // with the most complete data (has NM, highest burn). This handles overlapping
  // CSV uploads from different batches.
  const dedupeMap = new Map<string, typeof rawFlightsRaw[0]>();
  for (const f of rawFlightsRaw) {
    const key = `${f.tail_number}:${f.origin}:${f.destination}:${f.flight_date}`;
    const existing = dedupeMap.get(key);
    if (!existing) {
      dedupeMap.set(key, f);
    } else {
      // Prefer row with nautical_miles and higher burn
      const existingScore = (existing.nautical_miles ? 1 : 0) + (existing.fuel_burn_lbs ?? 0);
      const newScore = (f.nautical_miles ? 1 : 0) + (f.fuel_burn_lbs ?? 0);
      if (newScore > existingScore) dedupeMap.set(key, f);
    }
  }
  const rawFlights = [...dedupeMap.values()];

  // Build track lookup: tail+origin+dest+date → max cruise FL from ADS-B
  const trackCruiseFl = new Map<string, number>();
  for (const t of tracks) {
    const dep = (t.origin_icao ?? "").replace(/^K/, "");
    const dest = (t.destination_icao ?? "").replace(/^K/, "");
    const key = `${t.tail_number}:${dep}:${dest}:${t.flight_date}`;
    // Use segments_summary if available, otherwise max_altitude
    const summary = t.segments_summary as { maxCruiseAlt?: number } | null;
    const cruiseFl = summary?.maxCruiseAlt ?? (t.max_altitude ? Math.round(t.max_altitude / 1) : null);
    if (cruiseFl && cruiseFl > 50) trackCruiseFl.set(key, cruiseFl);
  }

  // ---------------------------------------------------------------------------
  // PIC backfill from flights table (same logic as efficiency/route.ts)
  // ---------------------------------------------------------------------------
  const flightsWithoutPic = rawFlights.filter((f) => !f.pic);
  const picLookup = new Map<string, string>();

  if (flightsWithoutPic.length > 0) {
    for (const s of scheduled) {
      const dep = s.departure_icao ?? "";
      const depShort = dep.replace(/^K/, "");
      const dt = new Date(s.scheduled_departure);
      for (let d = -1; d <= 1; d++) {
        const date = new Date(dt);
        date.setDate(date.getDate() + d);
        const dateStr = date.toISOString().split("T")[0];
        picLookup.set(`${s.tail_number}:${dep}:${dateStr}`, s.pic);
        picLookup.set(`${s.tail_number}:${depShort}:${dateStr}`, s.pic);
      }
    }
  }

  const allFlights = rawFlights
    .map((f) => {
      if (!f.pic && f.tail_number && f.origin && f.flight_date) {
        const origin = f.origin ?? "";
        const key = `${f.tail_number}:${origin}:${f.flight_date}`;
        const matchedPic = picLookup.get(key);
        if (matchedPic) return { ...f, pic: matchedPic };
      }
      return f;
    })
    .filter((f) => f.pic);

  // Apply aircraft type filter
  const flights =
    typeFilter === "all"
      ? allFlights
      : allFlights.filter((f) => f.aircraft_type === typeFilter);

  // ---------------------------------------------------------------------------
  // Build prediction lookup: tail+origin+dest+date → prediction
  // ---------------------------------------------------------------------------
  type PredEntry = {
    foreflightId: string | number;
    fuelToDest: number;
    totalFuel: number;
    flightFuel: number | null;
    taxiFuel: number | null;
    landingFuel: number | null;
    takeoffWeight: number | null;
    landingWeight: number | null;
    timeMin: number | null;
    routeNm: number | null;
    cruiseProfile: string | null;
  };

  const predMap = new Map<string, PredEntry>();

  for (const p of predictions) {
    const depNorm = p.departure_icao?.replace(/^K/, "") ?? "";
    const destNorm = p.destination_icao?.replace(/^K/, "") ?? "";
    const key = `${p.tail_number}:${depNorm}:${destNorm}:${p.flight_date}`;
    const flightFuel = p.flight_fuel_lbs ? Number(p.flight_fuel_lbs) : null;
    const totalFuel = p.total_fuel_lbs ? Number(p.total_fuel_lbs) : 0;
    predMap.set(key, {
      foreflightId: p.foreflight_id,
      fuelToDest: p.fuel_to_dest_lbs,
      totalFuel,
      flightFuel,
      taxiFuel: p.taxi_fuel_lbs ? Number(p.taxi_fuel_lbs) : null,
      landingFuel:
        flightFuel != null ? Math.round(totalFuel - flightFuel) : null,
      takeoffWeight: p.takeoff_weight ? Number(p.takeoff_weight) : null,
      landingWeight: p.landing_weight ? Number(p.landing_weight) : null,
      timeMin: p.time_to_dest_min,
      routeNm: p.route_nm,
      cruiseProfile: p.cruise_profile ?? null,
    });
  }

  // ---------------------------------------------------------------------------
  // Build phase lookup: foreflight_id → phase data
  // ---------------------------------------------------------------------------
  type PhaseEntry = {
    climbMin: number;
    cruiseMin: number;
    descentMin: number;
    climbPct: number;
    initialAlt: number;
    maxAlt: number;
    stepClimbs: number;
    cruiseProfile: string | null;
  };

  const phaseMap = new Map<string | number, PhaseEntry>();
  for (const p of phases) {
    phaseMap.set(p.foreflight_id, {
      climbMin: Number(p.climb_min) || 0,
      cruiseMin: Number(p.cruise_min) || 0,
      descentMin: Number(p.descent_min) || 0,
      climbPct: Number(p.climb_pct) || 0,
      initialAlt: p.initial_alt_fl ?? 0,
      maxAlt: p.max_alt_fl ?? 0,
      stepClimbs: p.step_climbs ?? 0,
      cruiseProfile: p.cruise_profile ?? null,
    });
  }

  // ---------------------------------------------------------------------------
  // Fleet averages per aircraft type (burn rate + lbs/NM)
  // ---------------------------------------------------------------------------
  type FleetTypeStats = {
    totalBurn: number;
    totalHrs: number;
    totalNm: number;
    totalClimbPct: number;
    totalInitialAlt: number;
    climbPctCount: number;
    count: number;
  };

  const fleetByType = new Map<string, FleetTypeStats>();

  for (const f of flights) {
    if (!f.aircraft_type) continue;
    const burnLbs =
      f.fuel_burn_lbs ??
      (f.fuel_start_lbs && f.fuel_end_lbs
        ? f.fuel_start_lbs - f.fuel_end_lbs
        : null);
    if (!burnLbs || burnLbs <= 0 || !f.flight_hrs || f.flight_hrs <= 0)
      continue;

    const entry = fleetByType.get(f.aircraft_type) ?? {
      totalBurn: 0,
      totalHrs: 0,
      totalNm: 0,
      totalClimbPct: 0,
      totalInitialAlt: 0,
      climbPctCount: 0,
      count: 0,
    };
    entry.totalBurn += burnLbs;
    entry.totalHrs += f.flight_hrs;
    entry.count++;

    const nm = f.nautical_miles ?? 0;
    if (nm > 0) entry.totalNm += nm;

    // Check if this flight has phase data via prediction match
    const origin = f.origin?.replace(/^K/, "") ?? "";
    const dest = f.destination?.replace(/^K/, "") ?? "";
    const predKey = `${f.tail_number}:${origin}:${dest}:${f.flight_date}`;
    const pred = predMap.get(predKey);
    if (pred) {
      const phase = phaseMap.get(pred.foreflightId);
      if (phase && phase.climbPct > 0) {
        entry.totalClimbPct += phase.climbPct;
        entry.totalInitialAlt += phase.initialAlt;
        entry.climbPctCount++;
      }
    }

    fleetByType.set(f.aircraft_type, entry);
  }

  // Compute fleet avg maps
  const fleetAvgBurnRate: Record<string, number> = {};
  const fleetAvgLbsNm: Record<string, number> = {};

  const byTypeResponse: Record<
    string,
    {
      avgBurnRate: number;
      avgLbsNm: number;
      avgClimbPct: number;
      avgInitialAlt: number;
      flights: number;
      hours: number;
    }
  > = {};

  for (const [type, data] of fleetByType) {
    const avgBR = data.totalHrs > 0 ? data.totalBurn / data.totalHrs : 0;
    const avgLN = data.totalNm > 0 ? data.totalBurn / data.totalNm : 0;
    fleetAvgBurnRate[type] = avgBR;
    fleetAvgLbsNm[type] = avgLN;
    byTypeResponse[type] = {
      avgBurnRate: Math.round(avgBR),
      avgLbsNm: Math.round(avgLN * 100) / 100,
      avgClimbPct:
        data.climbPctCount > 0
          ? Math.round((data.totalClimbPct / data.climbPctCount) * 10) / 10
          : 0,
      avgInitialAlt:
        data.climbPctCount > 0
          ? Math.round(data.totalInitialAlt / data.climbPctCount)
          : 0,
      flights: data.count,
      hours: Math.round(data.totalHrs * 10) / 10,
    };
  }

  // ---------------------------------------------------------------------------
  // FF accuracy (overall)
  // ---------------------------------------------------------------------------
  let totalPredBurn = 0;
  let totalActualOnMatched = 0;
  let matchedFlightCount = 0;

  // ---------------------------------------------------------------------------
  // Aggregate per pilot
  // ---------------------------------------------------------------------------
  type PilotAccum = {
    name: string;
    flights: number;
    totalHrs: number;
    totalBurn: number;
    totalNm: number;
    nmFlights: number; // flights with valid NM
    totalStartFuel: number;
    matchedPredictions: number;
    totalPredictedBurn: number;
    totalActualBurnOnMatched: number;
    // Climb accumulators
    climbMinSum: number;
    climbPctSum: number;
    initialAltSum: number;
    maxAltSum: number;
    totalStepClimbs: number;
    climbFlights: number; // flights with phase data
    // ADS-B cruise altitude
    cruiseFlSum: number;
    cruiseFlCount: number;
    // Per type
    byType: Map<
      string,
      { hrs: number; burn: number; nm: number; nmCount: number; count: number }
    >;
    recentFlights: RecentFlight[];
  };

  type RecentFlight = {
    date: string;
    tail: string;
    type: string;
    route: string;
    nm: number;
    hrs: number;
    actualBurn: number;
    burnRate: number;
    lbsNm: number;
    startFuel: number;
    endFuel: number;
    ffBurn: number | null;
    ffStartFuel: number | null;
    ffFlightFuel: number | null;
    ffLandingFuel: number | null;
    ffTimeMin: number | null;
    predictedVariance: number | null;
    fleetVariance: number;
    climbMin: number | null;
    cruiseMin: number | null;
    descentMin: number | null;
    climbPct: number | null;
    initialAlt: number | null;
    maxAlt: number | null;
    stepClimbs: number | null;
    cruiseProfile: string | null;
    blockHrs: number;
  };

  const pilotMap = new Map<string, PilotAccum>();

  // Tail accumulators
  const tailMap = new Map<
    string,
    {
      tail: string;
      type: string;
      flights: number;
      totalBurn: number;
      totalHrs: number;
      totalNm: number;
      nmCount: number;
    }
  >();

  for (const f of flights) {
    const name = f.pic;
    if (!name || !f.aircraft_type) continue;

    const actualBurn =
      f.fuel_burn_lbs ??
      (f.fuel_start_lbs && f.fuel_end_lbs
        ? f.fuel_start_lbs - f.fuel_end_lbs
        : null);
    if (!actualBurn || actualBurn <= 0) continue;

    const hrs = f.flight_hrs ?? 0;
    const burnRate = hrs > 0 ? actualBurn / hrs : 0;
    const nm = f.nautical_miles ?? 0;
    const lbsNm = nm > 0 ? actualBurn / nm : 0;

    // Match prediction
    const origin = f.origin?.replace(/^K/, "") ?? "";
    const dest = f.destination?.replace(/^K/, "") ?? "";
    const predKey = `${f.tail_number}:${origin}:${dest}:${f.flight_date}`;
    const pred = predMap.get(predKey);

    // Match phase data via prediction
    const phase = pred ? phaseMap.get(pred.foreflightId) ?? null : null;

    let predictedVariance: number | null = null;
    if (pred) {
      const predBurn = pred.fuelToDest;
      predictedVariance =
        predBurn > 0
          ? Math.round(((actualBurn - predBurn) / predBurn) * 100)
          : null;
      matchedFlightCount++;
      totalPredBurn += predBurn;
      totalActualOnMatched += actualBurn;
    }

    // Fleet variance for this flight
    const fleetBR = fleetAvgBurnRate[f.aircraft_type] ?? 0;
    const fleetVariance =
      fleetBR > 0 ? Math.round(((burnRate - fleetBR) / fleetBR) * 100) : 0;

    // ------- Pilot accumulation -------
    let pilot = pilotMap.get(name);
    if (!pilot) {
      pilot = {
        name,
        flights: 0,
        totalHrs: 0,
        totalBurn: 0,
        totalNm: 0,
        nmFlights: 0,
        totalStartFuel: 0,
        matchedPredictions: 0,
        totalPredictedBurn: 0,
        totalActualBurnOnMatched: 0,
        climbMinSum: 0,
        climbPctSum: 0,
        initialAltSum: 0,
        maxAltSum: 0,
        totalStepClimbs: 0,
        climbFlights: 0,
        cruiseFlSum: 0,
        cruiseFlCount: 0,
        byType: new Map(),
        recentFlights: [],
      };
      pilotMap.set(name, pilot);
    }

    pilot.flights++;
    pilot.totalHrs += hrs;
    pilot.totalBurn += actualBurn;
    pilot.totalStartFuel += f.fuel_start_lbs ?? 0;
    if (nm > 0) {
      pilot.totalNm += nm;
      pilot.nmFlights++;
    }

    if (pred) {
      pilot.matchedPredictions++;
      pilot.totalPredictedBurn += pred.fuelToDest;
      pilot.totalActualBurnOnMatched += actualBurn;
    }

    if (phase) {
      pilot.climbMinSum += phase.climbMin;
      pilot.climbPctSum += phase.climbPct;
      pilot.initialAltSum += phase.initialAlt;
      pilot.maxAltSum += phase.maxAlt;
      pilot.totalStepClimbs += phase.stepClimbs;
      pilot.climbFlights++;
    }

    // ADS-B actual cruise altitude
    const originNorm = (f.origin ?? "").replace(/^K/, "");
    const destNorm = (f.destination ?? "").replace(/^K/, "");
    const trackKey = `${f.tail_number}:${originNorm}:${destNorm}:${f.flight_date}`;
    const cruiseFl = trackCruiseFl.get(trackKey);
    if (cruiseFl) {
      pilot.cruiseFlSum += cruiseFl;
      pilot.cruiseFlCount++;
    }

    // Per type
    let typeEntry = pilot.byType.get(f.aircraft_type);
    if (!typeEntry) {
      typeEntry = { hrs: 0, burn: 0, nm: 0, nmCount: 0, count: 0 };
      pilot.byType.set(f.aircraft_type, typeEntry);
    }
    typeEntry.hrs += hrs;
    typeEntry.burn += actualBurn;
    typeEntry.count++;
    if (nm > 0) {
      typeEntry.nm += nm;
      typeEntry.nmCount++;
    }

    // Recent flights (last 20 per pilot, already sorted desc by flight_date)
    if (pilot.recentFlights.length < 20) {
      pilot.recentFlights.push({
        date: f.flight_date,
        tail: f.tail_number,
        type: f.aircraft_type,
        route: `${f.origin}-${f.destination}`,
        nm,
        hrs,
        actualBurn: Math.round(actualBurn),
        burnRate: Math.round(burnRate),
        lbsNm: nm > 0 ? Math.round(lbsNm * 100) / 100 : 0,
        startFuel: f.fuel_start_lbs ?? 0,
        endFuel: f.fuel_end_lbs ?? 0,
        ffBurn: pred ? pred.fuelToDest : null,
        ffStartFuel: pred ? pred.totalFuel : null,
        ffFlightFuel: pred ? pred.flightFuel : null,
        ffLandingFuel: pred ? pred.landingFuel : null,
        ffTimeMin: pred?.timeMin ? Number(pred.timeMin) : null,
        predictedVariance,
        fleetVariance,
        climbMin: phase ? Math.round(phase.climbMin * 10) / 10 : null,
        cruiseMin: phase ? Math.round(phase.cruiseMin * 10) / 10 : null,
        descentMin: phase ? Math.round(phase.descentMin * 10) / 10 : null,
        climbPct: phase ? Math.round(phase.climbPct * 10) / 10 : null,
        initialAlt: phase ? phase.initialAlt : null,
        maxAlt: phase ? phase.maxAlt : null,
        stepClimbs: phase ? phase.stepClimbs : null,
        cruiseProfile: phase ? phase.cruiseProfile : null,
        blockHrs: f.block_hrs ?? 0,
      });
    }

    // ------- Tail accumulation -------
    const tailKey = f.tail_number ?? "UNKNOWN";
    let tail = tailMap.get(tailKey);
    if (!tail) {
      tail = {
        tail: tailKey,
        type: f.aircraft_type,
        flights: 0,
        totalBurn: 0,
        totalHrs: 0,
        totalNm: 0,
        nmCount: 0,
      };
      tailMap.set(tailKey, tail);
    }
    tail.flights++;
    tail.totalBurn += actualBurn;
    tail.totalHrs += hrs;
    if (nm > 0) {
      tail.totalNm += nm;
      tail.nmCount++;
    }
  }

  // ---------------------------------------------------------------------------
  // Build pilot response array
  // ---------------------------------------------------------------------------
  const fleetClimbPctAll =
    [...pilotMap.values()].reduce((s, p) => s + p.climbPctSum, 0) /
    (Math.max([...pilotMap.values()].reduce((s, p) => s + p.climbFlights, 0), 1));
  const fleetInitialAltAll =
    [...pilotMap.values()].reduce((s, p) => s + p.initialAltSum, 0) /
    (Math.max([...pilotMap.values()].reduce((s, p) => s + p.climbFlights, 0), 1));
  const fleetCruiseFlAll = (() => {
    const totalFl = [...pilotMap.values()].reduce((s, p) => s + p.cruiseFlSum, 0);
    const totalCount = [...pilotMap.values()].reduce((s, p) => s + p.cruiseFlCount, 0);
    return totalCount > 0 ? Math.round(totalFl / totalCount) : null;
  })();

  const pilotsResult = [...pilotMap.values()]
    .filter((p) => p.flights >= 3)
    .map((p) => {
      const avgBurnRate =
        p.totalHrs > 0 ? Math.round(p.totalBurn / p.totalHrs) : 0;
      const avgLbsNm =
        p.totalNm > 0
          ? Math.round((p.totalBurn / p.totalNm) * 100) / 100
          : 0;

      // Weighted fleet avg for lbs/NM and burn rate based on type mix
      let weightedFleetLbsNm = 0;
      let weightedFleetBR = 0;
      let totalTypeHrs = 0;
      for (const [type, data] of p.byType) {
        weightedFleetLbsNm += (fleetAvgLbsNm[type] ?? 0) * data.hrs;
        weightedFleetBR += (fleetAvgBurnRate[type] ?? 0) * data.hrs;
        totalTypeHrs += data.hrs;
      }
      weightedFleetLbsNm =
        totalTypeHrs > 0 ? weightedFleetLbsNm / totalTypeHrs : 0;
      weightedFleetBR =
        totalTypeHrs > 0 ? weightedFleetBR / totalTypeHrs : 0;

      const lbsNmVariancePct =
        weightedFleetLbsNm > 0
          ? Math.round(
              ((avgLbsNm - weightedFleetLbsNm) / weightedFleetLbsNm) * 1000,
            ) / 10
          : 0;

      const burnRateVariancePct =
        weightedFleetBR > 0
          ? Math.round(((avgBurnRate - weightedFleetBR) / weightedFleetBR) * 1000) /
            10
          : 0;

      const avgStartFuel =
        p.flights > 0 ? Math.round(p.totalStartFuel / p.flights) : 0;

      const ffVariancePct =
        p.totalPredictedBurn > 0
          ? Math.round(
              ((p.totalActualBurnOnMatched - p.totalPredictedBurn) /
                p.totalPredictedBurn) *
                100,
            )
          : null;

      // Climb metrics
      const avgClimbMin =
        p.climbFlights > 0
          ? Math.round((p.climbMinSum / p.climbFlights) * 10) / 10
          : null;
      const avgClimbPct =
        p.climbFlights > 0
          ? Math.round((p.climbPctSum / p.climbFlights) * 10) / 10
          : null;
      const avgInitialAlt =
        p.climbFlights > 0
          ? Math.round(p.initialAltSum / p.climbFlights)
          : null;
      const avgMaxAlt =
        p.climbFlights > 0
          ? Math.round(p.maxAltSum / p.climbFlights)
          : null;

      // ADS-B actual cruise altitude
      const avgCruiseFl = p.cruiseFlCount > 0
        ? Math.round(p.cruiseFlSum / p.cruiseFlCount)
        : null;

      // Per-type breakdown
      const byType = [...p.byType.entries()].map(([type, data]) => ({
        type,
        flights: data.count,
        hours: Math.round(data.hrs * 10) / 10,
        avgBurnRate: data.hrs > 0 ? Math.round(data.burn / data.hrs) : 0,
        avgLbsNm:
          data.nm > 0
            ? Math.round((data.burn / data.nm) * 100) / 100
            : 0,
        fleetAvgLbsNm:
          Math.round((fleetAvgLbsNm[type] ?? 0) * 100) / 100,
      }));

      // ------- Insights -------
      const insights: string[] = [];

      if (lbsNmVariancePct > 8) {
        insights.push(
          `Burns ${lbsNmVariancePct.toFixed(1)}% more fuel per NM than fleet average`,
        );
      }

      if (avgClimbPct !== null && avgClimbPct > fleetClimbPctAll + 3) {
        insights.push(
          `Spends more time in climb (${avgClimbPct}%) than fleet avg (${Math.round(fleetClimbPctAll * 10) / 10}%). Climb burns 2.5x the cruise rate.`,
        );
      }

      if (avgCruiseFl !== null && fleetCruiseFlAll !== null && avgCruiseFl < fleetCruiseFlAll - 15) {
        insights.push(
          `Avg cruise altitude FL${avgCruiseFl} is below fleet avg FL${fleetCruiseFlAll}. Higher altitude = less drag = less fuel.`,
        );
      } else if (avgInitialAlt !== null && avgInitialAlt < fleetInitialAltAll - 20) {
        insights.push(
          `Avg initial cruise altitude FL${avgInitialAlt} is below fleet avg FL${Math.round(fleetInitialAltAll)}. Higher altitude = less drag.`,
        );
      }

      if (avgStartFuel > 8000 && burnRateVariancePct > 3) {
        insights.push(
          `Avg start fuel ${avgStartFuel} lbs is high — extra weight increases burn rate.`,
        );
      }

      if (ffVariancePct !== null && ffVariancePct > 15) {
        insights.push(
          `Consistently burns ${ffVariancePct}% more than ForeFlight plans. Review speed management.`,
        );
      }

      if (p.totalStepClimbs > p.flights) {
        const avgSteps =
          Math.round((p.totalStepClimbs / p.flights) * 10) / 10;
        insights.push(
          `Averages ${avgSteps} step climbs per flight — each reset costs climb fuel.`,
        );
      }

      // Cost impact vs fleet average
      // Extra lbs = actual burn - (fleet avg lbs/NM × same NM flown)
      const PPG = 6.7; // lbs per gallon Jet-A
      const PRICE_PER_GAL = 7.0;
      let expectedBurnAtFleetAvg = 0;
      for (const [type, data] of p.byType) {
        expectedBurnAtFleetAvg += (fleetAvgLbsNm[type] ?? 0) * data.nm;
      }
      const extraLbs = Math.round(p.totalBurn - expectedBurnAtFleetAvg);
      const extraGal = Math.round(extraLbs / PPG);
      const costImpact = Math.round(extraGal * PRICE_PER_GAL);

      if (costImpact > 500) {
        insights.push(
          `Fuel cost ${costImpact > 0 ? "+" : ""}$${Math.abs(costImpact).toLocaleString()} vs fleet average over ${p.flights} flights.`,
        );
      }

      return {
        name: p.name,
        flights: p.flights,
        totalHrs: Math.round(p.totalHrs * 10) / 10,
        avgBurnRate,
        avgLbsNm,
        lbsNmVariancePct,
        burnRateVariancePct,
        avgStartFuel,
        ffVariancePct,
        matchedPredictions: p.matchedPredictions,
        avgClimbMin,
        avgClimbPct,
        avgInitialAlt,
        avgMaxAlt,
        avgCruiseFl,
        totalStepClimbs: p.totalStepClimbs,
        byType,
        insights,
        recentFlights: p.recentFlights,
        costImpact,
        extraLbs,
        extraGal,
      };
    })
    .sort((a, b) => b.lbsNmVariancePct - a.lbsNmVariancePct);

  // ---------------------------------------------------------------------------
  // Tail stats
  // ---------------------------------------------------------------------------
  const tails = [...tailMap.values()]
    .map((t) => {
      const avgBR = t.totalHrs > 0 ? Math.round(t.totalBurn / t.totalHrs) : 0;
      const avgLN =
        t.totalNm > 0
          ? Math.round((t.totalBurn / t.totalNm) * 100) / 100
          : 0;
      const fleetLN = fleetAvgLbsNm[t.type] ?? 0;
      const variancePct =
        fleetLN > 0
          ? Math.round(((avgLN - fleetLN) / fleetLN) * 1000) / 10
          : 0;
      return {
        tail: t.tail,
        type: t.type,
        flights: t.flights,
        avgBurnRate: avgBR,
        avgLbsNm: avgLN,
        variancePct,
      };
    })
    .sort((a, b) => b.variancePct - a.variancePct);

  // ---------------------------------------------------------------------------
  // FF accuracy
  // ---------------------------------------------------------------------------
  const ffAccuracy =
    totalPredBurn > 0
      ? Math.round(
          ((totalActualOnMatched - totalPredBurn) / totalPredBurn) * 1000,
        ) / 10
      : 0;

  // ---------------------------------------------------------------------------
  // Response
  // ---------------------------------------------------------------------------
  return NextResponse.json({
    fleetStats: {
      byType: byTypeResponse,
      ffAccuracy,
      fleetCruiseFl: fleetCruiseFlAll,
      totalFlights: flights.filter(
        (f) =>
          f.fuel_burn_lbs ||
          (f.fuel_start_lbs && f.fuel_end_lbs),
      ).length,
      matchedFlights: matchedFlightCount,
      dateRange: { start: cutoff, end: today },
    },
    pilots: pilotsResult,
    tails,
  });
}
