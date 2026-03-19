import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthed } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";
import { fetchAdvertisedPrices } from "@/lib/invoiceApi";
import { buildBestRateByAirport, airportVariants } from "@/lib/fuelLookup";
import { calcPpg, optimizeMultiLeg, type AircraftType, type MultiLeg, type MultiRouteInputs, type MultiLegPlan } from "@/app/tanker/model";

export const dynamic = "force-dynamic";
export const maxDuration = 60; // ForeFlight calls can be slow

// ─── Standard aircraft parameters (with safety margin) ─────────────────
const AIRCRAFT_DEFAULTS: Record<AircraftType, {
  mlw: number;     // max landing gross weight (lbs)
  zfw: number;     // zero fuel weight estimate (OEW + avg pax load)
  ffReg: string;   // ForeFlight registration to use
  ffType: "citation" | "challenger";
}> = {
  "CE-750": { mlw: 31_800, zfw: 23_500, ffReg: "N106PC", ffType: "citation" },
  "CL-30":  { mlw: 34_250, zfw: 25_600, ffReg: "N520FX", ffType: "challenger" },
};

// Map tail numbers → aircraft type for tails without post-flight data
const TAIL_TYPE_MAP: Record<string, AircraftType> = {
  "N106PC": "CE-750",
  "N520FX": "CL-30",
  // These are known Baker tails from the sample data
  "N939TX": "CE-750",
  "N187CR": "CE-750",
  "N301HR": "CE-750",
  "N541FX": "CL-30",
  "N883TR": "CL-30",
  "N125DZ": "CE-750",
};

const FF_BASE = "https://public-api.foreflight.com/public/api";
function apiKey(): string {
  const key = process.env.FOREFLIGHT_API_KEY;
  if (!key) throw new Error("FOREFLIGHT_API_KEY not set");
  return key;
}

// ─── ForeFlight helpers ────────────────────────────────────────────────

interface FFPerf { fuelToDestLbs: number; totalFuelLbs: number; flightMinutes: number }

async function getForeFlight(
  departure: string, destination: string, registration: string,
): Promise<FFPerf | null> {
  try {
    const flightReq = {
      flight: {
        departure: departure.toUpperCase(),
        destination: destination.toUpperCase(),
        aircraftRegistration: registration,
        scheduledTimeOfDeparture: new Date(Date.now() + 3600_000).toISOString(),
        routeToDestination: { altitude: { altitude: 470, unit: "FL" } },
        load: { people: 4 },
        windOptions: { windModel: "Forecasted" },
      },
    };

    const res = await fetch(`${FF_BASE}/Flights`, {
      method: "POST",
      headers: { "x-api-key": apiKey(), "Content-Type": "application/json" },
      body: JSON.stringify(flightReq),
    });

    if (!res.ok) return null;
    const data = await res.json();

    // Clean up flight
    const flightId = data.flightId;
    if (flightId) {
      fetch(`${FF_BASE}/Flights/${encodeURIComponent(flightId)}`, {
        method: "DELETE",
        headers: { "x-api-key": apiKey() },
      }).catch(() => {});
    }

    // Extract perf (search deeply)
    const perf = data.performance ?? deepFind(data, "performance");
    const fuel = (perf as Record<string, unknown>)?.fuel ?? deepFind(data, "fuel");
    const times = (perf as Record<string, unknown>)?.times ?? deepFind(data, "times");

    const fuelObj = fuel as Record<string, number> | undefined;
    const timesObj = times as Record<string, number> | undefined;

    return {
      fuelToDestLbs: Math.round(fuelObj?.fuelToDestination ?? 0),
      totalFuelLbs: Math.round(fuelObj?.totalFuel ?? 0),
      flightMinutes: timesObj?.timeToDestinationMinutes ?? 0,
    };
  } catch (err) {
    console.error(`[fuel-planning] ForeFlight error for ${departure}→${destination}:`, err);
    return null;
  }
}

function deepFind(obj: unknown, key: string): unknown {
  if (!obj || typeof obj !== "object") return undefined;
  const rec = obj as Record<string, unknown>;
  if (key in rec) return rec[key];
  for (const v of Object.values(rec)) {
    const found = deepFind(v, key);
    if (found !== undefined) return found;
  }
  return undefined;
}

