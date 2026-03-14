import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthed, isRateLimited } from "@/lib/api-auth";
import { buildVanSlackBlocks, buildVanSlackFallbackText, type VanSlackItem } from "@/lib/vanSlackBlocks";

/**
 * POST /api/vans/share-slack-bulk
 *
 * Posts all van schedules to Slack in one call.
 * Each van posts to its mapped channel (falls back to SLACK_VAN_DEFAULT_CHANNEL).
 *
 * Body: { date: string, vans: [{ vanName, vanId, homeAirport, items }] }
 */

type BulkVan = {
  vanName: string;
  vanId: number;
  homeAirport: string;
  channel?: string; // per-van channel override (future)
  items: VanSlackItem[];
};

type BulkBody = {
  date: string;
  vans: BulkVan[];
};

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;

  if (isRateLimited(auth.userId, 10)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) {
    return NextResponse.json(
      { error: "SLACK_BOT_TOKEN not configured — add it to Vercel env vars" },
      { status: 503 },
    );
  }

  const defaultChannel = process.env.SLACK_VAN_DEFAULT_CHANNEL ?? "C0AH20JU68J";

  let body: BulkBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { date, vans } = body;
  if (!date || !Array.isArray(vans) || vans.length === 0) {
    return NextResponse.json({ error: "Missing date or vans array" }, { status: 400 });
  }

  const results: { vanId: number; ok: boolean; error?: string }[] = [];

  for (const van of vans) {
    const channel = van.channel ?? defaultChannel;
    const slackPayload = {
      channel,
      text: buildVanSlackFallbackText(van.vanName, date),
      blocks: buildVanSlackBlocks(van.vanName, van.vanId, van.homeAirport, date, van.items),
    };

    try {
      const res = await fetch("https://slack.com/api/chat.postMessage", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(slackPayload),
      });
      const data = await res.json();
      if (!data.ok) {
        results.push({ vanId: van.vanId, ok: false, error: data.error ?? "Slack API error" });
      } else {
        results.push({ vanId: van.vanId, ok: true });
      }
    } catch (err) {
      results.push({ vanId: van.vanId, ok: false, error: "Slack API request failed" });
    }
  }

  const allOk = results.every((r) => r.ok);
  return NextResponse.json({ ok: allOk, results });
}
