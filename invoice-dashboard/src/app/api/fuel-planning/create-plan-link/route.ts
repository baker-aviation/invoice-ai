import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthed, isRateLimited } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";
import { randomBytes } from "crypto";

export const dynamic = "force-dynamic";

/**
 * POST /api/fuel-planning/create-plan-link
 *
 * Creates a shareable plan link from existing plan data.
 * Returns the token and full URL.
 *
 * Body: {
 *   tail: string,
 *   aircraftType: string,
 *   date: string,
 *   plan: object,  // full TailPlan object
 *   send_slack?: boolean,
 *   slack_channel?: string,
 * }
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;
  if (await isRateLimited(auth.userId, 20)) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const body = await req.json().catch(() => ({}));
  const tail = body.tail as string;
  const aircraftType = body.aircraftType as string;
  const date = body.date as string;
  const planData = body.plan;

  if (!tail || !date || !planData) {
    return NextResponse.json({ error: "tail, date, and plan required" }, { status: 400 });
  }

  const token = randomBytes(24).toString("base64url");
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

  const supa = createServiceClient();
  const { error: insertErr } = await supa.from("fuel_plan_links").insert({
    token,
    tail_number: tail,
    aircraft_type: aircraftType ?? null,
    date,
    plan_data: planData,
    expires_at: expiresAt,
  });

  if (insertErr) {
    console.error("[create-plan-link] insert error:", insertErr.message);
    return NextResponse.json({ error: "Failed to create link" }, { status: 500 });
  }

  const origin = req.nextUrl.origin;
  const planUrl = `${origin}/tanker/plan/${token}`;

  // Optionally send to Slack
  if (body.send_slack && process.env.SLACK_BOT_TOKEN) {
    // Look up per-tail Slack channel, fall back to #fuel-planning
    let channel = (body.slack_channel as string) || "";
    if (!channel) {
      const { data: src } = await supa
        .from("ics_sources")
        .select("slack_channel_id")
        .eq("label", tail.toUpperCase())
        .single();
      channel = "C0ANTTQ6R96"; // Force #fuel-planning for testing
    }
    const savings = Math.round(planData.tankerSavings ?? 0);
    const isPilotSummary = body.mode === "pilot_summary";

    const strip = (c: string) => c.length === 4 && c.startsWith("K") ? c.slice(1) : c;
    const route = planData.legs?.length
      ? [strip(planData.shutdownAirport ?? ""), ...planData.legs.map((l: { to: string }) => strip(l.to))].join("-")
      : tail;

    // Pilot summary: brief confirmation. Dispatch: opportunity with View Plan button.
    const slackPayload = isPilotSummary
      ? {
          channel,
          text: `${tail} ${route} $${savings} saved`,
          blocks: [{ type: "section", text: { type: "mrkdwn", text: `*${tail}*  ${route} — *$${savings.toLocaleString()} saved*` } }],
        }
      : {
          channel,
          text: `${tail} tankering opportunity — ${planUrl}`,
          blocks: [{
            type: "section",
            text: { type: "mrkdwn", text: `*${tail}* — Tankering opportunity (~$${savings.toLocaleString()})` },
            accessory: { type: "button", text: { type: "plain_text", text: "View Plan" }, url: planUrl },
          }],
        };

    try {
      await fetch("https://slack.com/api/chat.postMessage", {
        method: "POST",
        headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify(slackPayload),
      });
    } catch (err) {
      console.error("[create-plan-link] Slack error:", err);
    }
  }

  return NextResponse.json({ ok: true, token, url: planUrl, expires_at: expiresAt });
}
