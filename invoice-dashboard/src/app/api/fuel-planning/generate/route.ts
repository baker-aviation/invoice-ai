import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthed } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";
import { fetchAdvertisedPrices } from "@/lib/invoiceApi";
import { buildBestRateByAirport, airportVariants, getBestRateAtFbo, getAllRatesAtFbo } from "@/lib/fuelLookup";
import { calcPpg, optimizeMultiLeg, STD_AIRCRAFT, type AircraftType, type MultiLeg, type MultiRouteInputs, type MultiLegPlan } from "@/app/tanker/model";
import { getFboWaiver, preloadDbFees } from "@/lib/fboFeeLookup";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// ─── ForeFlight integration ───────────────────────────────────────────

/** Normalize ICAO: strip leading K for US airports so KMIA matches MIA */
function normIcao(icao: string): string {
  const u = icao.toUpperCase().trim();
  return u.length === 4 && u.startsWith("K") ? u.slice(1) : u;
}

interface FFPerf {
  fuelToDestLbs: number;
  totalFuelLbs: number;
  flightFuelLbs: number;
  taxiFuelLbs: number;
  reserveFuelLbs: number;
  flightTimeHours: number;
  zeroFuelWeight: number | null;
  landingWeight: number | null;
}

/**
 * Load pre-flight ForeFlight predictions from the database.
 * These are synced by the foreflight-preflight-sync cron job.
 *
 * Returns a Map keyed by "TAIL|normDep|normArr" → FFPerf
 */
async function loadForeFlightFromDB(
  supa: ReturnType<typeof createServiceClient>,
  targetDate: string,
  tails: string[],
): Promise<Map<string, FFPerf>> {
  const result = new Map<string, FFPerf>();

  // Query pre-flight predictions for target date + next day (multi-day trips)
  const nextDay = new Date(targetDate + "T12:00:00Z");
  nextDay.setDate(nextDay.getDate() + 1);
  const nextDateStr = nextDay.toISOString().split("T")[0];

  const { data: rows, error } = await supa
    .from("foreflight_predictions")
    .select("tail_number, departure_icao, destination_icao, fuel_to_dest_lbs, total_fuel_lbs, flight_fuel_lbs, taxi_fuel_lbs, reserve_fuel_lbs, time_to_dest_min, zero_fuel_weight, landing_weight")
    .eq("snapshot_type", "pre_flight")
    .in("tail_number", tails)
    .gte("flight_date", targetDate)
    .lte("flight_date", nextDateStr);

  if (error) {
    console.warn("[fuel-planning/generate] FF DB query failed:", error.message);
    return result;
  }

  for (const row of rows ?? []) {
    if (!row.fuel_to_dest_lbs || !row.tail_number) continue;
    const key = `${row.tail_number.toUpperCase()}|${normIcao(row.departure_icao)}|${normIcao(row.destination_icao)}`;
    result.set(key, {
      fuelToDestLbs: Number(row.fuel_to_dest_lbs),
      totalFuelLbs: Number(row.total_fuel_lbs),
      flightFuelLbs: Number(row.flight_fuel_lbs ?? row.fuel_to_dest_lbs),
      taxiFuelLbs: Number(row.taxi_fuel_lbs ?? 0),
      reserveFuelLbs: Number(row.reserve_fuel_lbs ?? 0),
      flightTimeHours: row.time_to_dest_min ? Number(row.time_to_dest_min) / 60 : 0,
      zeroFuelWeight: row.zero_fuel_weight ? Number(row.zero_fuel_weight) : null,
      landingWeight: row.landing_weight ? Number(row.landing_weight) : null,
    });
  }

  console.log(`[fuel-planning/generate] Loaded ${result.size} ForeFlight predictions from DB for ${tails.length} tails`);
  return result;
}

// ─── Standard aircraft parameters ──────────────────────────────────────
const AIRCRAFT_DEFAULTS: Record<AircraftType, {
  mlw: number;
  zfw: number;
  defaultBurnRate: number;  // lbs/hr fallback
  reserveLbs: number;       // reserve + taxi fuel estimate
}> = {
  "CE-750": { mlw: 31_800, zfw: 23_500, defaultBurnRate: 3000, reserveLbs: 2000 },
  "CL-30":  { mlw: 34_250, zfw: 25_600, defaultBurnRate: 2500, reserveLbs: 1800 },
};

