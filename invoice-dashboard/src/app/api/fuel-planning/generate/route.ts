import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthed } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";
import { fetchAdvertisedPrices } from "@/lib/invoiceApi";
import { buildBestRateByAirport, airportVariants } from "@/lib/fuelLookup";
import { calcPpg, optimizeMultiLeg, STD_AIRCRAFT, type AircraftType, type MultiLeg, type MultiRouteInputs, type MultiLegPlan } from "@/app/tanker/model";
import { getFboWaiver } from "@/lib/fboFeeLookup";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

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
}

interface LegData {
  from: string;
  to: string;
  fuelToDestLbs: number;
  totalFuelLbs: number;
  flightTimeHours: number;
  departurePricePerGal: number;
  departureFboVendor: string | null;
  departureFbo: string | null;
  ffSource: "foreflight" | "estimate";
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

    // 2. Get schedule from flights table
    const dayStart = `${targetDate}T00:00:00Z`;
    const dayEnd = `${targetDate}T23:59:59Z`;

    const { data: flightRows } = await supa
      .from("flights")
      .select("tail_number, departure_icao, arrival_icao, scheduled_departure, scheduled_arrival, origin_fbo")
      .gte("scheduled_departure", dayStart)
      .lte("scheduled_departure", dayEnd)
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

    // 4. Build plans per tail (no ForeFlight calls — uses schedule times + burn rates)
    const plans: TailPlan[] = [];
    const ppg = calcPpg(15);

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

      // Build leg data from schedule + burn rate estimates
      const legData: LegData[] = schedule.map((leg, idx) => {
        // Estimate flight time from schedule
        let flightHrs: number;
        if (leg.scheduled_arrival) {
          const dep = new Date(leg.scheduled_departure).getTime();
          const arr = new Date(leg.scheduled_arrival).getTime();
          flightHrs = Math.max(0.3, (arr - dep) / 3_600_000);
        } else {
          // Fallback: estimate from next leg's departure or 2 hours
          const dep = new Date(leg.scheduled_departure).getTime();
          const nextLeg = schedule[idx + 1];
          const nextDep = nextLeg ? new Date(nextLeg.scheduled_departure).getTime() : dep + 2 * 3_600_000;
          flightHrs = Math.max(0.3, (nextDep - dep) / 3_600_000 - 0.5);
        }

        const fuelBurn = Math.round(burnRate * flightHrs);
        const totalFuel = fuelBurn + defaults.reserveLbs;

        // Fuel price at departure
        const depVariants = airportVariants(leg.departure_icao);
        let depRate = 0;
        let depVendor: string | null = null;
        for (const v of depVariants) {
          const r = bestRates.get(v);
          if (r) { depRate = r.price; depVendor = r.vendor; break; }
        }

        // FBO fee lookup: use origin_fbo from flights if available, else best match at airport
        const legWaiver = getFboWaiver(leg.departure_icao, leg.origin_fbo, acType);

        return {
          from: leg.departure_icao,
          to: leg.arrival_icao,
          fuelToDestLbs: fuelBurn,
          totalFuelLbs: totalFuel,
          flightTimeHours: flightHrs,
          departurePricePerGal: depRate,
          departureFboVendor: depVendor,
          departureFbo: leg.origin_fbo ?? (legWaiver.fboName || null),
          ffSource: "estimate" as const,
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

      // Build optimizer input (with per-airport/aircraft fee waiver rules from fbo-fees.json)
      const multiLegs: MultiLeg[] = legData.map((ld) => {
        const waiver = ld.waiver;
        return {
          id: `${tail}-${ld.from}-${ld.to}`,
          from: ld.from, to: ld.to,
          requiredStartFuelLbs: ld.totalFuelLbs,
          fuelToDestLbs: ld.fuelToDestLbs,
          flightTimeHours: ld.flightTimeHours,
          maxLandingGrossWeightLbs: defaults.mlw,
          zeroFuelWeightLbs: defaults.zfw,
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

      const plan = optimizeMultiLeg(routeInput, 200); // coarser step for fleet speed

      // Baseline cost: buy what you need at each stop, always meeting fee
      // waiver minimums (standard ops). No tankering — no extra fuel carried.
      let naiveCost = 0;
      let runningFuel = shutdown.fuel;
      for (const ld of legData) {
        const needed = ld.totalFuelLbs;
        const neededLbs = Math.max(0, needed - runningFuel);
        let orderGal = neededLbs / ppg;

        // Always buy at least the fee waiver minimum (standard ops)
        const waiver = ld.waiver;
        if (waiver.minGallons > 0 && orderGal < waiver.minGallons) {
          orderGal = waiver.minGallons;
        }

        // Cap at max fuel tank capacity
        const maxFuel = STD_AIRCRAFT[acType].maxFuel;
        const maxOrderLbs = Math.max(0, maxFuel - runningFuel);
        orderGal = Math.min(orderGal, maxOrderLbs / ppg);

        naiveCost += orderGal * ld.departurePricePerGal;

        // Extra fuel from buying waiver minimum carries over as landing fuel
        const actualOrderLbs = orderGal * ppg;
        const departFuel = runningFuel + actualOrderLbs;
        runningFuel = Math.max(0, departFuel - ld.fuelToDestLbs - 300);
      }

      const optimizedCost = plan?.totalTripCost ?? naiveCost;
      const tankerSavings = Math.max(0, naiveCost - optimizedCost);

      plans.push({
        tail, aircraftType: acType,
        shutdownFuel: shutdown.fuel, shutdownAirport: shutdown.airport,
        legs: legData, plan, naiveCost, tankerSavings,
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
      fuelPriceCount: advertisedPrices.length,
      shutdownDataDate: postFlightRows[0]?.flight_date ?? null,
      avgBurnRates: avgBurnRate,
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
