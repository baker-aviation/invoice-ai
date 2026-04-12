import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import {
  calcPpg,
  optimizeMultiLeg,
  STD_AIRCRAFT,
  type AircraftType,
  type MultiLeg,
  type MultiRouteInputs,
} from "@/app/tanker/model";
import { getFboWaiver } from "@/lib/fboFeeLookup";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ token: string }> };

/**
 * GET /api/fuel-planning/shared-plan/[token]
 *
 * Returns the plan data for a shared link. NO AUTH REQUIRED.
 * Checks token validity and 24h expiry.
 */
export async function GET(_req: NextRequest, ctx: Ctx) {
  const { token } = await ctx.params;

  const supa = createServiceClient();
  const { data, error } = await supa
    .from("fuel_plan_links")
    .select("*")
    .eq("token", token)
    .single();

  if (error || !data) {
    return NextResponse.json({ error: "Plan not found" }, { status: 404 });
  }

  if (new Date(data.expires_at) < new Date()) {
    return NextResponse.json({ error: "This plan link has expired" }, { status: 410 });
  }

  return NextResponse.json({
    ok: true,
    tail_number: data.tail_number,
    aircraft_type: data.aircraft_type,
    date: data.date,
    plan: data.plan_data,
    expires_at: data.expires_at,
    overrides: data.overrides ?? null,
  });
}

/**
 * POST /api/fuel-planning/shared-plan/[token]
 *
 * Re-runs the optimizer with adjusted MLW and ZFW values.
 * NO AUTH REQUIRED — just needs a valid, non-expired token.
 *
 * Body: {
 *   mlw_overrides?: Record<number, number>,  // leg index → new MLW
 *   zfw_overrides?: Record<number, number>,  // leg index → new ZFW
 * }
 */
export async function POST(req: NextRequest, ctx: Ctx) {
  const { token } = await ctx.params;

  const supa = createServiceClient();
  const { data, error } = await supa
    .from("fuel_plan_links")
    .select("*")
    .eq("token", token)
    .single();

  if (error || !data) {
    return NextResponse.json({ error: "Plan not found" }, { status: 404 });
  }

  if (new Date(data.expires_at) < new Date()) {
    return NextResponse.json({ error: "This plan link has expired" }, { status: 410 });
  }

  const body = await req.json().catch(() => ({}));
  const mlwOverrides = (body.mlw_overrides ?? {}) as Record<string, number>;
  const zfwOverrides = (body.zfw_overrides ?? {}) as Record<string, number>;
  const feeOverrides = (body.fee_overrides ?? {}) as Record<string, number>;
  const waiverGalOverrides = (body.waiver_gal_overrides ?? {}) as Record<string, number>;
  const fuelBurnOverrides = (body.fuel_burn_overrides ?? {}) as Record<string, number>;
  const landingFuelOverrides = (body.landing_fuel_overrides ?? {}) as Record<string, number>;

  const plan = data.plan_data as {
    tail: string;
    aircraftType: AircraftType;
    shutdownFuel: number;
    shutdownAirport: string;
    legs: Array<{
      from: string;
      to: string;
      fuelToDestLbs: number;
      totalFuelLbs: number;
      flightTimeHours: number;
      departurePricePerGal: number;
      ffZfw?: number | null;
      ffMlw?: number | null;
      waiver: {
        fboName: string;
        minGallons: number;
        feeWaived: number;
        landingFee: number;
        securityFee: number;
        overnightFee: number;
      };
    }>;
  };

  if (!plan.legs?.length) {
    return NextResponse.json({ error: "No legs in plan" }, { status: 400 });
  }

  const acType = plan.aircraftType as AircraftType;
  const defaults = STD_AIRCRAFT[acType] ?? STD_AIRCRAFT["CE-750"];
  const ppg = calcPpg(15); // standard temp

  // Rebuild multi-leg inputs with overrides
  const multiLegs: MultiLeg[] = plan.legs.map((leg, i) => {
    const mlw = mlwOverrides[String(i)] ?? leg.ffMlw ?? defaults.mlw;
    const zfw = zfwOverrides[String(i)] ?? leg.ffZfw ?? defaults.zfw;

    const waiver = leg.waiver ?? getFboWaiver(leg.from, null, acType) ?? {
      fboName: "", minGallons: 0, feeWaived: 0, landingFee: 0, securityFee: 0, overnightFee: 0,
    };

    const defaultFee = waiver.feeWaived;
    const fee = feeOverrides[String(i)] ?? defaultFee;
    const waiverGal = waiverGalOverrides[String(i)] ?? waiver.minGallons;

    // Fuel burn override: recalculate totalFuelLbs proportionally
    const fuelBurn = fuelBurnOverrides[String(i)] ?? leg.fuelToDestLbs;
    const landingFuel = landingFuelOverrides[String(i)] ?? 2000;
    const totalFuel = fuelBurn + landingFuel;

    return {
      id: String(i),
      from: leg.from,
      to: leg.to,
      requiredStartFuelLbs: totalFuel,
      fuelToDestLbs: fuelBurn,
      flightTimeHours: leg.flightTimeHours,
      maxLandingGrossWeightLbs: mlw,
      zeroFuelWeightLbs: zfw,
      maxFuelCapacityLbs: defaults.maxFuel,
      departurePricePerGal: leg.departurePricePerGal,
      waiveFeesGallons: waiverGal,
      feesWaivedDollars: fee,
      feeForced: feeOverrides[String(i)] != null,
    };
  });

  const inputs: MultiRouteInputs = {
    startShutdownFuelLbs: plan.shutdownFuel,
    carryCostPctPerHour: 3.94,
    fuelTemperatureC: 15,
    arrivalBufferLbs: 300,
    legs: multiLegs,
  };

  const optimized = optimizeMultiLeg(inputs, ppg);

  // Persist overrides to DB so they survive page refresh
  const hasOverrides = Object.keys(mlwOverrides).length > 0 ||
    Object.keys(zfwOverrides).length > 0 ||
    Object.keys(feeOverrides).length > 0 ||
    Object.keys(waiverGalOverrides).length > 0 ||
    Object.keys(fuelBurnOverrides).length > 0 ||
    Object.keys(landingFuelOverrides).length > 0;

  await supa.from("fuel_plan_links").update({
    updated_at: new Date().toISOString(),
    ...(hasOverrides && {
      overrides: {
        mlw: mlwOverrides,
        zfw: zfwOverrides,
        fee: feeOverrides,
        waiver_gal: waiverGalOverrides,
        fuel_burn: fuelBurnOverrides,
        landing_fuel: landingFuelOverrides,
      },
    }),
  }).eq("token", token);

  if (!optimized) {
    return NextResponse.json({
      ok: true,
      plan: { ...plan, plan: null, error: "Optimizer could not find a valid plan (check weight constraints)" },
    });
  }

  // Use the original naive cost from the stored plan as baseline
  // Savings = original naive cost - new optimized trip cost
  const originalNaiveCost = (data.plan_data as { naiveCost?: number }).naiveCost ?? 0;
  const tankerSavings = Math.max(0, originalNaiveCost - optimized.totalTripCost);

  return NextResponse.json({
    ok: true,
    plan: {
      ...plan,
      plan: optimized,
      naiveCost: originalNaiveCost,
      tankerSavings,
    },
    mlw_overrides: mlwOverrides,
    zfw_overrides: zfwOverrides,
    fee_overrides: feeOverrides,
    waiver_gal_overrides: waiverGalOverrides,
    fuel_burn_overrides: fuelBurnOverrides,
  });
}
