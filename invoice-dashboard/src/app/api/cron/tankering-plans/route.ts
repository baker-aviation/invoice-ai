import { NextRequest, NextResponse } from "next/server";
import { verifyCronSecret } from "@/lib/api-auth";
import { syncPostFlightData } from "@/lib/jetinsight/postflight-sync";
import { postSlackMessage } from "@/lib/slack";
import { createServiceClient } from "@/lib/supabase/service";

export const maxDuration = 120;

const FUEL_PLANNING_CHANNEL = "C0ANTTQ6R96"; // #fuel-planning (testing)

/**
 * GET /api/cron/tankering-plans
 *
 * Automated tankering pipeline:
 * 1. Sync latest post-flight data from JetInsight (shutdown fuel)
 * 2. Generate fuel plans for tomorrow (8pm run) or today (7am run)
 * 3. Post clean summary to Slack
 *
 * Scheduled: 8pm ET (0:00 UTC) and 7am ET (11:00 UTC)
 */
export async function GET(req: NextRequest) {
  if (!verifyCronSecret(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const results: Record<string, unknown> = {};

  // 1. Sync post-flight data (last 2 weeks is plenty for shutdown fuel)
  try {
    const pfResult = await syncPostFlightData(undefined, 1);
    results.postFlightSync = {
      inserted: pfResult.inserted,
      skipped: pfResult.skipped,
      pages: pfResult.pages,
      errors: pfResult.errors.slice(0, 5),
      sessionExpired: pfResult.sessionExpired,
    };

    if (pfResult.sessionExpired) {
      return NextResponse.json({
        ok: false,
        error: "JetInsight session expired — post-flight sync aborted",
        ...results,
      });
    }
  } catch (err) {
    results.postFlightSync = { error: String(err) };
  }

  // 2. Determine plan date: after 2pm ET = tomorrow, before = today
  const now = new Date();
  const etHour = parseInt(
    now.toLocaleString("en-US", { timeZone: "America/New_York", hour: "numeric", hour12: false }),
  );
  const planDate = new Date(now);
  if (etHour >= 14) {
    planDate.setDate(planDate.getDate() + 1);
  }
  const dateStr = planDate.toISOString().split("T")[0];
  results.planDate = dateStr;
  results.runTime = `${etHour}:00 ET`;

  // 3. Generate fuel plans via internal API call
  const origin = req.nextUrl.origin;
  let genData: {
    plans?: Array<{
      tail: string;
      aircraftType: string;
      shutdownFuel: number;
      shutdownAirport: string;
      legs: Array<{ from: string; to: string }>;
      plan: { tankerOutByStop: number[]; fuelOrderGalByStop?: number[]; totalFuelCost: number; totalFees: number; totalTripCost: number } | null;
      naiveCost: number;
      tankerSavings: number;
      error?: string;
    }>;
    fleetTotals?: { totalFuelCost: number; totalFees: number; totalTripCost: number; naiveCost: number; tankerSavings: number; planCount: number };
    ok?: boolean;
    error?: string;
    message?: string;
  };

  try {
    const genRes = await fetch(`${origin}/api/fuel-planning/generate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-service-key": process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
      },
      body: JSON.stringify({ date: dateStr }),
    });

    genData = await genRes.json();
    results.generate = {
      ok: genData.ok,
      planCount: genData.plans?.length ?? 0,
      message: genData.message,
      error: genData.error,
    };
  } catch (err) {
    results.generate = { error: String(err) };
    return NextResponse.json({ ok: false, ...results });
  }

  const plans = genData.plans ?? [];
  const fleetTotals = genData.fleetTotals;

  if (!plans.length) {
    results.slack = { skipped: true, reason: genData.message || "No plans generated" };
    return NextResponse.json({ ok: true, ...results });
  }

  // 4. Cache plan gallons for the upcoming-choices API
  try {
    const supa = createServiceClient();
    // Clear old cache for this date
    await supa.from("fuel_plan_cache").delete().eq("plan_date", dateStr);

    const cacheRows = plans.flatMap((tp) => {
      if (!tp.plan || !tp.legs?.length) return [];
      return tp.legs.map((leg, i) => ({
        plan_date: dateStr,
        tail_number: tp.tail,
        aircraft_type: tp.aircraftType,
        leg_index: i,
        departure_icao: leg.from,
        arrival_icao: leg.to,
        gallons_order: tp.plan!.fuelOrderGalByStop?.[i] ?? 0,
        price_per_gal: (leg as { departurePricePerGal?: number }).departurePricePerGal ?? null,
      }));
    });

    if (cacheRows.length > 0) {
      const { error: cacheErr } = await supa.from("fuel_plan_cache").insert(cacheRows);
      results.planCache = { rows: cacheRows.length, error: cacheErr?.message };
    }
  } catch (err) {
    results.planCache = { error: String(err) };
  }

  // 5. Post clean summary to Slack
  const withSavings = plans
    .filter((p) => p.tankerSavings > 0 && p.plan && !p.error)
    .sort((a, b) => b.tankerSavings - a.tankerSavings);

  const noSavings = plans
    .filter((p) => p.plan && !p.error && p.tankerSavings <= 0);

  const strip = (c: string) => c.length === 4 && c.startsWith("K") ? c.slice(1) : c;
  const fmtDollars = (n: number) => "$" + Math.round(n).toLocaleString("en-US");
  const acLabel = (t: string) => t === "CE-750" ? "CX" : t === "CL-30" ? "CL30" : t;

  const buildRoute = (tp: typeof plans[0]) => {
    if (!tp.legs?.length) return tp.shutdownAirport ?? "—";
    return [strip(tp.shutdownAirport), ...tp.legs.map((l) => strip(l.to))].join("-");
  };

  const lines: string[] = [];

  for (const tp of withSavings) {
    const route = buildRoute(tp);
    const fees = tp.plan!.totalFees > 0 ? `  (+${fmtDollars(tp.plan!.totalFees)} fees)` : "";
    lines.push(`*${tp.tail}*  \`${acLabel(tp.aircraftType)}\`  ${route}  *${fmtDollars(tp.tankerSavings)}* saved${fees}`);

    const tankerLegs = (tp.plan?.tankerOutByStop ?? [])
      .map((t, i) => ({ lbs: t, from: tp.legs[i]?.from ?? "?" }))
      .filter((t) => t.lbs > 0);
    if (tankerLegs.length > 0) {
      const detail = tankerLegs
        .map((t) => `+${Math.round(t.lbs).toLocaleString()} lbs at ${strip(t.from)}`)
        .join(", ");
      lines.push(`     _${detail}_`);
    }
  }

  if (noSavings.length > 0) {
    const tails = noSavings.map((tp) => tp.tail).join(", ");
    lines.push(`\n_No tankering opportunity:_ ${tails}`);
  }

  const savingsTotal = fleetTotals?.tankerSavings ?? 0;
  const planCount = fleetTotals?.planCount ?? plans.length;
  const footer = savingsTotal > 0
    ? `*Fleet total: ${fmtDollars(savingsTotal)} saved* across ${withSavings.length} of ${planCount} aircraft`
    : `${planCount} aircraft planned — no tankering opportunities`;

  const runLabel = etHour >= 14 ? "Evening" : "Morning";

  const blocks = [
    {
      type: "header",
      text: { type: "plain_text", text: `${runLabel} Tankering Summary — ${dateStr}`, emoji: true },
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: lines.join("\n") },
    },
    {
      type: "context",
      elements: [{ type: "mrkdwn", text: footer }],
    },
  ];

  try {
    const slackResult = await postSlackMessage({
      channel: FUEL_PLANNING_CHANNEL,
      text: `${runLabel} Tankering Summary — ${dateStr} | ${fmtDollars(savingsTotal)} saved`,
      blocks,
    });

    results.slack = { ok: slackResult?.ok, withSavings: withSavings.length, noSavings: noSavings.length };
  } catch (err) {
    results.slack = { error: String(err) };
  }

  return NextResponse.json({ ok: true, ...results });
}
