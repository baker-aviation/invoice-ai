import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthed, isRateLimited } from "@/lib/api-auth";

/**
 * POST /api/vans/share-slack
 *
 * Shares a van's daily schedule to a Slack channel.
 * Requires SLACK_BOT_TOKEN env var (xoxb-...) with chat:write scope.
 *
 * Body: { channel: string, vanName: string, date: string, items: VanSlackItem[] }
 */

type VanSlackItem = {
  tail: string;
  route: string;       // "TEB → PBI"
  arrivalTime: string;  // "14:30 UTC"
  status: string;       // "Scheduled" | "~Landed"
  nextDep?: string;     // "Flying again 18:00 UTC → VNY"
  driveTime?: string;   // "1h 30m drive"
};

type ShareBody = {
  channel: string;
  vanName: string;
  vanId: number;
  homeAirport: string;
  date: string;
  items: VanSlackItem[];
};

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;

  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) {
    return NextResponse.json({
      ok: false,
      channels: [],
      error: "SLACK_BOT_TOKEN not configured",
    });
  }

  // Fetch public channels the bot can post to
  try {
    const res = await fetch("https://slack.com/api/conversations.list?types=public_channel&exclude_archived=true&limit=200", {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    });
    const data = await res.json();
    if (!data.ok) {
      return NextResponse.json({ ok: false, channels: [], error: data.error });
    }
    const channels = (data.channels ?? []).map((c: { id: string; name: string }) => ({
      id: c.id,
      name: c.name,
    }));
    return NextResponse.json({ ok: true, channels });
  } catch (err) {
    return NextResponse.json({ ok: false, channels: [], error: "Slack API request failed" }, { status: 502 });
  }
}

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

  let body: ShareBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { channel, vanName, vanId, homeAirport, date, items } = body;
  if (!channel || !vanName || !date) {
    return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
  }

  // Build Slack blocks
  const header = `*${vanName} (V${vanId})* — ${date}\nBase: ${homeAirport}`;

  const aircraftLines = items.length === 0
    ? ["_No arrivals scheduled_"]
    : items.map((item) => {
        let line = `• *${item.tail}* ${item.route} — Lands ${item.arrivalTime}`;
        if (item.status === "~Landed") line += " _(Landed)_";
        if (item.driveTime) line += ` · ${item.driveTime}`;
        if (item.nextDep) line += `\n  ↳ ${item.nextDep}`;
        return line;
      });

  const slackPayload = {
    channel,
    text: `AOG Van Schedule: ${vanName} — ${date}`,
    blocks: [
      {
        type: "header",
        text: { type: "plain_text", text: `🚐 AOG Van Schedule — ${date}`, emoji: true },
      },
      {
        type: "section",
        text: { type: "mrkdwn", text: header },
      },
      { type: "divider" },
      {
        type: "section",
        text: { type: "mrkdwn", text: aircraftLines.join("\n") },
      },
      {
        type: "context",
        elements: [
          { type: "mrkdwn", text: `Shared from Baker Aviation AOG Van Planner · ${items.length} aircraft` },
        ],
      },
    ],
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
      return NextResponse.json({ error: data.error ?? "Slack API error" }, { status: 502 });
    }
    return NextResponse.json({ ok: true, ts: data.ts, channel: data.channel });
  } catch (err) {
    return NextResponse.json({ error: "Slack API request failed" }, { status: 502 });
  }
}
