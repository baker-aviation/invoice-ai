import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthed } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";
import { fetchAdvertisedPrices } from "@/lib/invoiceApi";
import { getBestRateAtFbo, buildBestRateByAirport, airportVariants, getAllRatesAtFbo } from "@/lib/fuelLookup";

export const dynamic = "force-dynamic";

/**
 * GET /api/fuel-planning/upcoming-choices?days=3
 *
 * Shows upcoming flights (next N days) with the best fuel options at each stop.
 * Cross-references any fuel choices already made by sales reps.
 * Helps dispatchers pick the best vendor BEFORE the flight, not after.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;

  const days = parseInt(req.nextUrl.searchParams.get("days") ?? "3", 10);
  const supa = createServiceClient();

  // 1. Get upcoming flights (starting tomorrow in Eastern time)
  const etNow = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
  const tomorrow = new Date(etNow);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const startDate = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, "0")}-${String(tomorrow.getDate()).padStart(2, "0")}`;
  const endDate = (() => {
    const d = new Date(etNow);
    d.setDate(d.getDate() + days);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  })();

  const { data: flights, error: flightsErr } = await supa
    .from("flights")
    .select("id, jetinsight_trip_id, tail_number, departure_icao, arrival_icao, origin_fbo, scheduled_departure, scheduled_arrival, salesperson")
    .gte("scheduled_departure", `${startDate}T00:00:00`)
    .lte("scheduled_departure", `${endDate}T23:59:59`)
    .order("scheduled_departure", { ascending: true });

  if (flightsErr) {
    return NextResponse.json({ error: flightsErr.message }, { status: 500 });
  }

  // Filter out placeholder flights (no trip ID = no FBO/fuel data)
  const validFlights = (flights ?? []).filter((f) => f.jetinsight_trip_id);

  if (!validFlights.length) {
    return NextResponse.json({ ok: true, stops: [], summary: { totalStops: 0, stopsWithChoice: 0, stopsWithBetterOption: 0 } });
  }

  // 2. Get advertised prices
  let advertisedPrices: Awaited<ReturnType<typeof fetchAdvertisedPrices>> = [];
  try {
    advertisedPrices = await fetchAdvertisedPrices({ recentWeeks: 4 });
  } catch { /* continue without */ }

  const bestRates = buildBestRateByAirport(advertisedPrices);

  // 2b. Get cached plan gallons (from tankering-plans cron)
  const { data: cachedPlans } = await supa
    .from("fuel_plan_cache")
    .select("tail_number, departure_icao, gallons_order")
    .gte("plan_date", startDate)
    .lte("plan_date", endDate);

  const cachedGallons = new Map<string, number>();
  for (const row of cachedPlans ?? []) {
    // Key by tail+airport, use the latest/largest gallons if multiple
    const key = `${row.tail_number}|${row.departure_icao}`;
    const existing = cachedGallons.get(key) ?? 0;
    if (row.gallons_order > existing) cachedGallons.set(key, row.gallons_order);
  }

  // 3. Get any existing fuel choices for these trips
  //    Primary match: jetinsight_trip_id + airport_code
  //    Fallback match: tail_number + airport_code within date range
  //    (trip IDs can differ between schedule sync and trip notes scraper)
  type ChoiceEntry = { vendor: string; price: number; tier: string; fbo: string; salesperson: string | null };
  const choicesByTrip: Record<string, ChoiceEntry> = {};
  const choicesByTailAirport: Record<string, ChoiceEntry> = {};

  const tripIds = [...new Set(validFlights.map((f) => f.jetinsight_trip_id).filter(Boolean))];

  // Fetch choices matching trip IDs
  if (tripIds.length > 0) {
    const { data: choices } = await supa
      .from("trip_fuel_choices")
      .select("jetinsight_trip_id, airport_code, fuel_vendor, price_per_gallon, volume_tier, fbo_name, salesperson")
      .in("jetinsight_trip_id", tripIds);

    for (const c of choices ?? []) {
      choicesByTrip[`${c.jetinsight_trip_id}|${c.airport_code}`] = {
        vendor: c.fuel_vendor,
        price: c.price_per_gallon,
        tier: c.volume_tier,
        fbo: c.fbo_name,
        salesperson: c.salesperson,
      };
    }
  }

  // Fetch recent choices by airport for fallback matching (last 14 days covers any scraped trips)
  const tails = [...new Set(validFlights.map((f) => f.tail_number).filter(Boolean))];
  const airports = [...new Set(validFlights.map((f) => f.departure_icao).filter(Boolean))];
  if (tails.length > 0 && airports.length > 0) {
    const lookback = new Date();
    lookback.setDate(lookback.getDate() - 7);
    const { data: recentChoices } = await supa
      .from("trip_fuel_choices")
      .select("jetinsight_trip_id, airport_code, fuel_vendor, price_per_gallon, volume_tier, fbo_name, tail_number, flight_date, salesperson")
      .in("airport_code", airports)
      .gte("created_at", lookback.toISOString())
      .order("created_at", { ascending: false });

    for (const c of recentChoices ?? []) {
      // Index by tail+airport (most recent wins since sorted desc)
      const key = `${c.tail_number}|${c.airport_code}`;
      if (!choicesByTailAirport[key] && c.tail_number) {
        choicesByTailAirport[key] = {
          vendor: c.fuel_vendor,
          price: c.price_per_gallon,
          tier: c.volume_tier,
          fbo: c.fbo_name,
          salesperson: c.salesperson,
        };
      }
      // Also index by fbo+airport (for trips where tail wasn't captured)
      const fboKey = `${c.fbo_name}|${c.airport_code}`;
      if (!choicesByTailAirport[fboKey]) {
        choicesByTailAirport[fboKey] = {
          vendor: c.fuel_vendor,
          price: c.price_per_gallon,
          tier: c.volume_tier,
          fbo: c.fbo_name,
          salesperson: c.salesperson,
        };
      }
    }
  }

  // 4. Build stop-by-stop recommendations
  const stops = validFlights.map((flight) => {
    const airport = flight.departure_icao;
    const fbo = flight.origin_fbo;
    const tail = flight.tail_number;
    const depDate = flight.scheduled_departure?.split("T")[0] ?? "";
    const depTime = flight.scheduled_departure?.split("T")[1]?.slice(0, 5) ?? "";

    // Best rate at this FBO
    const fboRate = fbo ? getBestRateAtFbo(advertisedPrices, airport, fbo, 300) : null;

    // All rates at this FBO (for comparison)
    const allRates = fbo ? getAllRatesAtFbo(advertisedPrices, airport, fbo) : [];

    // Best rate at the airport (any FBO)
    const variants = airportVariants(airport);
    let airportBest: { price: number; vendor: string; fbo?: string | null } | null = null;
    for (const v of variants) {
      const r = bestRates.get(v);
      if (r) { airportBest = r; break; }
    }

    // Check if rep already made a choice
    // Try: exact trip ID match → tail+airport fallback → fbo+airport fallback
    const repChoice =
      choicesByTrip[`${flight.jetinsight_trip_id}|${airport}`] ??
      choicesByTailAirport[`${tail}|${airport}`] ??
      (fbo ? choicesByTailAirport[`${fbo}|${airport}`] : null) ??
      null;

    // Is the rep's choice suboptimal?
    let overpayVsFbo: number | null = null;
    let overpayVsAirport: number | null = null;
    if (repChoice && fboRate) {
      overpayVsFbo = Math.max(0, repChoice.price - fboRate.price);
    }
    if (repChoice && airportBest) {
      overpayVsAirport = Math.max(0, repChoice.price - airportBest.price);
    }

    return {
      flightId: flight.id,
      tripId: flight.jetinsight_trip_id,
      tail,
      airport,
      arrivalAirport: flight.arrival_icao,
      fbo: fbo ?? null,
      date: depDate,
      time: depTime,
      // Best options
      bestAtFbo: fboRate ? { vendor: fboRate.vendor, price: fboRate.price, tier: fboRate.tier } : null,
      bestAtAirport: airportBest ? { vendor: airportBest.vendor, price: airportBest.price, fbo: airportBest.fbo } : null,
      allVendors: allRates.slice(0, 5).map((r) => ({ vendor: r.vendor, price: r.price, tier: r.tier })),
      // Rep's choice (if any)
      salesperson: repChoice?.salesperson || flight.salesperson || null,
      repChoice: repChoice ? {
        vendor: repChoice.vendor,
        price: repChoice.price,
        tier: repChoice.tier,
        salesperson: repChoice.salesperson,
      } : null,
      overpayVsFbo,
      overpayVsAirport,
      // Estimate waste: overpay/gal * gallons (cached from tankering plan, or 300 gal fallback)
      estimatedGallons: cachedGallons.get(`${tail}|${airport}`) ?? 300,
      estimatedWaste: (overpayVsFbo ?? 0) > 0.01
        ? Math.round((overpayVsFbo ?? 0) * (cachedGallons.get(`${tail}|${airport}`) ?? 300))
        : null,
    };
  });

  // Filter to only stops where fuel would be purchased (departure airports)
  // and dedupe by trip+airport
  const seen = new Set<string>();
  const dedupedStops = stops.filter((s) => {
    const key = `${s.tripId}|${s.airport}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const stopsWithChoice = dedupedStops.filter((s) => s.repChoice);
  const stopsWithBetterOption = dedupedStops.filter((s) => (s.overpayVsFbo ?? 0) > 0.01);
  const totalEstimatedWaste = dedupedStops.reduce((sum, s) => sum + (s.estimatedWaste ?? 0), 0);

  return NextResponse.json({
    ok: true,
    stops: dedupedStops,
    summary: {
      totalStops: dedupedStops.length,
      stopsWithChoice: stopsWithChoice.length,
      stopsWithBetterOption: stopsWithBetterOption.length,
      totalEstimatedWaste,
    },
  });
}
