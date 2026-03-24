import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, isRateLimited } from "@/lib/api-auth";

/**
 * POST /api/admin/salesperson-slack/test
 *
 * Send a test Slack DM to verify the bot can reach a user.
 * Body: { slack_user_id: string }
 */
export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if ("error" in auth) return auth.error;
  if (await isRateLimited(auth.userId, 10)) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const slackToken = process.env.SLACK_BOT_TOKEN;
  if (!slackToken) {
    return NextResponse.json({ error: "SLACK_BOT_TOKEN not configured" }, { status: 503 });
  }

  let body: { slack_user_id?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const slackUserId = body.slack_user_id?.trim();
  if (!slackUserId) {
    return NextResponse.json({ error: "slack_user_id is required" }, { status: 400 });
  }

  try {
    const res = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${slackToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        channel: slackUserId,
        text: "This is a test message from Baker Aviation. If you received this, your Slack DM notifications are working!",
      }),
    });
    const data = await res.json();

    if (!data.ok) {
      return NextResponse.json({ error: `Slack error: ${data.error}` }, { status: 502 });
    }

    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "Slack API request failed" }, { status: 502 });
  }
}
