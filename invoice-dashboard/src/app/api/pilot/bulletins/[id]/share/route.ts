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
 * POST /api/pilot/bulletins/[id]/share — share bulletin to #pilots Slack channel (admin only)
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

  const slackPayload = {
    channel: "C04AM137PEE",
    text: `New ${categoryLabel} Bulletin: ${bulletin.title}`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `📋 *New ${categoryLabel} Bulletin*\n*${bulletin.title}*${bulletin.summary ? `\n${bulletin.summary}` : ""}`,
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

    return NextResponse.json({ ok: true, ts: slackData.ts });
  } catch (err) {
    console.error("[pilot/bulletins] Slack share error:", err);
    return NextResponse.json({ error: "Failed to post to Slack" }, { status: 502 });
  }
}
