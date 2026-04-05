import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthed, isRateLimited } from "@/lib/api-auth";

export const dynamic = "force-dynamic";

/**
 * POST /api/fuel-planning/share-slack
 *
 * Posts a clean consolidated tankering summary to Slack.
 * Body: { channel: string, date: string, plans: TailPlan[], fleetTotals: FleetTotals }
 */

interface LegData {
  from: string;
  to: string;
  departurePricePerGal: number;
  departureFbo: string | null;
  waiver?: { fboName: string; minGallons: number; feeWaived: number };
}

interface MultiLegPlan {
  fuelOrderGalByStop: number[];
  feePaidByStop: number[];
  tankerOutByStop: number[];
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

function fmtDollars(n: number): string {
  return "$" + Math.round(n).toLocaleString("en-US");
}

function acLabel(t: string): string {
  return t === "CE-750" ? "CX" : t === "CL-30" ? "CL30" : t;
}

function buildRoute(tp: TailPlan): string {
  if (!tp.legs?.length) return tp.shutdownAirport ?? "—";
  // Strip K prefix from ICAO for cleaner display
  const strip = (c: string) => c.length === 4 && c.startsWith("K") ? c.slice(1) : c;
  return [strip(tp.shutdownAirport), ...tp.legs.map((l) => strip(l.to))].join("-");
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

  // Split into savings vs no savings
  const withSavings = plans
    .filter((tp) => tp.tankerSavings > 0 && tp.plan && !tp.error)
    .sort((a, b) => b.tankerSavings - a.tankerSavings);

  const noSavings = plans
    .filter((tp) => tp.plan && !tp.error && tp.tankerSavings <= 0);

  // Build clean message lines
  const lines: string[] = [];

  if (withSavings.length > 0) {
    for (const tp of withSavings) {
      const route = buildRoute(tp);
      const fees = tp.plan!.totalFees > 0 ? `  (+${fmtDollars(tp.plan!.totalFees)} fees)` : "";
      lines.push(`*${tp.tail}*  \`${acLabel(tp.aircraftType)}\`  ${route}  *${fmtDollars(tp.tankerSavings)}* saved${fees}`);

      // Show tankering detail per leg
      const tankerLegs = (tp.plan?.tankerOutByStop ?? [])
        .map((t, i) => ({ lbs: t, from: tp.legs[i]?.from ?? "?" }))
        .filter((t) => t.lbs > 0);
      if (tankerLegs.length > 0) {
        const detail = tankerLegs
          .map((t) => {
            const strip = (c: string) => c.length === 4 && c.startsWith("K") ? c.slice(1) : c;
            return `+${Math.round(t.lbs).toLocaleString()} lbs at ${strip(t.from)}`;
          })
          .join(", ");
        lines.push(`     _${detail}_`);
      }
    }
  }

  if (noSavings.length > 0) {
    const tails = noSavings.map((tp) => tp.tail).join(", ");
    lines.push(`\n_No tankering opportunity:_ ${tails}`);
  }

  // Fleet total
  const savingsTotal = fleetTotals.tankerSavings;
  const footer = savingsTotal > 0
    ? `*Fleet total: ${fmtDollars(savingsTotal)} saved* across ${withSavings.length} of ${fleetTotals.planCount} aircraft`
    : `${fleetTotals.planCount} aircraft planned — no tankering opportunities`;

  const blocks: Record<string, unknown>[] = [
    {
      type: "header",
      text: { type: "plain_text", text: `Tankering Summary — ${date}`, emoji: true },
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

  const fallback = `Tankering Summary — ${date} | ${fmtDollars(savingsTotal)} saved across ${withSavings.length} aircraft`;

  try {
    const res = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ channel, text: fallback, blocks }),
    });

    const result = await res.json();
    if (!result.ok) {
      return NextResponse.json({ error: result.error ?? "Slack API error" }, { status: 502 });
    }

    return NextResponse.json({ ok: true, sent: withSavings.length, ts: result.ts });
  } catch (err) {
    console.error("[fuel-planning/share-slack] Error:", err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