// ─── Types ─────────────────────────────────────────────────────────────

interface ScheduleLeg {
  departure_icao: string;
  arrival_icao: string;
  scheduled_departure: string;
}

interface TailPlan {
  tail: string;
  aircraftType: AircraftType;
  shutdownFuel: number;
  shutdownAirport: string;
  legs: {
    from: string;
    to: string;
    fuelToDestLbs: number;
    totalFuelLbs: number;
    flightTimeHours: number;
    departurePricePerGal: number;
    departureFboVendor: string | null;
    ffSource: "foreflight" | "estimate";
  }[];
  plan: MultiLegPlan | null;
  naiveCost: number;      // cost if you just buy all fuel at each stop (no tankering)
  tankerSavings: number;  // naiveCost - optimized cost
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

  // 1. Get shutdown fuel per tail from most recent post-flight data
  const { data: postFlightRows } = await supa
    .from("post_flight_data")
    .select("tail_number, aircraft_type, destination, fuel_end_lbs, flight_date, segment_number")
    .order("flight_date", { ascending: false })
    .order("segment_number", { ascending: false })
    .limit(500);

  if (!postFlightRows?.length) {
    return NextResponse.json({ error: "No post-flight data found. Upload a post-flight CSV first." }, { status: 400 });
  }

  // Build shutdown map: tail → { fuel, airport, type, date }
  const shutdownMap = new Map<string, { fuel: number; airport: string; type: AircraftType; date: string }>();
  for (const row of postFlightRows) {
    if (shutdownMap.has(row.tail_number)) continue; // first row per tail is most recent
    if (row.fuel_end_lbs == null) continue;
    shutdownMap.set(row.tail_number, {
      fuel: Number(row.fuel_end_lbs),
      airport: row.destination,
      type: row.aircraft_type as AircraftType,
      date: row.flight_date,
    });
  }

  // 2. Get tomorrow's schedule from flights table
  const dayStart = `${targetDate}T00:00:00Z`;
  const dayEnd = `${targetDate}T23:59:59Z`;

  const { data: flightRows } = await supa
    .from("flights")
    .select("tail_number, departure_icao, arrival_icao, scheduled_departure, scheduled_arrival")
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

  // Group by tail
  const scheduleByTail = new Map<string, ScheduleLeg[]>();
  for (const f of flightRows) {
    if (!f.tail_number || !f.departure_icao || !f.arrival_icao) continue;
    const tail = f.tail_number.toUpperCase();
    if (!scheduleByTail.has(tail)) scheduleByTail.set(tail, []);
    scheduleByTail.get(tail)!.push({
      departure_icao: f.departure_icao,
      arrival_icao: f.arrival_icao,
      scheduled_departure: f.scheduled_departure,
    });
  }

  // 3. Get fuel prices (gracefully handle if none exist)
  let advertisedPrices: Awaited<ReturnType<typeof fetchAdvertisedPrices>> = [];
  try {
    advertisedPrices = await fetchAdvertisedPrices({ recentWeeks: 4 });
  } catch (err) {
    console.warn("[fuel-planning/generate] Could not fetch advertised prices:", err);
  }
  const bestRates = buildBestRateByAirport(advertisedPrices);

  // 4. Build plans per tail
  const plans: TailPlan[] = [];

