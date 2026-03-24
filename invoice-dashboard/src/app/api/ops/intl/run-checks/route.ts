import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthed } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";
import { isInternationalIcao } from "@/lib/intlUtils";
import { getFlightsByRegistration } from "@/lib/flightaware";
import type { FaFlight } from "@/lib/flightaware";

/**
 * POST /api/ops/intl/run-checks
 *
 * Combined endpoint that runs all international ops checks:
 * 1. Deadline approaching alerts (permits not approved near deadline)
 * 2. Tail-change detection (aircraft swapped on legs with active permits)
 * 3. Schedule change detection (departure/arrival shifted 30+ min from snapshot)
 * 4. Customs hour conflicts (international arrival outside customs hours)
 *
 * Call this after JI sync or on a 30-minute cron.
 * Also callable from the "Resync JI" button flow.
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;

  const supa = createServiceClient();
  const now = new Date();
  const thirtyDaysOut = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();
  const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();

  const alertsToCreate: Array<{
    flight_id: string;
    alert_type: string;
    severity: string;
    message: string;
    related_country_id?: string;
    related_permit_id?: string;
  }> = [];

  // ── 1. Fetch international flights ──────────────────────────────────
  const { data: flights } = await supa
    .from("flights")
    .select("id, tail_number, departure_icao, arrival_icao, scheduled_departure, scheduled_arrival")
    .gte("scheduled_departure", oneDayAgo)
    .lte("scheduled_departure", thirtyDaysOut)
    .order("scheduled_departure");

  const intlFlights = (flights ?? []).filter(
    (f) => isInternationalIcao(f.departure_icao) || isInternationalIcao(f.arrival_icao)
  );

  if (intlFlights.length === 0) {
    return NextResponse.json({ ok: true, intl_flights: 0, alerts_created: 0 });
  }

  const flightIds = intlFlights.map((f) => f.id);

  // ── 2. Check permit deadlines ───────────────────────────────────────
  const { data: permits } = await supa
    .from("intl_leg_permits")
    .select("id, flight_id, country_id, permit_type, status, deadline, notes, country:countries(name)")
    .in("flight_id", flightIds)
    .neq("status", "approved");

  for (const p of permits ?? []) {
    if (!p.deadline) continue;
    const deadline = new Date(p.deadline + "T00:00:00");
    const daysUntil = Math.ceil((deadline.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));

    // Skip if there's already an unacked alert for this permit
    const { count } = await supa
      .from("intl_leg_alerts")
      .select("id", { count: "exact", head: true })
      .eq("related_permit_id", p.id)
      .eq("alert_type", "deadline_approaching")
      .eq("acknowledged", false);

    if ((count ?? 0) > 0) continue;

    const countryName = (p.country as { name?: string } | null)?.name ?? "Unknown";

    if (daysUntil <= 0) {
      alertsToCreate.push({
        flight_id: p.flight_id,
        alert_type: "deadline_approaching",
        severity: "critical",
        message: `OVERDUE: ${countryName} ${p.permit_type} permit deadline passed (${p.deadline}). Status: ${p.status}`,
        related_country_id: p.country_id,
        related_permit_id: p.id,
      });
    } else if (daysUntil <= 2) {
      alertsToCreate.push({
        flight_id: p.flight_id,
        alert_type: "deadline_approaching",
        severity: "warning",
        message: `${countryName} ${p.permit_type} permit due in ${daysUntil}d (${p.deadline}). Status: ${p.status}`,
        related_country_id: p.country_id,
        related_permit_id: p.id,
      });
    }
  }

  // ── 3. Tail-change detection ────────────────────────────────────────
  for (const p of permits ?? []) {
    const tailMatch = p.notes?.match(/Tail: (\S+)/);
    if (!tailMatch) continue;

    const flight = intlFlights.find((f) => f.id === p.flight_id);
    if (!flight || !flight.tail_number || tailMatch[1] === flight.tail_number) continue;

    // Check for existing unacked tail_change alert
    const { count } = await supa
      .from("intl_leg_alerts")
      .select("id", { count: "exact", head: true })
      .eq("related_permit_id", p.id)
      .eq("alert_type", "tail_change")
      .eq("acknowledged", false);

    if ((count ?? 0) > 0) continue;

    const countryName = (p.country as { name?: string } | null)?.name ?? "Unknown";
    alertsToCreate.push({
      flight_id: flight.id,
      alert_type: "tail_change",
      severity: "critical",
      message: `Aircraft changed ${tailMatch[1]} → ${flight.tail_number} on ${flight.departure_icao}→${flight.arrival_icao}. ${countryName} ${p.permit_type} permit may need resubmission.`,
      related_country_id: p.country_id,
      related_permit_id: p.id,
    });
  }

  // ── 4. Schedule change detection ───────────────────────────────────
  // Compare current flight times to the snapshot stored on each intl_trip.
  // Alert if any leg shifted by 30+ minutes.
  {
    const { data: tripsWithSnapshot } = await supa
      .from("intl_trips")
      .select("id, tail_number, flight_ids, schedule_snapshot")
      .gte("trip_date", new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10))
      .not("schedule_snapshot", "is", null);

    if (tripsWithSnapshot && tripsWithSnapshot.length > 0) {
      // Build current flight times lookup
      const currentTimes = new Map<string, { dep: string; arr: string | null }>();
      for (const f of intlFlights) {
        currentTimes.set(f.id, { dep: f.scheduled_departure, arr: f.scheduled_arrival ?? null });
      }

      const THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes
      const snapshotUpdates: Array<{ tripId: string; snapshot: Record<string, { dep: string; arr: string | null }> }> = [];

      for (const trip of tripsWithSnapshot) {
        const snapshot = trip.schedule_snapshot as Record<string, { dep: string; arr: string | null }> | null;
        if (!snapshot || !trip.flight_ids) continue;

        let tripChanged = false;
        const newSnapshot = { ...snapshot };

        for (const fid of trip.flight_ids as string[]) {
          const curr = currentTimes.get(fid);
          const prev = snapshot[fid];
          if (!curr || !prev) {
            // Flight is new or was removed — update snapshot but don't alert
            if (curr) { newSnapshot[fid] = curr; tripChanged = true; }
            continue;
          }

          const depDelta = Math.abs(new Date(curr.dep).getTime() - new Date(prev.dep).getTime());
          const arrDelta = curr.arr && prev.arr
            ? Math.abs(new Date(curr.arr).getTime() - new Date(prev.arr).getTime())
            : 0;

          if (depDelta >= THRESHOLD_MS || arrDelta >= THRESHOLD_MS) {
            // Check for existing unacked schedule_change alert for this flight
            const { count } = await supa
              .from("intl_leg_alerts")
              .select("id", { count: "exact", head: true })
              .eq("flight_id", fid)
              .eq("alert_type", "schedule_change")
              .eq("acknowledged", false);

            if ((count ?? 0) === 0) {
              const flight = intlFlights.find((f) => f.id === fid);
              const leg = flight ? `${flight.departure_icao}→${flight.arrival_icao}` : fid;
              const prevDep = new Date(prev.dep).toISOString().slice(11, 16);
              const currDep = new Date(curr.dep).toISOString().slice(11, 16);
              // Signed shift: positive = delayed, negative = moved earlier
              const depShiftMin = Math.round(
                (new Date(curr.dep).getTime() - new Date(prev.dep).getTime()) / 60000
              );

              alertsToCreate.push({
                flight_id: fid,
                alert_type: "schedule_change",
                severity: depDelta >= 2 * 60 * 60 * 1000 ? "critical" : "warning",
                message: `${trip.tail_number} ${leg} departure moved ${prevDep}Z → ${currDep}Z (${depShiftMin > 0 ? "+" : ""}${depShiftMin}min). Verify customs/handler timing.`,
              });
            }

            // Update snapshot to current times so we don't re-alert
            newSnapshot[fid] = curr;
            tripChanged = true;
          }
        }

        if (tripChanged) {
          snapshotUpdates.push({ tripId: trip.id, snapshot: newSnapshot });
        }
      }

      // Batch-update snapshots
      if (snapshotUpdates.length > 0) {
        await Promise.all(
          snapshotUpdates.map((u) =>
            supa.from("intl_trips")
              .update({ schedule_snapshot: u.snapshot, updated_at: now.toISOString() })
              .eq("id", u.tripId)
          )
        );
      }
    }
  }

  // ── 5. Customs hour conflicts ───────────────────────────────────────
  const { data: customsAirports } = await supa
    .from("us_customs_airports")
    .select("icao, hours_open, hours_close, timezone, airport_name");

  if (customsAirports && customsAirports.length > 0) {
    const customsMap = new Map(customsAirports.map((a) => [a.icao, a]));

    for (const f of intlFlights) {
      if (!isInternationalIcao(f.departure_icao) || !f.arrival_icao?.startsWith("K") || !f.scheduled_arrival) continue;

      const customs = customsMap.get(f.arrival_icao);
      if (!customs?.hours_close) continue;

      const arrivalHour = new Date(f.scheduled_arrival).getUTCHours();
      const closeHour = parseInt(customs.hours_close.split(":")[0]);

      if (arrivalHour >= closeHour) {
        const { count } = await supa
          .from("intl_leg_alerts")
          .select("id", { count: "exact", head: true })
          .eq("flight_id", f.id)
          .eq("alert_type", "customs_conflict")
          .eq("acknowledged", false);

        if ((count ?? 0) === 0) {
          alertsToCreate.push({
            flight_id: f.id,
            alert_type: "customs_conflict",
            severity: "warning",
            message: `${f.tail_number} arriving ${f.arrival_icao} (${customs.airport_name}) at ${new Date(f.scheduled_arrival).toISOString().slice(11, 16)}Z — customs closes ${customs.hours_close}L`,
          });
        }
      }
    }
  }

  // ── 6. FlightAware delay & diversion detection ─────────────────────
  // Check upcoming intl flights (next 48h) against FA for live delay/diversion data.
  // Only query unique tails to minimize API calls.
  const DELAY_THRESHOLD_MIN = 20;
  const fortyEightHoursOut = new Date(now.getTime() + 48 * 60 * 60 * 1000);
  const upcomingIntl = intlFlights.filter((f) => {
    const dep = new Date(f.scheduled_departure);
    return dep >= now && dep <= fortyEightHoursOut;
  });

  const uniqueTails = [...new Set(upcomingIntl.map((f) => f.tail_number).filter(Boolean))] as string[];
  let faDelayCount = 0;

  if (uniqueTails.length > 0 && process.env.FLIGHTAWARE_API_KEY) {
    // Fetch callsign map from ics_sources for KOW-prefix lookups
    const { data: icsSources } = await supa
      .from("ics_sources")
      .select("tail_number, callsign")
      .in("tail_number", uniqueTails);
    const callsignMap = new Map<string, string>();
    for (const src of icsSources ?? []) {
      if (src.tail_number && src.callsign) callsignMap.set(src.tail_number, src.callsign);
    }

    // Build a lookup: tail+depIcao+arrIcao → flight row (to match FA flights back to our DB flights)
    const flightLookup = new Map<string, typeof upcomingIntl[0]>();
    for (const f of upcomingIntl) {
      if (f.tail_number) {
        flightLookup.set(`${f.tail_number}|${f.departure_icao}|${f.arrival_icao}`, f);
      }
    }

    for (const tail of uniqueTails) {
      try {
        const faFlights = await getFlightsByRegistration(tail, callsignMap);

        for (const fa of faFlights) {
          if (fa.cancelled) continue;
          const faOrigin = fa.origin?.code_icao ?? fa.origin?.code;
          const faDest = fa.destination?.code_icao ?? fa.destination?.code;
          if (!faOrigin || !faDest) continue;

          // Match to our DB flight
          const dbFlight = flightLookup.get(`${tail}|${faOrigin}|${faDest}`);
          if (!dbFlight) continue;

          // ── Diversion check ──
          if (fa.diverted) {
            const { count } = await supa
              .from("intl_leg_alerts")
              .select("id", { count: "exact", head: true })
              .eq("flight_id", dbFlight.id)
              .eq("alert_type", "diversion")
              .eq("acknowledged", false);

            if ((count ?? 0) === 0) {
              alertsToCreate.push({
                flight_id: dbFlight.id,
                alert_type: "diversion",
                severity: "critical",
                message: `DIVERTED: ${tail} ${faOrigin}→${faDest} has been diverted. Check permits and customs for new routing.`,
              });
              faDelayCount++;
            }
            continue; // don't also create a delay alert for diverted flights
          }

          // ── Delay check ──
          const depDelay = fa.departure_delay != null ? Math.round(fa.departure_delay / 60) : null;
          if (depDelay != null && depDelay >= DELAY_THRESHOLD_MIN) {
            // Check for existing unacked delay alert on this flight
            const { data: existing } = await supa
              .from("intl_leg_alerts")
              .select("id, message")
              .eq("flight_id", dbFlight.id)
              .eq("alert_type", "delay")
              .eq("acknowledged", false)
              .limit(1);

            const alreadyAlerted = existing && existing.length > 0;

            // Re-alert if delay worsened by 30+ min
            if (alreadyAlerted) {
              const prevMatch = existing[0].message.match(/delayed (\d+)\s*min/i);
              const prevMin = prevMatch ? parseInt(prevMatch[1]) : 0;
              if (depDelay - prevMin < 30) continue; // not significantly worse
              // Acknowledge the old alert before creating updated one
              await supa.from("intl_leg_alerts")
                .update({ acknowledged: true, acknowledged_by: "system", acknowledged_at: now.toISOString() })
                .eq("id", existing[0].id);
            }

            const scheduledDep = fa.scheduled_out ?? dbFlight.scheduled_departure;
            const estDep = fa.estimated_out ?? fa.scheduled_out;
            const schedTime = scheduledDep ? new Date(scheduledDep).toISOString().slice(11, 16) : "??:??";
            const estTime = estDep ? new Date(estDep).toISOString().slice(11, 16) : "??:??";

            alertsToCreate.push({
              flight_id: dbFlight.id,
              alert_type: "delay",
              severity: depDelay >= 60 ? "critical" : "warning",
              message: `${tail} ${faOrigin}→${faDest} delayed ${depDelay}min (sched ${schedTime}Z → est ${estTime}Z). Verify customs/handler timing.`,
            });
            faDelayCount++;
          }
        }

        // Rate limit between tails
        if (uniqueTails.indexOf(tail) < uniqueTails.length - 1) {
          await new Promise((r) => setTimeout(r, 500));
        }
      } catch (err) {
        console.error(`[intl/run-checks] FA error for ${tail}:`, err instanceof Error ? err.message : err);
      }
    }
  }

  // ── 7. Insert all alerts ────────────────────────────────────────────
  if (alertsToCreate.length > 0) {
    const { error } = await supa.from("intl_leg_alerts").insert(alertsToCreate);
    if (error) {
      console.error("[intl/run-checks] insert error:", error);
      return NextResponse.json({ error: "Failed to create alerts" }, { status: 500 });
    }

    // ── 8. Slack notification for delay/diversion alerts ──────────────
    const slackAlerts = alertsToCreate.filter((a) => a.alert_type === "delay" || a.alert_type === "diversion");
    if (slackAlerts.length > 0) {
      await sendIntlDelaySlack(slackAlerts);
    }
  }

  return NextResponse.json({
    ok: true,
    intl_flights: intlFlights.length,
    permits_checked: (permits ?? []).length,
    alerts_created: alertsToCreate.length,
    fa_delay_alerts: faDelayCount,
  });
}

// ---------------------------------------------------------------------------
// Slack: post delay/diversion alerts to #customs-bosses
// ---------------------------------------------------------------------------

const INTL_DELAY_SLACK_CHANNEL = "C05M76JGKNG"; // #customs-bosses

async function sendIntlDelaySlack(
  alerts: Array<{ flight_id: string; alert_type: string; severity: string; message: string }>,
) {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) {
    console.warn("[intl/slack] SLACK_BOT_TOKEN not set — skipping Slack notification");
    return;
  }

  const blocks: Array<Record<string, unknown>> = [
    {
      type: "header",
      text: { type: "plain_text", text: `International Flight Alert${alerts.length > 1 ? "s" : ""}` },
    },
  ];

  for (const a of alerts) {
    const emoji = a.alert_type === "diversion" ? ":rotating_light:" : a.severity === "critical" ? ":warning:" : ":clock3:";
    const label = a.alert_type === "diversion" ? "DIVERTED" : "DELAYED";
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `${emoji} *${label}*\n${a.message}`,
      },
    });
  }

  blocks.push({
    type: "context",
    elements: [{ type: "mrkdwn", text: `Detected at ${new Date().toISOString().slice(11, 16)}Z by Baker Ops Monitor` }],
  });

  const fallback = alerts.map((a) => a.message).join("\n");

  try {
    const res = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        channel: INTL_DELAY_SLACK_CHANNEL,
        text: fallback,
        blocks,
      }),
    });
    const data = await res.json();
    if (!data.ok) {
      console.error("[intl/slack] Slack error:", data.error);
    } else {
      console.log(`[intl/slack] Posted ${alerts.length} delay/diversion alert(s) to #customs-bosses`);
    }
  } catch (err) {
    console.error("[intl/slack] Slack fetch error:", err instanceof Error ? err.message : err);
  }
}
