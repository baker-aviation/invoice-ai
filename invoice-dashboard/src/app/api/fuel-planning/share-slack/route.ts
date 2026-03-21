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
  const blocks: Record<string, unknown>[] = [
    {
      type: "header",
      text: { type: "plain_text", text: `⛽ Fleet Fuel Plan — ${date}`, emoji: true },
    },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*Aircraft:*\n${totals.planCount}` },
        { type: "mrkdwn", text: `*Total Fuel Cost:*\n${fmtDollars(totals.totalFuelCost)}` },
        { type: "mrkdwn", text: `*Total Fees:*\n${fmtDollars(totals.totalFees)}` },
        { type: "mrkdwn", text: `*Total Trip Cost:*\n${fmtDollars(totals.totalTripCost)}` },
      ],
    },
  ];

  if (totals.tankerSavings > 0) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `💰 *Tankering Savings: ${fmtDollars(totals.tankerSavings)}* (vs. standard ops ${fmtDollars(totals.naiveCost)})`,
      },
    });
  }

  blocks.push({ type: "divider" });
  return blocks;
}

function buildTailBlocks(tp: TailPlan): Record<string, unknown>[] {
  const plan = tp.plan;
  if (!plan) {
    return [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*${tp.tail}* (${acLabel(tp.aircraftType)}) — ⚠️ ${tp.error || "No plan generated"}`,
        },
      },
    ];
  }

  const blocks: Record<string, unknown>[] = [];

  // Tail header
  let headerText = `*${tp.tail}* (${acLabel(tp.aircraftType)}) — Shutdown: ${fmtNum(tp.shutdownFuel)} lbs @ ${tp.shutdownAirport}`;
  if (tp.tankerSavings > 0) {
    headerText += ` — 💰 Save ${fmtDollars(tp.tankerSavings)}`;
  }
  headerText += ` — Total: ${fmtDollars(plan.totalTripCost)}`;

  blocks.push({
    type: "section",
    text: { type: "mrkdwn", text: headerText },
  });

  // Legs table
  const legLines: string[] = [];
  for (let i = 0; i < tp.legs.length; i++) {
    const leg = tp.legs[i];
    const orderLbs = plan.fuelOrderLbsByStop[i] ?? 0;
    const orderGal = plan.fuelOrderGalByStop[i] ?? 0;
    const landingFuel = plan.landingFuelByStop[i] ?? 0;
    const feePaid = plan.feePaidByStop[i] ?? 0;
    const fbo = leg.departureFbo || leg.waiver?.fboName || "—";
    const feeStr = leg.waiver && leg.waiver.feeWaived > 0
      ? (feePaid > 0 ? `❌ ${fmtDollars(leg.waiver.feeWaived)}` : `✅ ${fmtDollars(leg.waiver.feeWaived)} waived`)
      : "";

    legLines.push(
      `${leg.from} → ${leg.to}  |  ${fmtHrs(leg.flightTimeHours)}  |  ${fmtDollars(leg.departurePricePerGal)}/gal  |  *${fmtNum(orderGal)} gal* (${fmtNum(orderLbs)} lbs)  |  Landing: ${fmtNum(landingFuel)} lbs`
      + (fbo !== "—" ? `\n    _FBO: ${fbo}_` : "")
      + (feeStr ? `  |  ${feeStr}` : "")
    );
  }

  blocks.push({
    type: "section",
    text: { type: "mrkdwn", text: legLines.join("\n") },
  });

  // Tankering recommendations
  const tankerRecs: string[] = [];
  for (let i = 0; i < plan.tankerOutByStop.length; i++) {
    if (plan.tankerOutByStop[i] <= 0) continue;
    const leg = tp.legs[i];
    const tankerIn = plan.tankerInByStop[i] ?? 0;
    tankerRecs.push(
      `🔋 *${leg.from}*: carry +${fmtNum(plan.tankerOutByStop[i])} lbs (${fmtNum(tankerIn)} lbs on arrival at ${leg.to})`
    );
  }
  if (tankerRecs.length) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: tankerRecs.join("\n") },
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
    // 1) Fleet summary header
    const summaryResult = await postMessage({
      channel,
      text: `⛽ Fleet Fuel Plan — ${date} | ${fleetTotals.planCount} aircraft | Total: ${fmtDollars(fleetTotals.totalTripCost)}${fleetTotals.tankerSavings > 0 ? ` | Save ${fmtDollars(fleetTotals.tankerSavings)}` : ""}`,
      blocks: buildFleetSummaryBlocks(date, fleetTotals),
    });

    if (!summaryResult.ok) {
      return NextResponse.json({ error: summaryResult.error ?? "Slack API error" }, { status: 502 });
    }

    // 2) Each tail as a threaded reply
    const threadTs = summaryResult.ts;
    let sent = 0;

    for (const tp of plans) {
      if (!tp.plan) continue;
      const tailBlocks = buildTailBlocks(tp);
      const fallback = `${tp.tail} (${acLabel(tp.aircraftType)}) — ${fmtDollars(tp.plan.totalTripCost)}${tp.tankerSavings > 0 ? ` | Save ${fmtDollars(tp.tankerSavings)}` : ""}`;

      await postMessage({
        channel,
        thread_ts: threadTs,
        text: fallback,
        blocks: tailBlocks,
      });
      sent++;
    }

    return NextResponse.json({ ok: true, sent, threadTs });
  } catch (err) {
    console.error("[fuel-planning/share-slack] Error:", err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