  for (const [tail, schedule] of scheduleByTail) {
    const shutdown = shutdownMap.get(tail);
    const acType = shutdown?.type ?? TAIL_TYPE_MAP[tail] ?? "CE-750";
    const defaults = AIRCRAFT_DEFAULTS[acType];

    if (!shutdown) {
      plans.push({
        tail,
        aircraftType: acType,
        shutdownFuel: 0,
        shutdownAirport: schedule[0].departure_icao,
        legs: [],
        plan: null,
        naiveCost: 0,
        tankerSavings: 0,
        error: "No post-flight data for this tail — upload shutdown fuel to generate plan",
      });
      continue;
    }

    // Fetch ForeFlight data for each leg (batch with concurrency limit)
    const legData = await Promise.all(
      schedule.map(async (leg) => {
        const ff = await getForeFlight(leg.departure_icao, leg.arrival_icao, defaults.ffReg);

        // Get fuel price at departure
        const depVariants = airportVariants(leg.departure_icao);
        let depRate = 0;
        let depVendor: string | null = null;
        for (const v of depVariants) {
          const r = bestRates.get(v);
          if (r) { depRate = r.price; depVendor = r.vendor; break; }
        }

        if (ff && ff.fuelToDestLbs > 0) {
          return {
            from: leg.departure_icao,
            to: leg.arrival_icao,
            fuelToDestLbs: ff.fuelToDestLbs,
            totalFuelLbs: ff.totalFuelLbs,
            flightTimeHours: ff.flightMinutes / 60,
            departurePricePerGal: depRate,
            departureFboVendor: depVendor,
            ffSource: "foreflight" as const,
          };
        }

        // Fallback: estimate from post-flight historical data for similar legs
        // Use a rough estimate of 3000 lbs/hr for Citation, 2500 lbs/hr for Challenger
        const estBurnRate = acType === "CE-750" ? 3000 : 2500;
        // Estimate flight time from the schedule
        const depTime = new Date(leg.scheduled_departure).getTime();
        const arrRows = schedule.filter((s) => s.departure_icao === leg.arrival_icao);
        const nextDepTime = arrRows.length > 0 ? new Date(arrRows[0].scheduled_departure).getTime() : depTime + 2 * 3600_000;
        const estHrs = Math.max(0.5, (nextDepTime - depTime) / 3_600_000 - 0.5); // subtract taxi
        const estFuel = Math.round(estBurnRate * estHrs);
        const estTotal = Math.round(estFuel * 1.15); // add 15% for taxi + reserve

        return {
          from: leg.departure_icao,
          to: leg.arrival_icao,
          fuelToDestLbs: estFuel,
          totalFuelLbs: estTotal,
          flightTimeHours: estHrs,
          departurePricePerGal: depRate,
          departureFboVendor: depVendor,
          ffSource: "estimate" as const,
        };
      }),
    );

    // Build multi-leg optimizer input
    const multiLegs: MultiLeg[] = legData.map((ld) => ({
      id: `${tail}-${ld.from}-${ld.to}`,
      from: ld.from,
      to: ld.to,
      requiredStartFuelLbs: ld.totalFuelLbs,
      fuelToDestLbs: ld.fuelToDestLbs,
      flightTimeHours: ld.flightTimeHours,
      maxLandingGrossWeightLbs: defaults.mlw,
      zeroFuelWeightLbs: defaults.zfw,
      departurePricePerGal: ld.departurePricePerGal,
      waiveFeesGallons: 0,
      feesWaivedDollars: 0,
    }));

    const routeInput: MultiRouteInputs = {
      startShutdownFuelLbs: shutdown.fuel,
      carryCostPctPerHour: 3.94, // standard carry cost
      fuelTemperatureC: 15.0,
      arrivalBufferLbs: 300,
      legs: multiLegs,
    };

    const plan = optimizeMultiLeg(routeInput);

    // Compute naive cost: what if you bought ALL fuel at each stop's local price
    // (full price at every stop, no benefit from shutdown fuel or cheap stops)
    const ppg = calcPpg(15);
    let naiveCost = 0;
    for (const ld of legData) {
      naiveCost += (ld.totalFuelLbs / ppg) * ld.departurePricePerGal;
    }

    const optimizedCost = plan?.totalTripCost ?? naiveCost;
    const tankerSavings = Math.max(0, naiveCost - optimizedCost);

    plans.push({
      tail,
      aircraftType: acType,
      shutdownFuel: shutdown.fuel,
      shutdownAirport: shutdown.airport,
      legs: legData,
      plan,
      naiveCost,
      tankerSavings,
      error: plan ? undefined : "Optimizer could not find a valid plan (check weight constraints)",
    });
  }

  // Sort: tails with plans first, then by tail number
  plans.sort((a, b) => {
    if (a.plan && !b.plan) return -1;
    if (!a.plan && b.plan) return 1;
    return a.tail.localeCompare(b.tail);
  });

  // Calculate fleet totals
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
    ok: true,
    date: targetDate,
    plans,
    fleetTotals,
    fuelPriceCount: advertisedPrices.length,
    shutdownDataDate: postFlightRows[0]?.flight_date ?? null,
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
