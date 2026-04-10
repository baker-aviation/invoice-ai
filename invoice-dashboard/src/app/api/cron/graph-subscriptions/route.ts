import { NextRequest, NextResponse } from "next/server";
import { verifyCronSecret, requireAuth, isAuthed } from "@/lib/api-auth";
import { ensureSubscription } from "@/lib/graph-subscriptions";

/**
 * GET /api/cron/graph-subscriptions
 *
 * Ensures Graph mail push subscriptions exist and are renewed.
 * Runs daily via Vercel cron. Can also be triggered manually (with auth).
 *
 * Manages subscriptions for:
 * - operations@baker-aviation.com → alert-replies, fbo-fee-replies, cbp-replies
 * - fuel@baker-aviation.com → fuel-prices
 */

type SubConfig = { mailbox: string; handler: string };

function getSubscriptions(): SubConfig[] {
  const opsMailbox = process.env.OUTLOOK_OPS_MAILBOX || process.env.OUTLOOK_HANDLING_MAILBOX || process.env.OUTLOOK_SHARED_MAILBOX || "operations@baker-aviation.com";
  const fuelMailbox = process.env.OUTLOOK_FUEL_MAILBOX || "fuel@baker-aviation.com";

  return [
    { mailbox: opsMailbox, handler: "alert-replies" },
    { mailbox: opsMailbox, handler: "fbo-fee-replies" },
    { mailbox: opsMailbox, handler: "cbp-replies" },
    { mailbox: fuelMailbox, handler: "fuel-prices" },
  ];
}

async function renewAll(): Promise<{ results: Array<{ handler: string; mailbox: string; status: string; subscriptionId?: string; expiresAt?: string; error?: string }> }> {
  const subs = getSubscriptions();
  const results = [];

  for (const sub of subs) {
    try {
      const result = await ensureSubscription(sub.mailbox, sub.handler);
      results.push({
        handler: sub.handler,
        mailbox: sub.mailbox,
        status: "ok",
        subscriptionId: result.subscriptionId,
        expiresAt: result.expiresAt,
      });
    } catch (err) {
      console.error(`[graph-sub] Failed for ${sub.handler}@${sub.mailbox}:`, err);
      results.push({
        handler: sub.handler,
        mailbox: sub.mailbox,
        status: "error",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { results };
}

/** GET — Vercel cron trigger or manual trigger */
export async function GET(req: NextRequest) {
  if (verifyCronSecret(req)) {
    const result = await renewAll();
    return NextResponse.json({ ok: true, ...result });
  }

  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;

  const result = await renewAll();
  return NextResponse.json({ ok: true, ...result });
}
