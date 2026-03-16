import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthed, isRateLimited } from "@/lib/api-auth";
import { buildVanSlackHeaderBlocks, buildAircraftSlackBlocks, buildVanSlackFallbackText, buildAircraftFallbackText, type VanSlackItem } from "@/lib/vanSlackBlocks";
import { createServiceClient } from "@/lib/supabase/service";

/**
 * POST /api/vans/share-slack
 *
 * Shares a van's daily schedule to a Slack channel.
 * Requires SLACK_BOT_TOKEN env var (xoxb-...) with chat:write scope.
 *
 * Body: { channel: string, vanName: string, vanId: number, homeAirport: string, date: string, items: VanSlackItem[] }
 */

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

  try {
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

    // 1) Send header message
    const headerData = await postMessage({
      channel,
      text: buildVanSlackFallbackText(vanName, date),
      blocks: buildVanSlackHeaderBlocks(vanName, vanId, homeAirport, date, items.length),
    });
    if (!headerData.ok) {
      return NextResponse.json({ error: headerData.error ?? "Slack API error" }, { status: 502 });
    }
    const threadTs = headerData.ts;

    // 2) Send each aircraft as a threaded reply
    for (const item of items) {
      await postMessage({
        channel,
        thread_ts: threadTs,
        text: buildAircraftFallbackText(item),
        blocks: buildAircraftSlackBlocks(item),
      });
    }

    // Save the shared schedule to DB for persistence
    try {
      const supa = createServiceClient();
      await supa.from("van_published_schedules").upsert(
        {
          van_id: vanId,
          schedule_date: date,
          flight_ids: items.map((i) => i.tail),
          published_by: auth.userId,
          published_at: new Date().toISOString(),
        },
        { onConflict: "van_id,schedule_date" },
      );
    } catch {
      // Non-fatal — Slack messages were sent successfully
    }

    return NextResponse.json({ ok: true, ts: threadTs, channel: headerData.channel, aircraftCount: items.length });
  } catch (err) {
    return NextResponse.json({ error: "Slack API request failed" }, { status: 502 });
  }
}