// ─── Types ─────────────────────────────────────────────────────────────

interface ScheduleLeg {
  departure_icao: string;
  arrival_icao: string;
  scheduled_departure: string;
  scheduled_arrival: string | null;
  origin_fbo: string | null;
  jetinsight_trip_id: string | null;
}

interface LegData {
  from: string;
  to: string;
  departureDate: string; // YYYY-MM-DD for day grouping
  fuelToDestLbs: number;
  totalFuelLbs: number;
  flightTimeHours: number;
  departurePricePerGal: number;
  departureFboVendor: string | null;
  departureFbo: string | null;
  priceSource: "trip_notes" | "contract" | "retail" | "airport_fallback" | "none";
  bestPriceAtFbo?: number | null;
  bestVendorAtFbo?: string | null;
  allVendors?: Array<{ vendor: string; price: number; tier: string }>;
  ffSource: "foreflight" | "estimate";
  ffZfw: number | null;   // ForeFlight actual ZFW for this leg
  ffMlw: number | null;   // ForeFlight actual MLW for this leg
  waiver: {
    fboName: string;
    minGallons: number;
    feeWaived: number;
    landingFee: number;
    securityFee: number;
    overnightFee: number;
  };
}

interface TailPlan {
  tail: string;
  aircraftType: AircraftType;
  shutdownFuel: number;
  shutdownAirport: string;
  legs: LegData[];
  plan: MultiLegPlan | null;
  naiveCost: number;
  tankerSavings: number;
  nationalAvgPrice?: number;
  error?: string;
}

