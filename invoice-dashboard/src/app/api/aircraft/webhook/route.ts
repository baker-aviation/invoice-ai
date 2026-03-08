import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { updateFlightInCache } from "@/lib/flightCache";
import type { FlightInfo } from "@/lib/flightaware";

export const dynamic = "force-dynamic";

/**
 * FlightAware AeroAPI webhook receiver.
 *
 * FA sends POST requests here when alert events fire (filed, departure,
 * arrival, cancelled, diverted). We store the event in Supabase and
 * update the flight in cache directly — no full FA re-poll needed.
 *
 * Auth: shared secret as query param — ?secret=<FLIGHTAWARE_WEBHOOK_SECRET>
 */

export async function POST(req: NextRequest) {
  // Validate webhook secret (trim to guard against Vercel env var whitespace)
  const secret = process.env.FLIGHTAWARE_WEBHOOK_SECRET?.trim();
  if (!secret) {
    console.error("[FA Webhook] FLIGHTAWARE_WEBHOOK_SECRET not configured");
    return NextResponse.json({ error: "not configured" }, { status: 503 });
  }

  const reqSecret = req.nextUrl.searchParams.get("secret")?.trim() ?? null;
  if (reqSecret !== secret) {
    console.warn(`[FA Webhook] Secret mismatch — env len=${secret.length} req len=${reqSecret?.length ?? "null"} envStart=${secret.slice(0, 6)} reqStart=${reqSecret?.slice(0, 6) ?? "null"}`);
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

  // Update the specific flight in cache instead of invalidating everything
  if (faFlightId && registration) {
    const update: Partial<FlightInfo> & { fa_flight_id: string } = {
      fa_flight_id: faFlightId,
      ident: ident ?? undefined,
      aircraft_type: aircraftType,
      origin_icao: origin,
      destination_icao: destination,
      diverted: eventCode === "diverted",
      cancelled: eventCode === "cancelled",
    };

    // Map event codes to status
    if (eventCode === "departure") {
      update.status = "En Route";
      update.actual_departure = new Date().toISOString();
    } else if (eventCode === "arrival") {
      update.status = "Landed";
      update.actual_arrival = new Date().toISOString();
    } else if (eventCode === "cancelled") {
      update.status = "Cancelled";
    } else if (eventCode === "diverted") {
      update.status = "Diverted";
    } else if (eventCode === "filed") {
      update.status = "Filed";
    }

    updateFlightInCache(registration, update).catch((err) => {
      console.error("[FA Webhook] Cache update failed:", err);
    });
  }

  // Process events immediately for real-time alerts (fire-and-forget)
  import("@/lib/flightEvents").then(m => m.processFlightEvents()).catch(() => {});

  return NextResponse.json({ ok: true, event_code: eventCode });
}
