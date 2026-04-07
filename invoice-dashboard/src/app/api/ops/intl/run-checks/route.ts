import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthed, verifyCronSecret } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";
import { isInternationalIcao } from "@/lib/intlUtils";
import { sendIntlAlertSlack } from "@/lib/intlAlertSlack";
import {
  isDiversionDistanceReasonable,
  createPendingDiversion,
  hasPendingDiversion,
} from "@/lib/diversionCheck";

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
/** GET — Vercel cron entry point */
export async function GET(req: NextRequest) {
  if (!verifyCronSecret(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return runChecks();
}

/** POST — manual trigger from dashboard */
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;
  return runChecks();
}

async function runChecks() {

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
                severity: depDelta >= 60 * 60 * 1000 ? "critical" : "warning",
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
            // Check if webhook already created a pending diversion for this flight
            const alreadyPending = fa.fa_flight_id
              ? await hasPendingDiversion(fa.fa_flight_id, dbFlight.id)
              : false;

            if (!alreadyPending) {
              // Distance sanity check
              const distCheck = isDiversionDistanceReasonable({
                origin_icao: faOrigin,
                destination_icao: originalDest,
                diverted_to_icao: divertedTo,
              });

              if (!distCheck.reasonable) {
                console.log(`[intl/run-checks] Suppressed bogus diversion for ${fa.tail}: ${distCheck.reason}`);
              } else {
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

                // Hold for verification instead of firing immediately
                await createPendingDiversion({
                  fa_flight_id: fa.fa_flight_id,
                  registration: fa.tail,
                  origin_icao: faOrigin,
                  destination_icao: divertedTo,
                  original_destination: originalDest,
                  flight_id: dbFlight.id,
                  message: divMsg,
                  source: "run-checks",
                });
                console.log(`[intl/run-checks] Diversion held for verification: ${fa.tail} ${faOrigin}→${originalDest} → ${divertedTo}`);
                faDelayCount++;
              }
            }
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

  // ── 6b. Crew restriction checks (Ticket 6) ────────────────────────
  // Check if any assigned crew violates country restrictions (e.g., age limits)
  {
    // Get countries with crew_restrictions
    const { data: restrictedCountries } = await supa
      .from("countries")
      .select("id, name, iso_code, icao_prefixes, crew_restrictions")
      .not("crew_restrictions", "eq", "[]");

    if (restrictedCountries && restrictedCountries.length > 0) {
      // Get intl trips in the next 30 days
      const { data: upcomingTrips } = await supa
        .from("intl_trips")
        .select("id, tail_number, route_icaos, flight_ids, trip_date")
        .gte("trip_date", new Date().toISOString().slice(0, 10))
        .lte("trip_date", new Date(now.getTime() + 30 * 86400000).toISOString().slice(0, 10));

      if (upcomingTrips && upcomingTrips.length > 0) {
        // Get flight crew assignments
        const allFlightIds = [...new Set(upcomingTrips.flatMap((t) => t.flight_ids ?? []))];
        const { data: flightCrew } = await supa
          .from("flights")
          .select("id, pic, sic")
          .in("id", allFlightIds);

        const crewNames = new Set<string>();
        for (const f of flightCrew ?? []) {
          if (f.pic) crewNames.add(f.pic);
          if (f.sic) crewNames.add(f.sic);
        }

        // Get crew DOB from pilot_profiles
        let crewDobMap = new Map<string, string>();
        if (crewNames.size > 0) {
          const { data: profiles } = await supa
            .from("pilot_profiles")
            .select("full_name, date_of_birth")
            .in("full_name", [...crewNames])
            .not("date_of_birth", "is", null);
          for (const p of profiles ?? []) {
            crewDobMap.set(p.full_name, p.date_of_birth);
          }
        }

        for (const trip of upcomingTrips) {
          // Find which restricted countries this trip visits
          for (const country of restrictedCountries) {
            const restrictions = country.crew_restrictions as Array<{ type: string; value: number; description: string }>;
            if (!restrictions?.length) continue;

            const visitsCountry = trip.route_icaos.some((icao: string) =>
              country.icao_prefixes?.some((p: string) => icao.startsWith(p))
            );
            if (!visitsCountry) continue;

            // Get crew for this trip's flights
            const tripCrew = new Set<string>();
            for (const fid of trip.flight_ids ?? []) {
              const f = (flightCrew ?? []).find((fc) => fc.id === fid);
              if (f?.pic) tripCrew.add(f.pic);
              if (f?.sic) tripCrew.add(f.sic);
            }

            for (const restriction of restrictions) {
              if (restriction.type === "max_age") {
                for (const crewName of tripCrew) {
                  const dob = crewDobMap.get(crewName);
                  if (!dob) continue;
                  const age = Math.floor((now.getTime() - new Date(dob).getTime()) / (365.25 * 86400000));
                  if (age > restriction.value) {
                    // Check for existing alert
                    const alertMsg = `${crewName} (age ${age}) assigned to ${trip.tail_number} ${trip.route_icaos.join("→")} — ${country.name}: ${restriction.description}`;
                    const { count } = await supa
                      .from("intl_leg_alerts")
                      .select("id", { count: "exact", head: true })
                      .eq("alert_type", "crew_restriction")
                      .eq("acknowledged", false)
                      .ilike("message", `%${crewName}%${country.name}%`);

                    if ((count ?? 0) === 0) {
                      alertsToCreate.push({
                        flight_id: trip.flight_ids[0] ?? "00000000-0000-0000-0000-000000000000",
                        alert_type: "crew_restriction",
                        severity: "critical",
                        message: alertMsg,
                        related_country_id: country.id,
                      });
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }

  // ── 6c. CARICOM eAPIS reminders (Ticket 7) ───────────────────────
  {
    const { data: eapisCountries } = await supa
      .from("countries")
      .select("id, name, iso_code, icao_prefixes")
      .eq("eapis_required", true)
      .eq("eapis_provider", "caricom");

    if (eapisCountries && eapisCountries.length > 0) {
      const { data: upcomingTrips } = await supa
        .from("intl_trips")
        .select("id, tail_number, route_icaos, flight_ids, trip_date")
        .gte("trip_date", new Date().toISOString().slice(0, 10))
        .lte("trip_date", new Date(now.getTime() + 7 * 86400000).toISOString().slice(0, 10));

      for (const trip of upcomingTrips ?? []) {
        const tripDate = new Date(trip.trip_date + "T00:00:00");
        const hoursOut = (tripDate.getTime() - now.getTime()) / 3600000;

        for (const country of eapisCountries) {
          const visitsCountry = trip.route_icaos.some((icao: string) =>
            country.icao_prefixes?.some((p: string) => icao.startsWith(p))
          );
          if (!visitsCountry) continue;

          // Check if trip has an eapis_filing clearance step that's completed
          const { data: eapisClearances } = await supa
            .from("intl_trip_clearances")
            .select("id, status, notes")
            .eq("trip_id", trip.id)
            .eq("clearance_type", "eapis_filing");

          const eapisDone = eapisClearances?.some((c) => c.status === "approved");
          if (eapisDone) continue;

          if (hoursOut <= 24) {
            const { count } = await supa
              .from("intl_leg_alerts")
              .select("id", { count: "exact", head: true })
              .eq("alert_type", "eapis_missing")
              .eq("acknowledged", false)
              .ilike("message", `%${trip.tail_number}%${country.name}%eAPIS%`);

            if ((count ?? 0) === 0) {
              alertsToCreate.push({
                flight_id: trip.flight_ids[0] ?? "00000000-0000-0000-0000-000000000000",
                alert_type: "eapis_missing",
                severity: hoursOut <= 4 ? "critical" : "warning",
                message: `${trip.tail_number} ${trip.route_icaos.join("→")} departs in ${Math.round(hoursOut)}hr — CARICOM eAPIS not filed for ${country.name}. File at caricomeapis.org (inbound + outbound separately).`,
                related_country_id: country.id,
              });
            }
          }
        }
      }
    }
  }

  // ── 6d. CANPASS timing alerts for Canada (Ticket 8) ───────────────
  {
    const { data: canada } = await supa
      .from("countries")
      .select("id, icao_prefixes")
      .eq("iso_code", "CA")
      .single();

    if (canada) {
      const { data: canadaTrips } = await supa
        .from("intl_trips")
        .select("id, tail_number, route_icaos, flight_ids, trip_date, schedule_snapshot")
        .gte("trip_date", new Date().toISOString().slice(0, 10))
        .lte("trip_date", new Date(now.getTime() + 2 * 86400000).toISOString().slice(0, 10));

      for (const trip of canadaTrips ?? []) {
        const visitsCanada = trip.route_icaos.some((icao: string) =>
          canada.icao_prefixes?.some((p: string) => icao.startsWith(p))
        );
        if (!visitsCanada) continue;

        // Find the Canadian arrival time from snapshot
        const snap = (trip.schedule_snapshot ?? {}) as Record<string, { dep: string; arr: string | null }>;
        let canadaArrivalTime: Date | null = null;
        for (let i = 0; i < trip.route_icaos.length - 1; i++) {
          const arrIcao = trip.route_icaos[i + 1];
          if (canada.icao_prefixes?.some((p: string) => arrIcao.startsWith(p))) {
            const fid = trip.flight_ids[i];
            const times = fid ? snap[fid] : null;
            if (times?.arr) canadaArrivalTime = new Date(times.arr);
            else if (times?.dep) canadaArrivalTime = new Date(new Date(times.dep).getTime() + 3 * 3600000); // estimate 3hr flight
            break;
          }
        }

        if (!canadaArrivalTime) continue;
        const hoursUntilArrival = (canadaArrivalTime.getTime() - now.getTime()) / 3600000;

        // Check if CANPASS clearance step exists and is done
        const { data: canpassCl } = await supa
          .from("intl_trip_clearances")
          .select("id, status, notes")
          .eq("trip_id", trip.id)
          .eq("clearance_type", "canpass");

        const canpassDone = canpassCl?.some((c) => c.status === "approved");
        if (canpassDone) continue;

        if (hoursUntilArrival <= 24 && hoursUntilArrival > 0) {
          const { count } = await supa
            .from("intl_leg_alerts")
            .select("id", { count: "exact", head: true })
            .eq("alert_type", "canpass_due")
            .eq("acknowledged", false)
            .ilike("message", `%${trip.tail_number}%CANPASS%`);

          if ((count ?? 0) === 0) {
            alertsToCreate.push({
              flight_id: trip.flight_ids[0] ?? "00000000-0000-0000-0000-000000000000",
              alert_type: "canpass_due",
              severity: hoursUntilArrival <= 4 ? "critical" : "warning",
              message: `${trip.tail_number} ${trip.route_icaos.join("→")} — CANPASS ${hoursUntilArrival <= 4 ? "URGENT: only " + Math.round(hoursUntilArrival) + "hr until arrival" : "window open (" + Math.round(hoursUntilArrival) + "hr until arrival)"}. Captain must call CANPASS 4-24hr before arrival.`,
            });
          }
        }
      }
    }
  }

  // ── 6e. Outbound clearance timing intelligence (Ticket 11) ────────
  {
    if (customsAirports && customsAirports.length > 0) {
      // Re-fetch with the new timing fields
      const { data: timingAirports } = await supa
        .from("us_customs_airports")
        .select("icao, clearance_advance_min_hours, clearance_advance_max_hours, airport_name")
        .or("clearance_advance_min_hours.not.is.null,clearance_advance_max_hours.not.is.null");

      if (timingAirports && timingAirports.length > 0) {
        const timingMap = new Map(timingAirports.map((a) => [a.icao, a]));

        // Check outbound clearances for trips departing in the next 48hr
        const { data: outboundTrips } = await supa
          .from("intl_trips")
          .select("id, tail_number, route_icaos, flight_ids, trip_date, schedule_snapshot")
          .gte("trip_date", new Date().toISOString().slice(0, 10))
          .lte("trip_date", new Date(now.getTime() + 2 * 86400000).toISOString().slice(0, 10));

        for (const trip of outboundTrips ?? []) {
          const depIcao = trip.route_icaos[0];
          const timing = timingMap.get(depIcao);
          if (!timing) continue;

          // Get departure time
          const snap = (trip.schedule_snapshot ?? {}) as Record<string, { dep: string; arr: string | null }>;
          const firstFid = trip.flight_ids[0];
          const depTime = firstFid && snap[firstFid] ? new Date(snap[firstFid].dep) : null;
          if (!depTime) continue;

          const hoursOut = (depTime.getTime() - now.getTime()) / 3600000;

          // Check if outbound clearance is started
          const { data: obCl } = await supa
            .from("intl_trip_clearances")
            .select("id, status")
            .eq("trip_id", trip.id)
            .eq("clearance_type", "outbound_clearance");

          const obStarted = obCl?.some((c) => c.status !== "not_started");

          // Too early warning
          if (timing.clearance_advance_max_hours && hoursOut > timing.clearance_advance_max_hours && obStarted) {
            // Already submitted but too early — just informational
          }

          // Time to request
          if (timing.clearance_advance_min_hours && hoursOut <= timing.clearance_advance_min_hours && !obStarted) {
            const { count } = await supa
              .from("intl_leg_alerts")
              .select("id", { count: "exact", head: true })
              .eq("alert_type", "clearance_timing")
              .eq("acknowledged", false)
              .ilike("message", `%${trip.tail_number}%${depIcao}%`);

            if ((count ?? 0) === 0) {
              alertsToCreate.push({
                flight_id: firstFid ?? "00000000-0000-0000-0000-000000000000",
                alert_type: "clearance_timing",
                severity: "warning",
                message: `${trip.tail_number} departing ${depIcao} (${timing.airport_name ?? depIcao}) in ${Math.round(hoursOut)}hr — outbound clearance not yet requested. ${depIcao} requires ${timing.clearance_advance_min_hours}+ hr advance notice.`,
              });
            }
          }
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
    const slackAlerts = alertsToCreate.filter((a) => ["delay", "diversion", "schedule_change", "crew_restriction", "eapis_missing", "canpass_due"].includes(a.alert_type));
    if (slackAlerts.length > 0) {
      await sendIntlAlertSlack(slackAlerts);
    }
  }

  // ── 9. JetInsight scraper health check ─────────────────────────────
  // Alert if the last successful schedule sync is older than 30 minutes
  {
    const { data: lastSync } = await supa
      .from("jetinsight_sync_runs")
      .select("started_at, status")
      .eq("sync_type", "schedule")
      .eq("status", "ok")
      .order("started_at", { ascending: false })
      .limit(1);

    const lastSyncTime = lastSync?.[0]?.started_at ? new Date(lastSync[0].started_at).getTime() : 0;
    const minutesSinceSync = Math.round((now.getTime() - lastSyncTime) / 60000);

    if (minutesSinceSync > 30) {
      // Check if we already alerted recently (don't spam)
      const { data: recentAlert } = await supa
        .from("intl_leg_alerts")
        .select("id")
        .eq("alert_type", "scraper_stale")
        .eq("acknowledged", false)
        .limit(1);

      if (!recentAlert?.length) {
        // DM to Charlie's AI Bot channel
        const slackToken = process.env.SLACK_BOT_TOKEN;
        if (slackToken) {
          await fetch("https://slack.com/api/chat.postMessage", {
            method: "POST",
            headers: { Authorization: `Bearer ${slackToken}`, "Content-Type": "application/json" },
            body: JSON.stringify({
              channel: "D0AK75CPPJM",
              text: `:warning: JetInsight schedule scraper hasn't synced in ${minutesSinceSync} minutes. Last successful sync: ${lastSync?.[0]?.started_at ?? "never"}. International trip data may be stale. Check the scraper session at https://www.whitelabel-ops.com/jetinsight`,
            }),
          }).catch(() => {});
        }

        // Also insert a trackable alert so we don't re-alert
        await supa.from("intl_leg_alerts").insert({
          flight_id: intlFlights[0]?.id ?? "00000000-0000-0000-0000-000000000000",
          alert_type: "scraper_stale",
          severity: "critical",
          message: `JetInsight scraper stale — last sync ${minutesSinceSync}min ago`,
        });
      }
    }
  }

  // ── 10. Clean up intl trips that became fully domestic ────────────
  // When flights change route but keep the same ID, the trip may now
  // be entirely domestic. Check and remove unstarted ones.
  {
    const { data: allTrips } = await supa
      .from("intl_trips")
      .select("id, tail_number, flight_ids, trip_date")
      .gte("trip_date", new Date(now.getTime() - 7 * 86400000).toISOString().slice(0, 10));

    if (allTrips && allTrips.length > 0) {
      // Batch-fetch all flight routes
      const allFids = [...new Set(allTrips.flatMap((t) => t.flight_ids ?? []))];
      const flightRoutes = new Map<string, { dep: string; arr: string }>();
      if (allFids.length > 0) {
        const { data: fRows } = await supa
          .from("flights")
          .select("id, departure_icao, arrival_icao")
          .in("id", allFids);
        for (const f of fRows ?? []) {
          flightRoutes.set(f.id, { dep: f.departure_icao, arr: f.arrival_icao });
        }
      }

      const domesticTrips: string[] = [];
      for (const t of allTrips) {
        if (!t.flight_ids?.length) continue;
        const hasIntlLeg = t.flight_ids.some((fid: string) => {
          const route = flightRoutes.get(fid);
          if (!route) return false; // flight deleted — will be caught by orphan cleanup
          return isInternationalIcao(route.dep) || isInternationalIcao(route.arr);
        });
        if (!hasIntlLeg) domesticTrips.push(t.id);
      }

      if (domesticTrips.length > 0) {
        // Only delete unstarted ones
        const { data: cl } = await supa
          .from("intl_trip_clearances")
          .select("trip_id, status")
          .in("trip_id", domesticTrips);

        const startedIds = new Set(
          (cl ?? []).filter((c) => c.status !== "not_started").map((c) => c.trip_id)
        );
        const safeToDelete = domesticTrips.filter((id) => !startedIds.has(id));
        const startedDomestic = domesticTrips.filter((id) => startedIds.has(id));

        if (safeToDelete.length > 0) {
          await supa.from("intl_trip_clearances").delete().in("trip_id", safeToDelete);
          await supa.from("intl_trips").delete().in("id", safeToDelete);
          console.log(`[intl/run-checks] Removed ${safeToDelete.length} trip(s) that became domestic`);
        }

        // Flag started trips that went domestic (don't delete — work in progress)
        if (startedDomestic.length > 0) {
          await supa.from("intl_trips")
            .update({ notes: "⚠ FLIGHTS MAY NO LONGER BE INTERNATIONAL — review and remove if no longer needed" })
            .in("id", startedDomestic)
            .is("notes", null); // only set if notes not already set
          console.log(`[intl/run-checks] Flagged ${startedDomestic.length} started trip(s) as possibly domestic`);
        }
      }
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

