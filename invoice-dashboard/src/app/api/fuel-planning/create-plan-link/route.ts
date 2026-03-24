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
    const channel = (body.slack_channel as string) || "C0ANTTQ6R96";
    const acLabel = aircraftType === "CE-750" ? "Citation X" : aircraftType === "CL-30" ? "Challenger 300" : aircraftType;
    const savings = Math.round(planData.tankerSavings ?? 0);
    const route = planData.legs?.length
      ? [planData.shutdownAirport, ...planData.legs.map((l: { to: string }) => l.to)].join(" → ")
      : tail;

    const tankerLegs = (planData.plan?.tankerOutByStop ?? [])
      .map((t: number, i: number) => ({ amount: t, airport: planData.legs?.[i]?.from ?? "?" }))
      .filter((t: { amount: number }) => t.amount > 0);

    const tankerDetail = tankerLegs.length > 0
      ? "\n" + tankerLegs.map((t: { airport: string; amount: number }) => `Tanker +${t.amount.toLocaleString()} lbs at ${t.airport}`).join("\n")
      : "";

    const savingsText = savings > 0 ? `\n*Saves ~$${savings.toLocaleString()}*` : "";

    try {
      await fetch("https://slack.com/api/chat.postMessage", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          channel,
          blocks: [
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: `*${tail}* (${acLabel}) — ${route}${tankerDetail}${savingsText}`,
              },
              accessory: {
                type: "button",
                text: { type: "plain_text", text: "View & Adjust Plan" },
                url: planUrl,
                action_id: "view_fuel_plan",
              },
            },
          ],
          text: `${tail} fuel plan: ${planUrl}`,
        }),
      });
    } catch (err) {
      console.error("[create-plan-link] Slack error:", err);
    }
  }

  return NextResponse.json({ ok: true, token, url: planUrl, expires_at: expiresAt });
}
