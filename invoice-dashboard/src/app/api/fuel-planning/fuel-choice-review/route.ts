import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthed } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";
import { fetchAdvertisedPrices } from "@/lib/invoiceApi";
import { getBestRateAtFbo, buildBestRateByAirport, airportVariants } from "@/lib/fuelLookup";

export const dynamic = "force-dynamic";

/**
 * GET /api/fuel-planning/fuel-choice-review?days=30
 *
 * Returns trip fuel choices enriched with optimal pricing comparison.
 * For each fuel choice the sales rep made, shows:
 *   - What they picked (FBO, vendor, tier, price)
 *   - Best available at that FBO
 *   - Best available at any FBO at the airport
 *   - Overpay per gallon and estimated $ impact
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;

  const days = parseInt(req.nextUrl.searchParams.get("days") ?? "30", 10);
  const supa = createServiceClient();

  // 1. Get trip fuel choices
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);

  const { data: choices, error: choicesErr } = await supa
    .from("trip_fuel_choices")
    .select("*")
    .gte("created_at", cutoff.toISOString())
    .order("created_at", { ascending: false });

  if (choicesErr) {
    return NextResponse.json({ error: choicesErr.message }, { status: 500 });
  }

  if (!choices?.length) {
    return NextResponse.json({ ok: true, choices: [], summary: { totalChoices: 0, totalOverpay: 0 } });
  }

  // 2. Get advertised prices for comparison
  let advertisedPrices: Awaited<ReturnType<typeof fetchAdvertisedPrices>> = [];
  try {
    advertisedPrices = await fetchAdvertisedPrices({ recentWeeks: 4 });
  } catch {
    // Continue without — comparison will be limited
  }

  const bestRates = buildBestRateByAirport(advertisedPrices);

  // 3. Get flight data to estimate gallons purchased
  const tripIds = [...new Set(choices.map((c) => c.jetinsight_trip_id))];
  const { data: flights } = await supa
    .from("flights")
    .select("jetinsight_trip_id, departure_icao, tail_number, origin_fbo, scheduled_departure")
    .in("jetinsight_trip_id", tripIds);

  const flightByTrip = new Map<string, typeof flights extends Array<infer T> ? T : never>();
  for (const f of flights ?? []) {
    if (f.jetinsight_trip_id) {
      // Store by trip_id + airport for matching
      const key = `${f.jetinsight_trip_id}|${f.departure_icao}`;
      flightByTrip.set(key, f);
    }
  }

  // 4. Enrich each choice with comparison data
  const enriched = choices.map((choice) => {
    const flight = flightByTrip.get(`${choice.jetinsight_trip_id}|${choice.airport_code}`);

    // Best price at the specific FBO they used
    // Use a reasonable gallon estimate for tier matching (300 gal ~= 2000 lbs)
    const fboRate = getBestRateAtFbo(advertisedPrices, choice.airport_code, choice.fbo_name, 300);

    // Best price at any FBO at the airport
    const variants = airportVariants(choice.airport_code);
    let airportBest = null;
    for (const v of variants) {
      const r = bestRates.get(v);
      if (r) { airportBest = r; break; }
    }

    const bestAtFbo = fboRate?.price ?? null;
    const bestVendorAtFbo = fboRate?.vendor ?? null;
    const bestAtAirport = airportBest?.price ?? null;
    const bestVendorAtAirport = airportBest?.vendor ?? null;

    const overpayVsFbo = bestAtFbo != null ? Math.max(0, choice.price_per_gallon - bestAtFbo) : null;
    const overpayVsAirport = bestAtAirport != null ? Math.max(0, choice.price_per_gallon - bestAtAirport) : null;

    return {
      ...choice,
      tail_number: flight?.tail_number ?? null,
      flight_date: flight?.scheduled_departure?.split("T")[0] ?? null,
      best_price_at_fbo: bestAtFbo,
      best_vendor_at_fbo: bestVendorAtFbo,
      best_price_at_airport: bestAtAirport,
      best_vendor_at_airport: bestVendorAtAirport,
      overpay_vs_fbo: overpayVsFbo,
      overpay_vs_airport: overpayVsAirport,
    };
  });

  // 5. Summary stats
  const totalOverpayFbo = enriched.reduce((sum, c) => sum + (c.overpay_vs_fbo ?? 0), 0);
  const totalOverpayAirport = enriched.reduce((sum, c) => sum + (c.overpay_vs_airport ?? 0), 0);
  const choicesWithOverpay = enriched.filter((c) => (c.overpay_vs_fbo ?? 0) > 0.01);

  return NextResponse.json({
    ok: true,
    choices: enriched,
    summary: {
      totalChoices: enriched.length,
      choicesWithOverpay: choicesWithOverpay.length,
      avgOverpayPerGalFbo: choicesWithOverpay.length > 0
        ? totalOverpayFbo / choicesWithOverpay.length : 0,
      avgOverpayPerGalAirport: enriched.filter((c) => (c.overpay_vs_airport ?? 0) > 0.01).length > 0
        ? totalOverpayAirport / enriched.filter((c) => (c.overpay_vs_airport ?? 0) > 0.01).length : 0,
    },
  });
}
