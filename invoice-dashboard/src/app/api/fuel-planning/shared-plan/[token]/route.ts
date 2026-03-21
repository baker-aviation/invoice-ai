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
    const mlw = mlwOverrides[String(i)] ?? defaults.mlw;
    const zfw = zfwOverrides[String(i)] ?? defaults.zfw;

    const waiver = leg.waiver ?? getFboWaiver(leg.from, null, acType) ?? {
      fboName: "", minGallons: 0, feeWaived: 0, landingFee: 0, securityFee: 0, overnightFee: 0,
    };

    return {
      id: String(i),
      from: leg.from,
      to: leg.to,
      requiredStartFuelLbs: leg.totalFuelLbs,
      fuelToDestLbs: leg.fuelToDestLbs,
      flightTimeHours: leg.flightTimeHours,
      maxLandingGrossWeightLbs: mlw,
      zeroFuelWeightLbs: zfw,
      maxFuelCapacityLbs: defaults.maxFuel,
      departurePricePerGal: leg.departurePricePerGal,
      waiveFeesGallons: waiver.minGallons,
      feesWaivedDollars: waiver.feeWaived + waiver.landingFee + waiver.securityFee,
    };
  });

  const inputs: MultiRouteInputs = {
    startShutdownFuelLbs: plan.shutdownFuel,
    carryCostPctPerHour: 0.0394,
    fuelTemperatureC: 15,
    arrivalBufferLbs: 0,
    legs: multiLegs,
  };

  const optimized = optimizeMultiLeg(inputs, ppg);

  return NextResponse.json({
    ok: true,
    plan: {
      ...plan,
      plan: optimized,
    },
    mlw_overrides: mlwOverrides,
    zfw_overrides: zfwOverrides,
  });
}
