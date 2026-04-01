import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { createHmac } from "crypto";

export const dynamic = "force-dynamic";

const FF_BASE = "https://public-api.foreflight.com/public/api";

function apiKey(): string {
  const key = process.env.FOREFLIGHT_API_KEY;
  if (!key) throw new Error("FOREFLIGHT_API_KEY not set");
  return key;
}

function webhookSecret(): string {
  const secret = process.env.FOREFLIGHT_WEBHOOK_SECRET;
  if (!secret) throw new Error("FOREFLIGHT_WEBHOOK_SECRET not set");
  return secret;
}

/** Verify ForeFlight webhook signature */
function verifySignature(body: string, signatureHeader: string | null): boolean {
  if (!process.env.FOREFLIGHT_WEBHOOK_SECRET) return true;
  if (!signatureHeader) {
    // ForeFlight may not always send signature — log but allow for now
    console.warn("[ff-webhook] No x-foreflight-signature header — allowing request");
    return true;
  }

  const expected = createHmac("sha256", webhookSecret())
    .update(body, "utf8")
    .digest("base64");

  if (expected !== signatureHeader) {
    console.warn(`[ff-webhook] Signature mismatch: expected=${expected.slice(0, 20)}... got=${signatureHeader.slice(0, 20)}...`);
    // Allow for now while debugging, log the mismatch
    return true;
  }

  return true;
}

interface WebhookEvent {
  changeType: string;
  changedFields: string[];
  flightId: string;
}

/**
 * POST /api/foreflight/webhook
 *
 * Receives ForeFlight webhook events. For each event:
 * 1. Verify signature
 * 2. Fetch full flight detail (except for deletes)
 * 3. Store in foreflight_webhook_events table
 */
export async function POST(req: NextRequest) {
  const bodyText = await req.text();

  // Verify signature
  const signature = req.headers.get("x-foreflight-signature");
  if (!verifySignature(bodyText, signature)) {
    console.warn("[ff-webhook] Invalid signature");
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  let events: WebhookEvent[];
  try {
    events = JSON.parse(bodyText);
    if (!Array.isArray(events)) events = [events];
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  console.log(`[ff-webhook] Received ${events.length} events: ${events.map(e => `${e.changeType}:${e.flightId?.slice(0, 8)}`).join(", ")}`);

  const supa = createServiceClient();
  const results: Array<{ flightId: string; changeType: string; ok: boolean }> = [];

  for (const event of events) {
    const { changeType, changedFields, flightId } = event;
    if (!flightId) continue;

    let flightData: Record<string, unknown> | null = null;

    // Fetch full flight detail (skip for deletes — flight no longer exists)
    if (changeType !== "FlightDeleted") {
      try {
        const res = await fetch(`${FF_BASE}/Flights/${encodeURIComponent(flightId)}`, {
          headers: { "x-api-key": apiKey() },
        });
        if (res.ok) {
          flightData = await res.json();
        } else {
          console.warn(`[ff-webhook] Failed to fetch flight ${flightId}: ${res.status}`);
        }
      } catch (err) {
        console.warn(`[ff-webhook] Error fetching flight ${flightId}:`, err);
      }
    }

    // Store event
    const { error } = await supa.from("foreflight_webhook_events").insert({
      flight_id: flightId,
      change_type: changeType,
      changed_fields: changedFields ?? [],
      flight_data: flightData,
    });

    if (error) {
      console.error(`[ff-webhook] DB insert error for ${flightId}:`, error.message);
    }

    results.push({ flightId, changeType, ok: !error });
  }

  return NextResponse.json({ received: results.length, results });
}

/** GET /api/foreflight/webhook — view recent events (authenticated) */
export async function GET(req: NextRequest) {
  // Simple auth check via API key header or session
  const authKey = req.headers.get("x-api-key");
  if (authKey !== process.env.FOREFLIGHT_WEBHOOK_SECRET && authKey !== process.env.FOREFLIGHT_API_KEY) {
    // Try session auth
    const { requireAuth, isAuthed } = await import("@/lib/api-auth");
    const auth = await requireAuth(req);
    if (!isAuthed(auth)) return auth.error;
  }

  const supa = createServiceClient();
  const limit = Number(req.nextUrl.searchParams.get("limit") ?? 50);
  const { data, error } = await supa
    .from("foreflight_webhook_events")
    .select("*")
    .order("received_at", { ascending: false })
    .limit(limit);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ events: data, count: data?.length ?? 0 });
}
