import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthed } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";
import { isInternationalIcao } from "@/lib/intlUtils";

/**
 * POST /api/ops/intl/detect-tail-changes
 *
 * Checks if any international flights with active permits have changed tail numbers.
 * When a tail changes, permits may need to be resubmitted since they're tied to the aircraft.
 *
 * This should be called after each JI sync.
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;

  const supa = createServiceClient();
  const now = new Date();
  const thirtyDaysOut = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();

  // Get all permits that are not approved yet, joined with their flights
  const { data: permits } = await supa
    .from("intl_leg_permits")
    .select(`
      id, flight_id, country_id, permit_type, status, notes,
      country:countries(name),
      flight:flights(id, tail_number, departure_icao, arrival_icao, scheduled_departure)
    `)
    .neq("status", "approved")
    .not("flight", "is", null);

  if (!permits || permits.length === 0) {
    return NextResponse.json({ ok: true, alerts_created: 0 });
  }

  const alertsToCreate: Array<{
    flight_id: string;
    alert_type: string;
    severity: string;
    message: string;
    related_country_id: string;
    related_permit_id: string;
  }> = [];

  for (const p of permits) {
    // Supabase returns the joined row as an object (single FK), not an array
    const flightRaw = p.flight as unknown;
    if (!flightRaw || typeof flightRaw !== "object") continue;
    const flight = flightRaw as { id: string; tail_number: string | null; departure_icao: string | null; arrival_icao: string | null; scheduled_departure: string };

    // Only check international flights in the future
    if (new Date(flight.scheduled_departure) > new Date(thirtyDaysOut)) continue;
    if (new Date(flight.scheduled_departure) < now) continue;
    if (!isInternationalIcao(flight.departure_icao) && !isInternationalIcao(flight.arrival_icao)) continue;

    // Check if the permit notes contain a previous tail number
    // We store the tail at permit creation in the notes field as "Tail: N520FX"
    const tailMatch = p.notes?.match(/Tail: (\S+)/);
    if (tailMatch && flight.tail_number && tailMatch[1] !== flight.tail_number) {
      // Tail has changed! Check for existing alert
      const { count } = await supa
        .from("intl_leg_alerts")
        .select("id", { count: "exact", head: true })
        .eq("related_permit_id", p.id)
        .eq("alert_type", "tail_change")
        .eq("acknowledged", false);

      if ((count ?? 0) === 0) {
        const countryName = (p.country as { name?: string } | null)?.name ?? "Unknown";
        alertsToCreate.push({
          flight_id: flight.id,
          alert_type: "tail_change",
          severity: "critical",
          message: `Aircraft changed from ${tailMatch[1]} to ${flight.tail_number} on ${flight.departure_icao}-${flight.arrival_icao}. ${countryName} ${p.permit_type} permit (status: ${p.status}) may need resubmission.`,
          related_country_id: p.country_id,
          related_permit_id: p.id,
        });
      }
    }
  }

  if (alertsToCreate.length > 0) {
    const { error } = await supa.from("intl_leg_alerts").insert(alertsToCreate);
    if (error) {
      console.error("[intl/detect-tail-changes] insert error:", error);
      return NextResponse.json({ error: "Failed to create alerts" }, { status: 500 });
    }
  }

  return NextResponse.json({
    ok: true,
    permits_checked: permits.length,
    alerts_created: alertsToCreate.length,
  });
}
