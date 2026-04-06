import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthed, isRateLimited } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";
import { randomBytes } from "crypto";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const DEFAULT_FUEL_CHANNEL = "C0ANTTQ6R96"; // #fuel-planning

/**
 * POST /api/fuel-planning/send-tankering-alerts
 *
 * 1. Calls the generate endpoint internally to get next-day plans
 * 2. For tails with savings > 0, creates shareable plan links (24h expiry)
 * 3. Sends Slack messages with links
 *
 * Body: { date?: "YYYY-MM-DD" }
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;
  if (await isRateLimited(auth.userId, 5)) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const body = await req.json().catch(() => ({}));
  const targetDate = (body.date as string) || tomorrow();

  // 1. Generate fuel plans by calling the generate endpoint internally
  const origin = req.nextUrl.origin;
  const cookie = req.headers.get("cookie") ?? "";
  const genRes = await fetch(`${origin}/api/fuel-planning/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie },
    body: JSON.stringify({ date: targetDate }),
  });

  if (!genRes.ok) {
    const err = await genRes.json().catch(() => ({ error: "Generate failed" }));
    return NextResponse.json({ error: err.error ?? "Failed to generate plans" }, { status: 500 });
  }

  const genData = await genRes.json();
  const plans = genData.plans ?? [];

  // 2. Include all valid plans (with or without tankering savings) — fuel vendor plan is always useful
  const validPlans = plans.filter(
    (p: { plan: unknown; error?: string }) => p.plan && !p.error
  );

  if (validPlans.length === 0) {
    return NextResponse.json({
      ok: true,
      message: "No fuel plans generated for " + targetDate,
      sent: 0,
    });
  }

  const supa = createServiceClient();

  // Look up per-aircraft Slack channels
  const { data: icsSources } = await supa
    .from("ics_sources")
    .select("label, slack_channel_id")
    .not("slack_channel_id", "is", null);
  const channelByTail = new Map<string, string>();
  for (const src of icsSources ?? []) {
    if (src.slack_channel_id) channelByTail.set(src.label?.toUpperCase(), src.slack_channel_id);
  }

  // 3. Create shareable links and send Slack messages
  const results: Array<{ tail: string; token: string; channel: string; sent: boolean }> = [];
  const slackToken = process.env.SLACK_BOT_TOKEN;

  const strip = (c: string) => c.length === 4 && c.startsWith("K") ? c.slice(1) : c;

  for (const plan of validPlans) {
    const token = randomBytes(24).toString("base64url");
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

    // Store the plan with token
    const { error: insertErr } = await supa.from("fuel_plan_links").insert({
      token,
      tail_number: plan.tail,
      aircraft_type: plan.aircraftType,
      date: targetDate,
      plan_data: plan,
      expires_at: expiresAt,
    });

    if (insertErr) {
      console.error(`[tankering-alerts] Failed to create link for ${plan.tail}:`, insertErr.message);
      continue;
    }

    // Build the shareable URL
    const planUrl = `${origin}/tanker/plan/${token}`;

    const savings = Math.round(plan.tankerSavings);

    // Send Slack message — just the tail and a link
    const channel = channelByTail.get(plan.tail.toUpperCase()) ?? DEFAULT_FUEL_CHANNEL;

    if (slackToken) {
      try {
        // Build vendor summary lines
        const vendorLines: string[] = [];
        for (const leg of (plan.legs ?? [])) {
          const from = strip(leg.from);
          const vendor = leg.departureFboVendor || "—";
          const price = leg.departurePricePerGal > 0 ? `$${leg.departurePricePerGal.toFixed(2)}/gal` : "N/A";
          vendorLines.push(`${from}: ${vendor} @ ${price}`);
        }

        const headerText = savings > 0
          ? `*${plan.tail}* — Fuel Briefing  (~$${savings.toLocaleString()} tankering savings)`
          : `*${plan.tail}* — Fuel Briefing`;

        const bodyParts = [];
        if (vendorLines.length > 0) {
          bodyParts.push(`*Vendor Plan:*\n${vendorLines.map((l) => `  ${l}`).join("\n")}`);
        }

        const slackRes = await fetch("https://slack.com/api/chat.postMessage", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${slackToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            channel,
            blocks: [
              {
                type: "section",
                text: { type: "mrkdwn", text: headerText },
                accessory: {
                  type: "button",
                  text: { type: "plain_text", text: "View Plan" },
                  url: planUrl,
                },
              },
              ...(bodyParts.length > 0 ? [{
                type: "section",
                text: { type: "mrkdwn", text: bodyParts.join("\n\n") },
              }] : []),
            ],
            text: `${plan.tail} fuel briefing — ${planUrl}`,
          }),
        });

        const slackData = await slackRes.json();
        results.push({ tail: plan.tail, token, channel, sent: slackData.ok === true });

        if (!slackData.ok) {
          console.error(`[tankering-alerts] Slack error for ${plan.tail}:`, slackData.error);
        }
      } catch (err) {
        console.error(`[tankering-alerts] Slack send failed for ${plan.tail}:`, err);
        results.push({ tail: plan.tail, token, channel, sent: false });
      }
    } else {
      console.warn("[tankering-alerts] No SLACK_BOT_TOKEN — skipping Slack messages");
      results.push({ tail: plan.tail, token, channel, sent: false });
    }
  }

  return NextResponse.json({
    ok: true,
    date: targetDate,
    totalPlans: plans.length,
    briefingsSent: validPlans.length,
    sent: results.filter((r) => r.sent).length,
    results,
  });
}

function tomorrow(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}
