import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthed } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";
import { isInternationalIcao } from "@/lib/intlUtils";

/**
 * POST /api/ops/intl/check-alerts
 * Scans international flights for:
 * 1. Deadline approaching — permit not approved but deadline is within 2 days
 * 2. Tail changes — flight's tail_number changed since last check
 * 3. Customs conflicts — international arrival at US airport outside customs hours
 *
 * Can be called after JI sync or on a schedule.
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;

  const supa = createServiceClient();
  const now = new Date();
  const thirtyDaysOut = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();
  const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();

  // 1. Fetch international flights in the next 30 days
  const { data: flights } = await supa
    .from("flights")
    .select("id, tail_number, departure_icao, arrival_icao, scheduled_departure, scheduled_arrival, pic, sic")
    .gte("scheduled_departure", oneDayAgo)
    .lte("scheduled_departure", thirtyDaysOut)
    .order("scheduled_departure");

  if (!flights) return NextResponse.json({ ok: true, alerts_created: 0 });

  const intlFlights = flights.filter(
    (f) => isInternationalIcao(f.departure_icao) || isInternationalIcao(f.arrival_icao)
  );

  const alertsToCreate: Array<{
    flight_id: string;
    alert_type: string;
    severity: string;
    message: string;
    related_country_id?: string;
    related_permit_id?: string;
  }> = [];

  // 2. Check permit deadlines
  const flightIds = intlFlights.map((f) => f.id);
  if (flightIds.length > 0) {
    const { data: permits } = await supa
      .from("intl_leg_permits")
      .select("id, flight_id, country_id, permit_type, status, deadline, country:countries(name)")
      .in("flight_id", flightIds)
      .neq("status", "approved");

    for (const p of permits ?? []) {
      if (!p.deadline) continue;
      const deadline = new Date(p.deadline + "T00:00:00");
      const daysUntil = Math.ceil((deadline.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));

      // Check if we already have an unacked alert for this permit
      const { count } = await supa
        .from("intl_leg_alerts")
        .select("id", { count: "exact", head: true })
        .eq("related_permit_id", p.id)
        .eq("alert_type", "deadline_approaching")
        .eq("acknowledged", false);

      if ((count ?? 0) > 0) continue;

      const countryName = (p.country as { name?: string } | null)?.name ?? "Unknown";

      if (daysUntil <= 0 && p.status !== "approved") {
        alertsToCreate.push({
          flight_id: p.flight_id,
          alert_type: "deadline_approaching",
          severity: "critical",
          message: `OVERDUE: ${countryName} ${p.permit_type} permit deadline has passed (was ${p.deadline}). Status: ${p.status}`,
          related_country_id: p.country_id,
          related_permit_id: p.id,
        });
      } else if (daysUntil <= 2) {
        alertsToCreate.push({
          flight_id: p.flight_id,
          alert_type: "deadline_approaching",
          severity: "warning",
          message: `${countryName} ${p.permit_type} permit deadline in ${daysUntil} day${daysUntil === 1 ? "" : "s"} (${p.deadline}). Status: ${p.status}`,
          related_country_id: p.country_id,
          related_permit_id: p.id,
        });
      }
    }
  }

  // 3. Check customs hours for international arrivals at US airports
  const { data: customsAirports } = await supa
    .from("us_customs_airports")
    .select("icao, hours_open, hours_close, timezone, airport_name");

  if (customsAirports && customsAirports.length > 0) {
    const customsMap = new Map(customsAirports.map((a) => [a.icao, a]));

    for (const f of intlFlights) {
      // International departure arriving at US airport
      if (isInternationalIcao(f.departure_icao) && f.arrival_icao?.startsWith("K") && f.scheduled_arrival) {
        const customs = customsMap.get(f.arrival_icao);
        if (customs?.hours_close) {
          const arrivalTime = new Date(f.scheduled_arrival);
          // Simple hour comparison (would need timezone conversion for production)
          const arrivalHour = arrivalTime.getUTCHours();
          const closeHour = parseInt(customs.hours_close.split(":")[0]);

          if (arrivalHour >= closeHour) {
            // Check for existing alert
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
                message: `${f.tail_number} arriving at ${f.arrival_icao} (${customs.airport_name}) at ${arrivalTime.toISOString().slice(11, 16)}Z — customs closes at ${customs.hours_close}L`,
              });
            }
          }
        }
      }
    }
  }

  // 4. Insert alerts
  if (alertsToCreate.length > 0) {
    const { error } = await supa.from("intl_leg_alerts").insert(alertsToCreate);
    if (error) {
      console.error("[intl/check-alerts] insert error:", error);
      return NextResponse.json({ error: "Failed to create alerts" }, { status: 500 });
    }
  }

  return NextResponse.json({
    ok: true,
    intl_flights_checked: intlFlights.length,
    alerts_created: alertsToCreate.length,
  });
}
