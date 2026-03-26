import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthed } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";
import { isInternationalIcao } from "@/lib/intlUtils";
import { sendIntlAlertSlack } from "@/lib/intlAlertSlack";

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

      const THRESHOLD_MS = 60 * 60 * 1000; // 1 hour
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
  // Read from fa_flights table (populated by fa-poll cron every 10 min) instead
  // of calling FA API directly — zero extra API cost.
  const DELAY_THRESHOLD_MIN = 20;
  const fortyEightHoursOut = new Date(now.getTime() + 48 * 60 * 60 * 1000);
  const upcomingIntl = intlFlights.filter((f) => {
    const dep = new Date(f.scheduled_departure);
    return dep >= now && dep <= fortyEightHoursOut;
  });

  const uniqueTails = [...new Set(upcomingIntl.map((f) => f.tail_number).filter(Boolean))] as string[];
  let faDelayCount = 0;

  if (uniqueTails.length > 0) {
    // Fetch cached FA data from fa_flights table (updated every 10 min by fa-poll cron)
    const { data: faRows } = await supa
      .from("fa_flights")
      .select("fa_flight_id, tail, origin_icao, destination_icao, departure_time, arrival_time, actual_departure, actual_arrival, status, diverted, cancelled, progress_percent")
      .in("tail", uniqueTails)
      .gte("updated_at", new Date(now.getTime() - 30 * 60 * 1000).toISOString()); // only fresh data (last 30 min)

    if (faRows && faRows.length > 0) {
      // Build lookups: exact match (tail+dep+arr) and origin-only (tail+dep) for diversions
      const flightLookupExact = new Map<string, typeof upcomingIntl[0]>();
      const flightLookupOrigin = new Map<string, typeof upcomingIntl[0]>();
      for (const f of upcomingIntl) {
        if (f.tail_number) {
          flightLookupExact.set(`${f.tail_number}|${f.departure_icao}|${f.arrival_icao}`, f);
          flightLookupOrigin.set(`${f.tail_number}|${f.departure_icao}`, f);
        }
      }

      for (const fa of faRows) {
        // Allow diverted+cancelled through — FA marks diversions as both
        if (fa.cancelled && !fa.diverted) continue;
        const faOrigin = fa.origin_icao;
        const faDest = fa.destination_icao;
        if (!faOrigin || !fa.tail) continue;

        // Match to our DB flight — try exact first, fall back to origin-only for diversions
        const dbFlight = (faDest ? flightLookupExact.get(`${fa.tail}|${faOrigin}|${faDest}`) : null)
          ?? flightLookupOrigin.get(`${fa.tail}|${faOrigin}`);
        if (!dbFlight) continue;

        // ── Diversion check ──
        if (fa.diverted) {
          const divertedTo = faDest ?? "unknown";
          const originalDest = dbFlight.arrival_icao ?? "unknown";
          const { count } = await supa
            .from("intl_leg_alerts")
            .select("id", { count: "exact", head: true })
            .eq("flight_id", dbFlight.id)
            .eq("alert_type", "diversion")
            .eq("acknowledged", false);

          if ((count ?? 0) === 0) {
            // Find delay from the active sibling entry (ghost entry has garbage values)
            const sibling = faRows.find((s) =>
              !s.cancelled && !s.diverted &&
              s.origin_icao === faOrigin &&
              s.tail === fa.tail
            );
            let delayMin: number | null = null;
            if (sibling?.actual_departure && sibling?.departure_time) {
              const diff = Math.round(
                (new Date(sibling.actual_departure).getTime() - new Date(sibling.departure_time).getTime()) / 60000
              );
              if (diff > 0) delayMin = diff;
            }
            const delayNote = delayMin && delayMin >= DELAY_THRESHOLD_MIN ? ` (delayed ${delayMin}min)` : "";

            const divMsg = divertedTo !== originalDest
              ? `DIVERTED: ${fa.tail} ${faOrigin}→${originalDest} diverted to ${divertedTo}${delayNote}. Check permits and customs for new routing.`
              : `DIVERTED: ${fa.tail} ${faOrigin}→${originalDest} has been diverted${delayNote}. Check permits and customs for new routing.`;
            alertsToCreate.push({
              flight_id: dbFlight.id,
              alert_type: "diversion",
              severity: "critical",
              message: divMsg,
            });
            faDelayCount++;
          }
          continue;
        }

        // ── Delay check ──
        // Compute delay: compare FA departure_time (actual/estimated) vs our scheduled departure
        let depDelayMin: number | null = null;
        const faDepTime = fa.actual_departure ?? fa.departure_time;
        if (faDepTime && dbFlight.scheduled_departure) {
          const diff = Math.round(
            (new Date(faDepTime).getTime() - new Date(dbFlight.scheduled_departure).getTime()) / 60000
          );
          if (diff > 0) depDelayMin = diff;
        }

        if (depDelayMin != null && depDelayMin >= DELAY_THRESHOLD_MIN) {
          const { data: existing } = await supa
            .from("intl_leg_alerts")
            .select("id, message")
            .eq("flight_id", dbFlight.id)
            .eq("alert_type", "delay")
            .eq("acknowledged", false)
            .limit(1);

          const alreadyAlerted = existing && existing.length > 0;

          if (alreadyAlerted) {
            const prevMatch = existing[0].message.match(/delayed (\d+)\s*min/i);
            const prevMin = prevMatch ? parseInt(prevMatch[1]) : 0;
            if (depDelayMin - prevMin < 30) continue;
            await supa.from("intl_leg_alerts")
              .update({ acknowledged: true, acknowledged_by: "system", acknowledged_at: now.toISOString() })
              .eq("id", existing[0].id);
          }

          const schedTime = new Date(dbFlight.scheduled_departure).toISOString().slice(11, 16);
          const estTime = faDepTime ? new Date(faDepTime).toISOString().slice(11, 16) : "??:??";

          alertsToCreate.push({
            flight_id: dbFlight.id,
            alert_type: "delay",
            severity: depDelayMin >= 60 ? "critical" : "warning",
            message: `${fa.tail} ${faOrigin}→${faDest} delayed ${depDelayMin}min (sched ${schedTime}Z → est ${estTime}Z). Verify customs/handler timing.`,
          });
          faDelayCount++;
        }
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
    const slackAlerts = alertsToCreate.filter((a) => a.alert_type === "delay" || a.alert_type === "diversion" || a.alert_type === "schedule_change");
    if (slackAlerts.length > 0) {
      await sendIntlAlertSlack(slackAlerts);
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

