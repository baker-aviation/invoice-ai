import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthed, isRateLimited } from "@/lib/api-auth";

export const dynamic = "force-dynamic";

/**
 * POST /api/fuel-planning/share-slack
 *
 * Shares fuel plan results to a Slack channel.
 * Body: { channel: string, date: string, plans: TailPlan[], fleetTotals: FleetTotals }
 */

interface LegWaiver {
  fboName: string;
  minGallons: number;
  feeWaived: number;
}

interface LegData {
  from: string;
  to: string;
  fuelToDestLbs: number;
  flightTimeHours: number;
  departurePricePerGal: number;
  departureFbo: string | null;
  departureFboVendor: string | null;
  waiver?: LegWaiver;
}

interface MultiLegPlan {
  fuelOrderLbsByStop: number[];
  fuelOrderGalByStop: number[];
  landingFuelByStop: number[];
  feePaidByStop: number[];
  tankerOutByStop: number[];
  tankerInByStop: number[];
  totalFuelCost: number;
  totalFees: number;
  totalTripCost: number;
}

interface TailPlan {
  tail: string;
  aircraftType: string;
  shutdownFuel: number;
  shutdownAirport: string;
  legs: LegData[];
  plan: MultiLegPlan | null;
  naiveCost: number;
  tankerSavings: number;
  error?: string;
}

interface FleetTotals {
  totalFuelCost: number;
  totalFees: number;
  totalTripCost: number;
  naiveCost: number;
  tankerSavings: number;
  planCount: number;
}

function fmtNum(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

function fmtDollars(n: number): string {
  return "$" + Math.round(n).toLocaleString("en-US");
}

function fmtHrs(h: number): string {
  const hrs = Math.floor(h);
  const min = Math.round((h - hrs) * 60);
  return hrs > 0 ? `${hrs}h ${min}m` : `${min}m`;
}

function acLabel(t: string): string {
  return t === "CE-750" ? "Citation X" : t === "CL-30" ? "Challenger 300" : t;
}

function buildFleetSummaryBlocks(date: string, totals: FleetTotals): Record<string, unknown>[] {
  let summary = `*${totals.planCount} aircraft*  ·  Total: *${fmtDollars(totals.totalTripCost)}*`;
  if (totals.tankerSavings > 0) {
    summary += `  ·  Saves *${fmtDollars(totals.tankerSavings)}*`;
  }

  return [
    {
      type: "header",
      text: { type: "plain_text", text: `Fuel Plan — ${date}`, emoji: true },
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: summary },
    },
  ];
}

function buildTailBlocks(tp: TailPlan): Record<string, unknown>[] {
  const plan = tp.plan;
  if (!plan) {
    return [
      {
        type: "section",
        text: { type: "mrkdwn", text: `*${tp.tail}* ${acLabel(tp.aircraftType)} — ${tp.error || "No plan"}` },
      },
    ];
  }

  const blocks: Record<string, unknown>[] = [];

  // Header line
  const savings = tp.tankerSavings > 0 ? `  ·  Save ${fmtDollars(tp.tankerSavings)}` : "";
  blocks.push({
    type: "section",
    text: {
      type: "mrkdwn",
      text: `*${tp.tail}*  ${acLabel(tp.aircraftType)}  ·  ${fmtDollars(plan.totalTripCost)}${savings}\nShutdown ${fmtNum(tp.shutdownFuel)} lbs @ ${tp.shutdownAirport}`,
    },
  });

  // Legs — one compact block per leg
  for (let i = 0; i < tp.legs.length; i++) {
    const leg = tp.legs[i];
    const orderGal = plan.fuelOrderGalByStop[i] ?? 0;
    const orderLbs = plan.fuelOrderLbsByStop[i] ?? 0;
    const landingFuel = plan.landingFuelByStop[i] ?? 0;
    const feePaid = plan.feePaidByStop[i] ?? 0;
    const fbo = leg.departureFbo || leg.waiver?.fboName || null;

    const lines: string[] = [
      `*${leg.from} → ${leg.to}*  ${fmtHrs(leg.flightTimeHours)}  ·  ${fmtDollars(leg.departurePricePerGal)}/gal`,
      `Order *${fmtNum(orderGal)} gal* (${fmtNum(orderLbs)} lbs)  ·  Landing ${fmtNum(landingFuel)} lbs`,
    ];

    if (fbo) {
      let fboLine = fbo;
      if (leg.waiver && leg.waiver.feeWaived > 0) {
        fboLine += feePaid > 0
          ? `  ·  ${fmtDollars(leg.waiver.feeWaived)} fee (need ${fmtNum(leg.waiver.minGallons)} gal)`
          : `  ·  ${fmtDollars(leg.waiver.feeWaived)} fee waived`;
      }
      lines.push(fboLine);
    }

    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: lines.join("\n") },
    });
  }

  // Tankering
  for (let i = 0; i < plan.tankerOutByStop.length; i++) {
    if (plan.tankerOutByStop[i] <= 0) continue;
    const leg = tp.legs[i];
    const tankerIn = plan.tankerInByStop[i] ?? 0;
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: `Tanker at ${leg.from}: +${fmtNum(plan.tankerOutByStop[i])} lbs → ${fmtNum(tankerIn)} lbs arriving ${leg.to}` }],
    });
  }

  blocks.push({ type: "divider" });
  return blocks;
}

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;
  if (await isRateLimited(auth.userId, 5)) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) {
    return NextResponse.json({ error: "SLACK_BOT_TOKEN not configured" }, { status: 500 });
  }

  const body = await req.json();
  const { channel, date, plans, fleetTotals } = body as {
    channel: string;
    date: string;
    plans: TailPlan[];
    fleetTotals: FleetTotals;
  };

  if (!channel || !date || !plans?.length) {
    return NextResponse.json({ error: "Missing required fields (channel, date, plans)" }, { status: 400 });
  }

  const postMessage = async (payload: Record<string, unknown>) => {
    const res = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    return res.json();
  };

  try {
    // Build all blocks into one message: fleet header + all tails
    const allBlocks: Record<string, unknown>[] = [
      ...buildFleetSummaryBlocks(date, fleetTotals),
    ];

    let sent = 0;
    for (const tp of plans) {
      if (!tp.plan) continue;
      allBlocks.push(...buildTailBlocks(tp));
      sent++;
    }

    // Slack has a 50-block limit per message — truncate if needed
    const blocks = allBlocks.slice(0, 50);

    const fallback = `Fuel Plan — ${date} | ${fleetTotals.planCount} aircraft | ${fmtDollars(fleetTotals.totalTripCost)}`;
    const result2 = await postMessage({
      channel,
      text: fallback,
      blocks,
    });

    if (!result2.ok) {
      return NextResponse.json({ error: result2.error ?? "Slack API error" }, { status: 502 });
    }

    return NextResponse.json({ ok: true, sent, ts: result2.ts });
  } catch (err) {
    console.error("[fuel-planning/share-slack] Error:", err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