// ─── Main endpoint ─────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;

  try {
    const body = await req.json().catch(() => ({}));
    const targetDate = (body.date as string) || tomorrow();

    const supa = createServiceClient();

    // 0. Preload FBO fees from DB (jetinsight-scrape data)
    await preloadDbFees();

    // 1. Get shutdown fuel + avg burn rates from post-flight data
    const { data: postFlightRows } = await supa
      .from("post_flight_data")
      .select("tail_number, aircraft_type, destination, fuel_end_lbs, fuel_burn_lbs_hour, flight_date, segment_number")
      .order("flight_date", { ascending: false })
      .order("segment_number", { ascending: false })
      .limit(500);

    if (!postFlightRows?.length) {
      return NextResponse.json({ error: "No post-flight data found. Upload a post-flight CSV first." }, { status: 400 });
    }

    // Build shutdown map + average burn rates per aircraft type
    const shutdownMap = new Map<string, { fuel: number; airport: string; type: AircraftType; date: string }>();
    const burnRates: Record<AircraftType, number[]> = { "CE-750": [], "CL-30": [] };

    for (const row of postFlightRows) {
      // Shutdown fuel: first (most recent) row per tail
      if (!shutdownMap.has(row.tail_number) && row.fuel_end_lbs != null) {
        shutdownMap.set(row.tail_number, {
          fuel: Number(row.fuel_end_lbs),
          airport: row.destination,
          type: row.aircraft_type as AircraftType,
          date: row.flight_date,
        });
      }
      // Collect burn rates for averaging
      if (row.fuel_burn_lbs_hour != null && Number(row.fuel_burn_lbs_hour) > 500) {
        const acType = row.aircraft_type as AircraftType;
        if (burnRates[acType]) burnRates[acType].push(Number(row.fuel_burn_lbs_hour));
      }
    }

    // Compute average burn rates (fall back to defaults)
    const avgBurnRate: Record<AircraftType, number> = {
      "CE-750": burnRates["CE-750"].length > 0
        ? burnRates["CE-750"].reduce((a, b) => a + b, 0) / burnRates["CE-750"].length
        : AIRCRAFT_DEFAULTS["CE-750"].defaultBurnRate,
      "CL-30": burnRates["CL-30"].length > 0
        ? burnRates["CL-30"].reduce((a, b) => a + b, 0) / burnRates["CL-30"].length
        : AIRCRAFT_DEFAULTS["CL-30"].defaultBurnRate,
    };

    // 2. Get schedule from flights table — include next day for multi-day tankering
    const dayStart = `${targetDate}T00:00:00Z`;
    const nextDay = new Date(targetDate + "T12:00:00Z");
    nextDay.setDate(nextDay.getDate() + 1);
    const dayEndExtended = `${nextDay.toISOString().split("T")[0]}T23:59:59Z`;

    const { data: flightRows } = await supa
      .from("flights")
      .select("tail_number, departure_icao, arrival_icao, scheduled_departure, scheduled_arrival, origin_fbo, jetinsight_trip_id")
      .gte("scheduled_departure", dayStart)
      .lte("scheduled_departure", dayEndExtended)
      .order("scheduled_departure", { ascending: true });

    if (!flightRows?.length) {
      return NextResponse.json({
        ok: true,
        message: `No flights scheduled for ${targetDate}`,
        date: targetDate,
        plans: [],
        shutdownData: Object.fromEntries(shutdownMap),
      });
    }

    // 2b. Build FBO lookup from flights data (populated by JetInsight scraper)
    const fboByLeg = new Map<string, string>();
    for (const r of flightRows ?? []) {
      if (r.origin_fbo && r.tail_number && r.departure_icao) {
        fboByLeg.set(`${r.tail_number.toUpperCase()}|${r.departure_icao}`, r.origin_fbo);
      }
    }

    // Group by tail
    const scheduleByTail = new Map<string, ScheduleLeg[]>();
    for (const f of flightRows) {
      if (!f.tail_number || !f.departure_icao || !f.arrival_icao) continue;
      const tail = f.tail_number.toUpperCase();
      if (!scheduleByTail.has(tail)) scheduleByTail.set(tail, []);
      const originFbo = fboByLeg.get(`${tail}|${f.departure_icao}`) ?? null;
      scheduleByTail.get(tail)!.push({
        departure_icao: f.departure_icao,
        arrival_icao: f.arrival_icao,
        scheduled_departure: f.scheduled_departure,
        scheduled_arrival: f.scheduled_arrival ?? null,
        origin_fbo: originFbo,
        jetinsight_trip_id: f.jetinsight_trip_id ?? null,
      });
    }

    // 3. Get fuel prices
    let advertisedPrices: Awaited<ReturnType<typeof fetchAdvertisedPrices>> = [];
    try {
      advertisedPrices = await fetchAdvertisedPrices({ recentWeeks: 2 });
    } catch (err) {
      console.warn("[fuel-planning/generate] Could not fetch advertised prices:", err);
    }
    const bestRates = buildBestRateByAirport(advertisedPrices);

    // Compute national average fuel price from best rates at each airport
    const allBestPrices = [...bestRates.values()].map((r) => r.price).filter((p) => p > 0);
    const nationalAvgPrice = allBestPrices.length > 0
      ? allBestPrices.reduce((a, b) => a + b, 0) / allBestPrices.length
      : 0;

    // 3b. Get sales rep fuel choices from trip notes (if available for this date's trips)
    const tripIds = [...new Set(
      (flightRows ?? []).map((f) => f.jetinsight_trip_id).filter(Boolean) as string[]
    )];
    const fuelChoiceMap = new Map<string, { vendor: string; price: number; tier: string }>();
    if (tripIds.length > 0) {
      const { data: fuelChoices } = await supa
        .from("trip_fuel_choices")
        .select("jetinsight_trip_id, airport_code, fuel_vendor, price_per_gallon, volume_tier")
        .in("jetinsight_trip_id", tripIds);
      for (const fc of fuelChoices ?? []) {
        // Key: trip_id|airport
        fuelChoiceMap.set(`${fc.jetinsight_trip_id}|${fc.airport_code}`, {
          vendor: fc.fuel_vendor,
          price: Number(fc.price_per_gallon),
          tier: fc.volume_tier,
        });
      }
    }

    // 3c. Get JetInsight retail Jet A prices as last-resort fallback
    const { data: retailRows } = await supa
      .from("fbo_handling_fees")
      .select("airport_code, fbo_name, jet_a_price")
      .eq("source", "jetinsight-scrape")
      .not("jet_a_price", "is", null);
    const retailPriceMap = new Map<string, number>();
    for (const r of retailRows ?? []) {
      if (r.jet_a_price) {
        // Key by airport + lowercase FBO name
        retailPriceMap.set(`${r.airport_code.toUpperCase()}|${r.fbo_name.toLowerCase()}`, Number(r.jet_a_price));
      }
    }

    // 5. Build plans per tail
    const plans: TailPlan[] = [];
    const ppg = calcPpg(15);

    // Pre-build estimate-based leg data for all tails first, then selectively
    // enrich with ForeFlight performance data only for tails with tankering potential
    // (multi-leg + price variation across stops). This avoids slow FF API calls
    // for single-leg tails or tails where prices are identical.

    // Phase 1: Build legs with estimates, identify tails worth enriching
    const tailLegData = new Map<string, { schedule: ScheduleLeg[]; legs: LegData[]; acType: AircraftType; shutdown: { fuel: number; airport: string } }>();

    for (const [tail, schedule] of scheduleByTail) {
      const shutdown = shutdownMap.get(tail);
      const acType = shutdown?.type ?? "CE-750";
      const defaults = AIRCRAFT_DEFAULTS[acType];
      const burnRate = avgBurnRate[acType];

      if (!shutdown) {
        plans.push({
          tail, aircraftType: acType, shutdownFuel: 0,
          shutdownAirport: schedule[0].departure_icao,
          legs: [], plan: null, naiveCost: 0, tankerSavings: 0,
          error: "No post-flight data for this tail — upload shutdown fuel to generate plan",
        });
        continue;
      }

      const legData: LegData[] = schedule.map((leg, idx) => {
        let flightHrs: number;
        if (leg.scheduled_arrival) {
          const dep = new Date(leg.scheduled_departure).getTime();
          const arr = new Date(leg.scheduled_arrival).getTime();
          flightHrs = Math.max(0.3, (arr - dep) / 3_600_000);
        } else {
          const dep = new Date(leg.scheduled_departure).getTime();
          const nextLeg = schedule[idx + 1];
          const nextDep = nextLeg ? new Date(nextLeg.scheduled_departure).getTime() : dep + 2 * 3_600_000;
          flightHrs = Math.max(0.3, (nextDep - dep) / 3_600_000 - 0.5);
        }

        const fuelBurn = Math.round(burnRate * flightHrs);
        const totalFuel = fuelBurn + defaults.reserveLbs;

        // FBO fee lookup: use origin_fbo from flights if available, else best match at airport
        const legWaiver = getFboWaiver(leg.departure_icao, leg.origin_fbo, acType);
        const fboName = leg.origin_fbo ?? (legWaiver.fboName || null);

        // Fuel price at departure — priority:
        // 1. Sales rep's pick from trip notes (what they actually chose)
        // 2. Cheapest contract vendor at this specific FBO
        // 3. JetInsight retail Jet A price at this FBO
        // 4. Airport-wide best (only if no FBO name known)
        let depRate = 0;
        let depVendor: string | null = null;
        let priceSource: "trip_notes" | "contract" | "retail" | "airport_fallback" = "contract";

        // 1. Check trip notes fuel choice
        if (leg.jetinsight_trip_id) {
          const fc = fuelChoiceMap.get(`${leg.jetinsight_trip_id}|${leg.departure_icao}`);
          if (fc) {
            depRate = fc.price;
            depVendor = fc.vendor;
            priceSource = "trip_notes";
          }
        }

        // 2. Cheapest contract vendor at this FBO
        if (!depRate && fboName) {
          const estimatedGallons = Math.round(totalFuel / ppg);
          const fboRate = getBestRateAtFbo(advertisedPrices, leg.departure_icao, fboName, estimatedGallons);
          if (fboRate) {
            depRate = fboRate.price;
            depVendor = fboRate.vendor;
            priceSource = "contract";
          }
        }

        // 3. JetInsight retail Jet A price at this FBO
        if (!depRate && fboName) {
          const normAp = leg.departure_icao.length === 4 && leg.departure_icao.startsWith("K")
            ? leg.departure_icao.slice(1) : leg.departure_icao;
          const retailKey = `${normAp.toUpperCase()}|${fboName.toLowerCase()}`;
          const retail = retailPriceMap.get(retailKey);
          if (retail) {
            depRate = retail;
            depVendor = fboName + " (retail)";
            priceSource = "retail";
          }
        }

        // 4. Airport-wide best (only if no FBO known)
        if (!depRate && !fboName) {
          const depVariants = airportVariants(leg.departure_icao);
          for (const v of depVariants) {
            const r = bestRates.get(v);
            if (r) { depRate = r.price; depVendor = r.vendor; priceSource = "airport_fallback"; break; }
          }
        }

        // Compute best alternative at this FBO for comparison
        let bestAtFbo: number | null = null;
        let bestVendorAtFbo: string | null = null;
        if (fboName && priceSource === "trip_notes") {
          const estimatedGallons = Math.round(totalFuel / ppg);
          const alt = getBestRateAtFbo(advertisedPrices, leg.departure_icao, fboName, estimatedGallons);
          if (alt && alt.price < depRate) {
            bestAtFbo = alt.price;
            bestVendorAtFbo = alt.vendor;
          }
        }

        // All available vendors at this FBO (for vendor plan display)
        const allVendors = fboName
          ? getAllRatesAtFbo(advertisedPrices, leg.departure_icao, fboName)
              .map((r) => ({ vendor: r.vendor, price: r.price, tier: r.tier }))
          : [];

        return {
          from: leg.departure_icao,
          to: leg.arrival_icao,
          departureDate: leg.scheduled_departure.split("T")[0],
          fuelToDestLbs: fuelBurn,
          totalFuelLbs: totalFuel,
          flightTimeHours: flightHrs,
          departurePricePerGal: depRate,
          departureFboVendor: depVendor,
          departureFbo: fboName,
          priceSource: depRate > 0 ? priceSource : "none" as const,
          bestPriceAtFbo: bestAtFbo,
          bestVendorAtFbo: bestVendorAtFbo,
          allVendors,
          ffSource: "estimate" as const,
          ffZfw: null,
          ffMlw: null,
          waiver: {
            fboName: legWaiver.fboName,
            minGallons: legWaiver.minGallons,
            feeWaived: legWaiver.feeWaived,
            landingFee: legWaiver.landingFee,
            securityFee: legWaiver.securityFee,
            overnightFee: legWaiver.overnightFee,
          },
        };
      });

      tailLegData.set(tail, { schedule, legs: legData, acType, shutdown: { fuel: shutdown.fuel, airport: shutdown.airport } });
    }

    // Phase 2: Identify tails with tankering potential (multi-leg + price variation or fee waivers)
    const tailsNeedingFF: string[] = [];
    for (const [tail, data] of tailLegData) {
      if (data.legs.length < 2) continue;
      const prices = data.legs.map((l) => l.departurePricePerGal).filter((p) => p > 0);
      const hasPriceVariation = prices.length >= 2 && Math.max(...prices) - Math.min(...prices) > 0.10;
      const hasFeeWaiver = data.legs.some((l) => l.waiver.minGallons > 0 && l.waiver.feeWaived > 0);
      if (hasPriceVariation || hasFeeWaiver) tailsNeedingFF.push(tail);
    }

    // Load ForeFlight pre-flight predictions from DB (synced by cron)
    const ffPerf = tailsNeedingFF.length > 0
      ? await loadForeFlightFromDB(supa, targetDate, tailsNeedingFF)
      : new Map<string, FFPerf>();

    // Phase 3: Enrich legs with ForeFlight data and run optimizer
    for (const [tail, data] of tailLegData) {
      const { legs: legData, acType, shutdown } = data;
      const defaults = AIRCRAFT_DEFAULTS[acType];

      // Enrich with ForeFlight performance if available
      for (const ld of legData) {
        const ffKey = `${tail}|${normIcao(ld.from)}|${normIcao(ld.to)}`;
        const ff = ffPerf.get(ffKey);
        if (ff) {
          ld.fuelToDestLbs = Math.round(ff.fuelToDestLbs);
          ld.totalFuelLbs = Math.round(ff.totalFuelLbs);
          if (ff.flightTimeHours > 0) ld.flightTimeHours = ff.flightTimeHours;
          ld.ffSource = "foreflight";
          ld.ffZfw = ff.zeroFuelWeight;
          ld.ffMlw = ff.landingWeight;
        }
      }

      // Build optimizer input
      const multiLegs: MultiLeg[] = legData.map((ld) => {
        const waiver = ld.waiver;
        return {
          id: `${tail}-${ld.from}-${ld.to}`,
          from: ld.from, to: ld.to,
          requiredStartFuelLbs: ld.totalFuelLbs,
          fuelToDestLbs: ld.fuelToDestLbs,
          flightTimeHours: ld.flightTimeHours,
          maxLandingGrossWeightLbs: ld.ffMlw ?? defaults.mlw,
          zeroFuelWeightLbs: ld.ffZfw ?? defaults.zfw,
          maxFuelCapacityLbs: STD_AIRCRAFT[acType].maxFuel,
          departurePricePerGal: ld.departurePricePerGal,
          waiveFeesGallons: waiver.minGallons,
          feesWaivedDollars: waiver.feeWaived,
        };
      });

      const routeInput: MultiRouteInputs = {
        startShutdownFuelLbs: shutdown.fuel,
        carryCostPctPerHour: 3.94,
        fuelTemperatureC: 15.0,
        arrivalBufferLbs: 300,
        legs: multiLegs,
      };

      const plan = optimizeMultiLeg(routeInput, 200);

      // Baseline cost: buy what you need at each stop, always meeting fee
      // waiver minimums (standard ops). No tankering — no extra fuel carried.
      let naiveCost = 0;
      let runningFuel = shutdown.fuel;
      for (const ld of legData) {
        const needed = ld.totalFuelLbs;
        const neededLbs = Math.max(0, needed - runningFuel);
        let orderGal = neededLbs / ppg;

        const waiver = ld.waiver;
        if (waiver.minGallons > 0 && orderGal < waiver.minGallons) {
          orderGal = waiver.minGallons;
        }

        const maxFuel = STD_AIRCRAFT[acType].maxFuel;
        const maxOrderLbs = Math.max(0, maxFuel - runningFuel);
        orderGal = Math.min(orderGal, maxOrderLbs / ppg);

        naiveCost += orderGal * ld.departurePricePerGal;

        const actualOrderLbs = orderGal * ppg;
        const departFuel = runningFuel + actualOrderLbs;
        runningFuel = Math.max(0, departFuel - ld.fuelToDestLbs - 300);
      }

      const optimizedCost = plan?.totalTripCost ?? naiveCost;
      const tankerSavings = Math.max(0, naiveCost - optimizedCost);

      plans.push({
        tail, aircraftType: acType,
        shutdownFuel: shutdown.fuel, shutdownAirport: shutdown.airport,
        legs: legData, plan, naiveCost, tankerSavings, nationalAvgPrice,
        error: plan ? undefined : "Optimizer could not find a valid plan (check weight constraints)",
      });
    }

    // Sort: tails with plans first, then by tail
    plans.sort((a, b) => {
      if (a.plan && !b.plan) return -1;
      if (!a.plan && b.plan) return 1;
      return a.tail.localeCompare(b.tail);
    });

    const fleetTotals = plans.reduce(
      (acc, p) => {
        if (!p.plan) return acc;
        acc.totalFuelCost += p.plan.totalFuelCost;
        acc.totalFees += p.plan.totalFees;
        acc.totalTripCost += p.plan.totalTripCost;
        acc.naiveCost += p.naiveCost;
        acc.tankerSavings += p.tankerSavings;
        acc.planCount++;
        return acc;
      },
      { totalFuelCost: 0, totalFees: 0, totalTripCost: 0, naiveCost: 0, tankerSavings: 0, planCount: 0 },
    );

    return NextResponse.json({
      ok: true, date: targetDate, plans, fleetTotals,
      nationalAvgPrice,
      fuelPriceCount: advertisedPrices.length,
      shutdownDataDate: postFlightRows[0]?.flight_date ?? null,
      avgBurnRates: avgBurnRate,
      foreflightMatches: ffPerf.size,
    });
  } catch (err) {
    console.error("[fuel-planning/generate] Unhandled error:", err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

function tomorrow(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toISOString().split("T")[0];
}
