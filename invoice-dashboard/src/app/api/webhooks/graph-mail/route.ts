import { NextRequest, NextResponse } from "next/server";
import { verifyClientState } from "@/lib/graph-subscriptions";

/**
 * POST /api/webhooks/graph-mail
 *
 * Receives Microsoft Graph change notifications for new emails.
 * Graph sends two types of requests:
 * 1. Validation: POST with ?validationToken=xxx — echo back the token
 * 2. Notification: POST with JSON body containing changed resources
 *
 * We respond 202 immediately, then fire-and-forget the processing
 * to avoid Graph's 3-second timeout.
 */
export async function POST(req: NextRequest) {
  // Step 1: Handle subscription validation
  const validationToken = new URL(req.url).searchParams.get("validationToken");
  if (validationToken) {
    return new NextResponse(validationToken, {
      status: 200,
      headers: { "Content-Type": "text/plain" },
    });
  }

  // Step 2: Parse notification payload
  let body: { value?: Array<GraphNotification> };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const notifications = body.value ?? [];
  if (notifications.length === 0) {
    return NextResponse.json({ ok: true, processed: 0 }, { status: 202 });
  }

  // Step 3: Verify clientState on first notification
  if (!verifyClientState(notifications[0]?.clientState)) {
    console.error("[graph-webhook] Invalid clientState — rejecting");
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // Step 4: Fire-and-forget — call each handler's cron endpoint
  // Graph requires us to respond within 3 seconds, so we don't wait for processing.
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : "");
  const cronSecret = process.env.CRON_SECRET || "";

  // Dedupe: which handlers need to fire?
  const handlersToFire = new Set<string>();

  for (const n of notifications) {
    // resource is like "users/operations@baker-aviation.com/messages/AAMk..."
    const resourceLower = (n.resource ?? "").toLowerCase();

    if (resourceLower.includes("operations@baker-aviation.com") || resourceLower.includes(process.env.OUTLOOK_OPS_MAILBOX?.toLowerCase() ?? "___")) {
      handlersToFire.add("alert-replies");
      handlersToFire.add("fbo-fee-replies");
      handlersToFire.add("cbp-replies");
    }
    if (resourceLower.includes("fuel@baker-aviation.com")) {
      handlersToFire.add("fuel-prices");
    }
    // Fallback: if we can't identify the mailbox, fire all handlers
    if (handlersToFire.size === 0) {
      handlersToFire.add("alert-replies");
      handlersToFire.add("fbo-fee-replies");
      handlersToFire.add("cbp-replies");
      handlersToFire.add("fuel-prices");
    }
  }

  // Map handler names to their cron endpoints
  const HANDLER_ROUTES: Record<string, string> = {
    "alert-replies": "/api/cron/alert-replies",
    "fbo-fee-replies": "/api/cron/fbo-fee-replies",
    "cbp-replies": "/api/ops/intl/parse-cbp-replies",
    "fuel-prices": "/api/fuel-prices/advertised/pull-mailbox",
  };

  // Fire-and-forget: trigger each handler
  for (const handler of handlersToFire) {
    const route = HANDLER_ROUTES[handler];
    if (!route || !appUrl) continue;

    fetch(`${appUrl}${route}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${cronSecret}`,
      },
    }).catch((err) => {
      console.error(`[graph-webhook] Failed to trigger ${handler}:`, err);
    });
  }

  console.log(`[graph-webhook] Received ${notifications.length} notification(s), triggered: ${[...handlersToFire].join(", ")}`);

  return NextResponse.json({ ok: true, processed: notifications.length, triggered: [...handlersToFire] }, { status: 202 });
}

type GraphNotification = {
  subscriptionId: string;
  clientState: string;
  changeType: string;
  resource: string;
  resourceData?: {
    id: string;
    "@odata.type": string;
    "@odata.id": string;
  };
  subscriptionExpirationDateTime: string;
  tenantId: string;
};
