import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import { createServiceClient } from "@/lib/supabase/service";
import { isInternationalIcao } from "@/lib/intlUtils";
import { sendIntlAlertSlack } from "@/lib/intlAlertSlack";
import {
  isDiversionDistanceReasonable,
  createPendingDiversion,
} from "@/lib/diversionCheck";
import { getFlightTrack } from "@/lib/flightaware";
import { extractAltitudeSegments } from "@/lib/altitudeSegments";

export const dynamic = "force-dynamic";

/**
 * FlightAware AeroAPI webhook receiver.
 *
 * FA sends POST requests here when alert events fire (filed, departure,
 * arrival, cancelled, diverted). We store the event in Supabase and
 * upsert the flight into the fa_flights table directly — no full FA re-poll needed.
 *
 * Auth: shared secret via header (preferred) or query param (legacy).
 *   Header: x-webhook-secret: <FLIGHTAWARE_WEBHOOK_SECRET>
 *   Query:  ?secret=<FLIGHTAWARE_WEBHOOK_SECRET>
 */

function safeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export async function POST(req: NextRequest) {
  // Validate webhook secret (trim to guard against Vercel env var whitespace)
  const secret = process.env.FLIGHTAWARE_WEBHOOK_SECRET?.trim();
  if (!secret) {
    console.error("[FA Webhook] FLIGHTAWARE_WEBHOOK_SECRET not configured");
    return NextResponse.json({ error: "not configured" }, { status: 503 });
  }

  // Try header first (preferred), fall back to query param (legacy)
  const headerSecret = req.headers.get("x-webhook-secret")?.trim() ?? null;
  const querySecret = req.nextUrl.searchParams.get("secret")?.trim() ?? null;
  const reqSecret = headerSecret ?? querySecret;

  if (!reqSecret || !safeCompare(reqSecret, secret)) {
    console.warn(`[FA Webhook] Auth failed — source=${headerSecret ? "header" : querySecret ? "query" : "none"}`);
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
  const supa = createServiceClient();
  try {
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

  // Upsert flight data directly into fa_flights table
  if (faFlightId) {
    const upsertData: Record<string, unknown> = {
      fa_flight_id: faFlightId,
      tail: registration,
      ident: ident,
      aircraft_type: aircraftType,
      origin_icao: origin,
      destination_icao: destination,
      updated_at: new Date().toISOString(),
    };

    // Add event-specific fields
    if (eventCode === "departure") {
      upsertData.status = "En Route";
      upsertData.actual_departure = new Date().toISOString();
    } else if (eventCode === "arrival") {
      upsertData.status = "Landed";
      upsertData.actual_arrival = new Date().toISOString();

      // Fire-and-forget: capture ADS-B track while data is fresh
      if (faFlightId && registration) {
        (async () => {
          try {
            // Wait 2 min for FA to finalize the track
            await new Promise((r) => setTimeout(r, 120_000));
            const positions = await getFlightTrack(faFlightId);
            if (!positions?.length) return;
            const altitudes = positions.map((p) => p.altitude ?? 0).filter((a) => a > 0);
            const maxAlt = altitudes.length > 0 ? Math.max(...altitudes) : null;
            let climbSec: number | null = null;
            if (maxAlt && positions.length >= 2) {
              const first = new Date(positions[0].timestamp).getTime();
              const maxPos = positions.find((p) => (p.altitude ?? 0) >= maxAlt! - 5);
              if (maxPos) climbSec = Math.round((new Date(maxPos.timestamp).getTime() - first) / 1000);
            }
            let totalSec: number | null = null;
            if (positions.length >= 2) {
              totalSec = Math.round((new Date(positions[positions.length - 1].timestamp).getTime() - new Date(positions[0].timestamp).getTime()) / 1000);
            }
            const compactPositions = positions.map((p) => ({
              t: p.timestamp, alt: p.altitude, gs: p.groundspeed,
              lat: Math.round((p.latitude ?? 0) * 10000) / 10000,
              lon: Math.round((p.longitude ?? 0) * 10000) / 10000,
            }));

            // Compute altitude segments for step climb analysis
            const depTime = new Date(positions[0].timestamp).getTime();
            const segPositions = positions
              .filter((p) => p.altitude != null)
              .map((p) => ({
                minutesFromDep: (new Date(p.timestamp).getTime() - depTime) / 60000,
                altitudeFl: p.altitude ?? 0,
              }));
            // Determine aircraft type from tail (N5xxFX = CL-30, else CE-750)
            const acType = /^N5\d{2}FX$/i.test(registration) ? "CL-30" : "CE-750";
            const segSummary = extractAltitudeSegments(segPositions, acType, 0); // routeNm=0 for now

            await supa.from("flightaware_tracks").upsert({
              fa_flight_id: faFlightId,
              tail_number: registration,
              origin_icao: origin ?? null,
              destination_icao: destination ?? null,
              flight_date: new Date().toISOString().split("T")[0],
              positions: compactPositions,
              position_count: positions.length,
              max_altitude: maxAlt ? Math.round(maxAlt) : null,
              climb_duration_sec: climbSec,
              total_duration_sec: totalSec,
              segments_summary: segSummary,
            }, { onConflict: "fa_flight_id" });
            console.log(`[FA Webhook] Track captured for ${faFlightId} (${positions.length} positions)`);
          } catch (err) {
            console.error(`[FA Webhook] Track capture failed for ${faFlightId}:`, err);
          }
        })();
      }
    } else if (eventCode === "filed") {
      upsertData.status = "Filed";
    } else if (eventCode === "cancelled") {
      upsertData.status = "Cancelled";
      upsertData.cancelled = true;
    } else if (eventCode === "diverted") {
      upsertData.status = "Diverted";
      upsertData.diverted = true;
    }

    try {
      await supa.from("fa_flights").upsert(upsertData, { onConflict: "fa_flight_id" });
    } catch (err) {
      console.error("[FA Webhook] fa_flights upsert failed:", err);
    }
  }

  // Link FA flight to ICS flight on departure/arrival events
  if (faFlightId && registration && origin && destination &&
      (eventCode === "departure" || eventCode === "arrival")) {
    try {
      const windowMs = 3 * 3600_000;
      const windowStart = new Date(Date.now() - windowMs).toISOString();
      const windowEnd = new Date(Date.now() + windowMs).toISOString();

      const { data: candidates } = await supa
        .from("flights")
        .select("id, scheduled_departure, fa_flight_id")
        .eq("tail_number", registration)
        .eq("departure_icao", origin)
        .eq("arrival_icao", destination)
        .gte("scheduled_departure", windowStart)
        .lte("scheduled_departure", windowEnd);

      if (candidates && candidates.length > 0) {
        let bestId: string | null = null;
        let bestDiff = Infinity;
        for (const c of candidates) {
          if (c.fa_flight_id === faFlightId) { bestId = null; break; } // already linked
          if (c.fa_flight_id) continue; // linked to a different FA flight
          const diff = Math.abs(new Date(c.scheduled_departure).getTime() - Date.now());
          if (diff < bestDiff) { bestDiff = diff; bestId = c.id; }
        }
        if (bestId) {
          await supa.from("flights").update({ fa_flight_id: faFlightId }).eq("id", bestId);
          console.log(`[FA Webhook] Linked ${faFlightId} → ICS flight ${bestId}`);
        }
      }
    } catch (err) {
      console.error("[FA Webhook] ICS link failed:", err);
    }
  }

  // ── International flight alert (diversion/delay via webhook) ──
  // Diversions are held for ~5 min verification (distance check + fa-poll re-verify).
  if (registration && origin && (eventCode === "diverted" || eventCode === "departure")) {
    const isIntl = isInternationalIcao(origin) || isInternationalIcao(destination);
    if (isIntl) {
      try {
        if (eventCode === "diverted") {
          // Find the original destination from our flights table
          const { data: icsMatch } = await supa
            .from("flights")
            .select("id, arrival_icao, scheduled_departure")
            .eq("tail_number", registration)
            .eq("departure_icao", origin)
            .gte("scheduled_departure", new Date(Date.now() - 24 * 3600_000).toISOString())
            .lte("scheduled_departure", new Date(Date.now() + 48 * 3600_000).toISOString())
            .order("scheduled_departure", { ascending: false })
            .limit(1);

          const dbFlight = icsMatch?.[0];
          if (dbFlight) {
            // Check for existing unacked diversion alert
            const { count } = await supa
              .from("intl_leg_alerts")
              .select("id", { count: "exact", head: true })
              .eq("flight_id", dbFlight.id)
              .eq("alert_type", "diversion")
              .eq("acknowledged", false);

            if ((count ?? 0) === 0) {
              const originalDest = dbFlight.arrival_icao ?? "unknown";
              const divertedTo = destination ?? "unknown";
              const msg = divertedTo !== originalDest
                ? `DIVERTED: ${registration} ${origin}→${originalDest} diverted to ${divertedTo}. Check permits and customs for new routing.`
                : `DIVERTED: ${registration} ${origin}→${originalDest} has been diverted. Check permits and customs for new routing.`;

              // Distance sanity check — suppress clearly bogus diversions
              const distCheck = isDiversionDistanceReasonable({
                origin_icao: origin,
                destination_icao: originalDest,
                diverted_to_icao: divertedTo,
              });

              if (!distCheck.reasonable) {
                console.log(`[FA Webhook] Suppressed bogus diversion for ${registration}: ${distCheck.reason}`);
              } else {
                // Hold for ~5 min verification instead of firing immediately
                const inserted = await createPendingDiversion({
                  fa_flight_id: faFlightId!,
                  registration,
                  origin_icao: origin,
                  destination_icao: divertedTo,
                  original_destination: originalDest,
                  flight_id: dbFlight.id,
                  message: msg,
                  source: "webhook",
                });
                if (inserted) {
                  console.log(`[FA Webhook] Intl diversion held for verification: ${registration} ${origin}→${originalDest} → ${divertedTo}`);
                }
              }
            }
          }
        }
        // Note: delay detection stays in run-checks (FA doesn't push delay magnitude — only departure event)
      } catch (err) {
        console.error("[FA Webhook] Intl alert error:", err instanceof Error ? err.message : err);
      }
    }
  }

  // Process events immediately for real-time alerts (fire-and-forget)
  import("@/lib/flightEvents").then(m => m.processFlightEvents()).catch(() => {});

  return NextResponse.json({ ok: true, event_code: eventCode });
}
