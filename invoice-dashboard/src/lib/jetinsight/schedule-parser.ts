/**
 * Parse JetInsight schedule JSON events from /schedule/aircraft.json
 * Extracts structured data from the FullCalendar event format.
 */

import { toIcao } from "@/lib/iataToIcao";
import { isInternationalIcao } from "@/lib/intlUtils";

export interface ScheduleEvent {
  uuid: string;
  eventType: "flight" | "maintenance" | "other";
  tailNumber: string;
  departureIcao: string;
  arrivalIcao: string;
  start: string; // ISO datetime
  end: string;
  flightNumber: string | null;
  tripId: string | null; // PNR
  customerName: string | null;
  originFbo: string | null;
  destinationFbo: string | null;
  pic: string | null;
  sic: string | null;
  paxCount: number | null;
  flightType: string; // Revenue, Positioning, Maintenance, etc.
  faaPart: string | null; // "135", "91"
  internationalLeg: boolean;
  tripStage: string | null;
  releaseComplete: boolean | null;
  crewComplete: boolean | null;
  paxComplete: boolean | null;
  mxNotes: string | null;
  createdBy: string | null;
}

// JetInsight event_type_name → our flight_type
const EVENT_TYPE_MAP: Record<string, string> = {
  "Charter flight (135)": "Revenue",
  "Positioning flight (135)": "Positioning",
  "Positioning flight (91)": "Positioning",
  Maintenance: "Maintenance",
};

// Event types we care about (skip away-from-base, needs-repo, other, etc.)
const RELEVANT_EVENT_GROUPS = new Set([
  "customer_flight",
  "pos_flight",
  "maintenance",
]);

/**
 * Parse raw JetInsight schedule JSON into structured events.
 * Only returns flight + maintenance events (skips away-from-base, needs-repo, etc.)
 */
export function parseScheduleJson(
  raw: unknown[],
): ScheduleEvent[] {
  const events: ScheduleEvent[] = [];

  for (const item of raw) {
    const e = item as Record<string, unknown>;
    const ep = (e.extendedProps ?? {}) as Record<string, unknown>;

    const eventGroup = ep.event_group as string | undefined;
    if (!eventGroup || !RELEVANT_EVENT_GROUPS.has(eventGroup)) continue;

    const uuid = ep.uuid as string;
    if (!uuid) continue;

    const tailNumber = extractTailNumber(ep.aircraft as string | undefined);
    if (!tailNumber) continue;

    const eventTypeName = ep.event_type_name as string;
    const isMx = eventGroup === "maintenance";

    const depIcao = normalizeIcao(ep.origin_short as string | undefined);
    const arrIcao = normalizeIcao(ep.destination_short as string | undefined);
    if (!depIcao || !arrIcao) continue;

    // Cross-check: if JetInsight flags this as international but our ICAO
    // mapping thinks both airports are domestic, log a warning so we can
    // add the missing mapping. This catches gaps in the IATA→ICAO table.
    const jiSaysIntl = (ep.international_leg as boolean) ?? false;
    if (jiSaysIntl && !isInternationalIcao(depIcao) && !isInternationalIcao(arrIcao)) {
      console.warn(
        `[schedule-parser] ICAO mapping gap: JetInsight says international but both airports look domestic: ` +
        `${ep.origin_short}→${depIcao}, ${ep.destination_short}→${arrIcao} (tail=${tailNumber})`,
      );
    }

    // Parse crew
    const crewArr = (ep.crew ?? []) as Array<{
      role: string;
      name: string;
    }>;
    const pic = crewArr.find((c) => c.role === "PIC");
    const sic = crewArr.find((c) => c.role === "SIC");

    // Parse pax count (can be number, string like "4/8", or "TBD")
    let paxCount: number | null = null;
    const paxRaw = ep.pax;
    if (typeof paxRaw === "number") {
      paxCount = paxRaw;
    } else if (typeof paxRaw === "string" && paxRaw !== "TBD") {
      const match = paxRaw.match(/^(\d+)/);
      if (match) paxCount = parseInt(match[1], 10);
    }

    const faaPart = ep.faa_part_num as string | undefined;

    events.push({
      uuid,
      eventType: isMx ? "maintenance" : "flight",
      tailNumber,
      departureIcao: depIcao,
      arrivalIcao: arrIcao,
      start: e.start as string,
      end: e.end as string,
      flightNumber: (ep.flight_number as string) || null,
      tripId: (ep.pnr as string) || null,
      customerName: (e.title as string) || null,
      originFbo: parseFboName(ep.origin as string | undefined),
      destinationFbo: parseFboName(ep.destination as string | undefined),
      pic: pic ? cleanCrewName(pic.name) : null,
      sic: sic ? cleanCrewName(sic.name) : null,
      paxCount,
      flightType: EVENT_TYPE_MAP[eventTypeName] ?? eventTypeName,
      faaPart: faaPart && faaPart !== "Not set" ? faaPart : null,
      internationalLeg: (ep.international_leg as boolean) ?? false,
      tripStage: (ep.trip_stage as string) || null,
      releaseComplete: (ep.release_complete as boolean) ?? null,
      crewComplete: (ep.crew_complete as boolean) ?? null,
      paxComplete: (ep.pax_complete as boolean) ?? null,
      mxNotes: isMx
        ? ((ep.notes as string) || (e.title as string) || null)
        : null,
      createdBy: (ep.created_by_user as string) || null,
    });
  }

  return events;
}

/**
 * Extract FBO name from JetInsight HTML origin/destination field.
 * Input: '<A HREF="/airports/KTEB" target="_blank">TEB</A> (Jet Aviation <A HREF="tel:201-462-4000">...)'
 * Output: "Jet Aviation"
 */
export function parseFboName(html: string | undefined): string | null {
  if (!html) return null;

  // Look for text in parentheses: (FBO Name <A HREF="tel:...">)
  // or just (FBO Name) without phone
  const match = html.match(/\(([^<(]+?)(?:\s*<A\s|$|\))/i);
  if (match) {
    const name = match[1].trim();
    // Filter out phone-only matches
    if (name && !name.match(/^\d{3}[-.]?\d{3}[-.]?\d{4}$/)) {
      return name;
    }
  }

  return null;
}

/**
 * Clean crew name by stripping HTML phone tags.
 * Input: 'Blake Middleton <A HREF="tel:630-877-4324"><i class="fa fa-phone"></i></A>'
 * Output: "Blake Middleton"
 */
export function cleanCrewName(name: string): string {
  return name.replace(/<[^>]+>/g, "").trim();
}

/**
 * Extract tail number from aircraft field.
 * Input: "N883TR" or "C750 Baker Aviation" or ""
 * Output: "N883TR" or null
 */
function extractTailNumber(aircraft: string | undefined): string | null {
  if (!aircraft) return null;
  const match = aircraft.match(/^(N\d{1,5}[A-Z]{0,2})\b/);
  return match ? match[1] : null;
}

/**
 * Normalize airport code to ICAO format.
 * Uses the comprehensive IATA→ICAO lookup table which handles international
 * airports (NAS→MYNN, CUN→MMUN, etc.) instead of blindly prepending K.
 */
function normalizeIcao(code: string | undefined): string | null {
  if (!code) return null;
  return toIcao(code);
}
