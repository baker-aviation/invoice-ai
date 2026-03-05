import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, isRateLimited } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";

const CATEGORY_LABELS: Record<string, string> = {
  chief_pilot: "Chief Pilot",
  operations: "Operations",
  tims: "Tim's",
  maintenance: "Maintenance",
};

/**
 * GET /api/pilot/bulletins/[id]/share — list Slack channels the bot can post to
 */
export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req);
  if ("error" in auth) return auth.error;

  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) {
    return NextResponse.json({ ok: false, channels: [], error: "SLACK_BOT_TOKEN not configured" });
  }

  try {
    // Fetch channels the bot is a member of (public + private)
    const res = await fetch(
      "https://slack.com/api/conversations.list?types=public_channel,private_channel&exclude_archived=true&limit=200",
      { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" },
    );
    const data = await res.json();
    if (!data.ok) {
      return NextResponse.json({ ok: false, channels: [], error: data.error });
    }

    const channels = (data.channels ?? [])
      .map((c: { id: string; name: string; is_private: boolean; is_member: boolean }) => ({
        id: c.id,
        name: c.name,
        is_private: c.is_private,
        is_member: c.is_member,
      }))
      .sort((a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name));

    return NextResponse.json({ ok: true, channels });
  } catch (err) {
    return NextResponse.json({ ok: false, channels: [], error: String(err) }, { status: 502 });
  }
}

/**
 * POST /api/pilot/bulletins/[id]/share — share bulletin to a Slack channel (admin only)
 * Body: { channel_id: string }
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAdmin(req);
  if ("error" in auth) return auth.error;

  if (isRateLimited(auth.userId, 10)) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const { id } = await params;
  const bulletinId = Number(id);
  if (!bulletinId || isNaN(bulletinId)) {
    return NextResponse.json({ error: "Invalid bulletin ID" }, { status: 400 });
  }

  let body: { channel_id?: string };
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  const channelId = body.channel_id || "C04AM137PEE";

  const supa = createServiceClient();
  const { data: bulletin, error } = await supa
    .from("pilot_bulletins")
    .select("id, title, summary, category, slack_ts")
    .eq("id", bulletinId)
    .single();

  if (error || !bulletin) {
    return NextResponse.json({ error: "Bulletin not found" }, { status: 404 });
  }

  const slackToken = process.env.SLACK_BOT_TOKEN;
  if (!slackToken) {
    return NextResponse.json({ error: "SLACK_BOT_TOKEN not configured" }, { status: 503 });
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL || "https://baker-ai-gamma.vercel.app";
  const bulletinUrl = `${appUrl}/pilot/bulletins/${bulletin.id}`;
  const categoryLabel = CATEGORY_LABELS[bulletin.category] || bulletin.category;

  // Strip HTML from summary for Slack
  const plainSummary = bulletin.summary
    ? bulletin.summary.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim()
    : null;

  const slackPayload = {
    channel: channelId,
    text: `New ${categoryLabel} Bulletin: ${bulletin.title}`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `📋 *New ${categoryLabel} Bulletin*\n*${bulletin.title}*${plainSummary ? `\n${plainSummary}` : ""}`,
        },
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "View Bulletin", emoji: true },
            url: bulletinUrl,
          },
        ],
      },
    ],
  };

  try {
    const res = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${slackToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(slackPayload),
    });
    const slackData = await res.json();

    if (!slackData.ok) {
      return NextResponse.json({ error: slackData.error ?? "Slack API error" }, { status: 502 });
    }

    if (slackData.ts) {
      await supa
        .from("pilot_bulletins")
        .update({ slack_ts: slackData.ts })
        .eq("id", bulletin.id);
    }

    return NextResponse.json({ ok: true, ts: slackData.ts, channel: channelId });
  } catch (err) {
    console.error("[pilot/bulletins] Slack share error:", err);
    return NextResponse.json({ error: "Failed to post to Slack" }, { status: 502 });
  }
}
