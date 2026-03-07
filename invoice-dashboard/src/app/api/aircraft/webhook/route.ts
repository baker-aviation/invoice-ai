import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { invalidateCache } from "@/lib/flightCache";

export const dynamic = "force-dynamic";

/**
 * FlightAware AeroAPI webhook receiver.
 *
 * FA sends POST requests here when alert events fire (filed, departure,
 * arrival, cancelled, diverted). We store the event in Supabase and
 * invalidate the flights cache so the next client poll gets fresh data.
 *
 * Auth: shared secret as query param — ?secret=<FLIGHTAWARE_WEBHOOK_SECRET>
 */

export async function POST(req: NextRequest) {
  // Validate webhook secret
  const secret = process.env.FLIGHTAWARE_WEBHOOK_SECRET;
  if (!secret) {
    console.error("[FA Webhook] FLIGHTAWARE_WEBHOOK_SECRET not configured");
    return NextResponse.json({ error: "not configured" }, { status: 503 });
  }

  const reqSecret = req.nextUrl.searchParams.get("secret");
  if (reqSecret !== secret) {
    console.warn("[FA Webhook] Invalid secret");
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let payload: Record<string, unknown>;
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  // Extract fields from FA webhook payload
  const eventCode = payload.event_code as string | undefined;
  const alertId = payload.alert_id as number | undefined;
  const flight = payload.flight as Record<string, unknown> | undefined;

  if (!eventCode) {
    console.warn("[FA Webhook] Missing event_code:", payload);
    return NextResponse.json({ error: "missing event_code" }, { status: 400 });
  }

  const registration = (flight?.registration as string) ?? null;
  const faFlightId = (flight?.fa_flight_id as string) ?? null;
  const ident = (flight?.ident as string) ?? null;
  const aircraftType = (flight?.aircraft_type as string) ?? null;
  const origin = (flight?.origin as string) ?? null;
  const destination = (flight?.destination as string) ?? null;
  const summary = (payload.summary as string) ?? null;
  const description = (payload.long_description as string) ?? null;

  console.log(
    `[FA Webhook] ${eventCode} | ${registration ?? "?"} | ${origin ?? "?"} → ${destination ?? "?"} | ${summary ?? ""}`,
  );

  // Store in Supabase
  try {
    const supa = createServiceClient();
    await supa.from("flight_events").insert({
      alert_id: alertId ?? null,
      event_code: eventCode,
      fa_flight_id: faFlightId,
      ident,
      registration,
      aircraft_type: aircraftType,
      origin,
      destination,
      summary,
      description,
      raw_payload: payload,
    });
  } catch (err) {
    console.error("[FA Webhook] DB insert failed:", err);
    // Still return 200 so FA doesn't retry endlessly
  }

  // Invalidate flights cache — next client poll will fetch fresh data
  invalidateCache();

  return NextResponse.json({ ok: true, event_code: eventCode });
}
