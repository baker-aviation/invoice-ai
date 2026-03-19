import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthed } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";
import { isInternationalIcao } from "@/lib/intlUtils";

/**
 * POST /api/ops/intl/run-checks
 *
 * Combined endpoint that runs all international ops checks:
 * 1. Deadline approaching alerts (permits not approved near deadline)
 * 2. Tail-change detection (aircraft swapped on legs with active permits)
 * 3. Customs hour conflicts (international arrival outside customs hours)
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

  // ── 4. Customs hour conflicts ───────────────────────────────────────
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

  // ── 5. Insert all alerts ────────────────────────────────────────────
  if (alertsToCreate.length > 0) {
    const { error } = await supa.from("intl_leg_alerts").insert(alertsToCreate);
    if (error) {
      console.error("[intl/run-checks] insert error:", error);
      return NextResponse.json({ error: "Failed to create alerts" }, { status: 500 });
    }
  }

  return NextResponse.json({
    ok: true,
    intl_flights: intlFlights.length,
    permits_checked: (permits ?? []).length,
    alerts_created: alertsToCreate.length,
  });
}
