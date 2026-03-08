import { haversineKm, FIXED_VAN_ZONES, type VanZone } from "./maintenanceData";
import { getAirportInfo } from "./airportCoords";

type VanPosition = { lat: number; lon: number };

type HeadToAirportAlert = {
  vanId: number;
  vanZone: VanZone;
  tail: string;
  airport: string;
  airportName: string;
  etaMinutes: number;
  driveMinutes: number;
  bufferMinutes: number;
  message: string;
  urgency: "leave-now" | "prepare" | "upcoming";
};

const DEFAULT_BUFFER_MINUTES = 30;
const PREPARE_BUFFER_MINUTES = 60;

/**
 * Check if any vans should head to an airport based on aircraft ETAs.
 *
 * Logic: When FA_ETA_minutes - drive_time < buffer, alert the van.
 * - "leave-now": ETA - drive_time < 30 min buffer
 * - "prepare": ETA - drive_time < 60 min buffer
 * - "upcoming": ETA - drive_time < 90 min buffer
 */
export function checkHeadToAirport(
  vanPositions: Map<number, VanPosition>,
  flightInfoMap: Map<string, { arrival_time: string | null; status: string | null; actual_arrival: string | null; destination_icao?: string | null }>,
  vanAssignments: Map<number, string[]>, // vanId -> tail numbers assigned
): HeadToAirportAlert[] {
  const alerts: HeadToAirportAlert[] = [];
  const now = Date.now();

  for (const [vanId, tails] of vanAssignments) {
    const vanPos = vanPositions.get(vanId);
    const zone = FIXED_VAN_ZONES.find(z => z.vanId === vanId);
    if (!zone) continue;

    // Use van GPS position if available, otherwise zone home base
    const baseLat = vanPos?.lat ?? zone.lat;
    const baseLon = vanPos?.lon ?? zone.lon;

    for (const tail of tails) {
      const fi = flightInfoMap.get(tail);
      if (!fi?.arrival_time || fi.actual_arrival) continue; // skip if no ETA or already landed
      if (fi.status?.toLowerCase().includes("landed")) continue;

      const etaMs = new Date(fi.arrival_time).getTime() - now;
      const etaMinutes = Math.round(etaMs / 60_000);
      if (etaMinutes <= 0) continue; // already should have arrived

      // Find the destination airport for this flight
      const destIcao = fi.destination_icao;
      if (!destIcao) continue;

      // Strip leading K for US ICAO codes (KTEB -> TEB)
      const destIata = destIcao.replace(/^K/, "");
      const destInfo = getAirportInfo(destIata);
      if (!destInfo) continue;

      // Calculate drive time from van to destination airport
      const distKm = haversineKm(baseLat, baseLon, destInfo.lat, destInfo.lon);
      const driveMinutes = Math.round(distKm / 90 * 60); // 90 km/h avg

      // Check if van needs to leave
      const timeAvailable = etaMinutes - driveMinutes;

      let urgency: "leave-now" | "prepare" | "upcoming" | null = null;
      if (timeAvailable <= DEFAULT_BUFFER_MINUTES) {
        urgency = "leave-now";
      } else if (timeAvailable <= PREPARE_BUFFER_MINUTES) {
        urgency = "prepare";
      } else if (timeAvailable <= 90) {
        urgency = "upcoming";
      }

      if (urgency) {
        alerts.push({
          vanId,
          vanZone: zone,
          tail,
          airport: destIata,
          airportName: destInfo.name ?? destIata,
          etaMinutes,
          driveMinutes,
          bufferMinutes: timeAvailable,
          message: urgency === "leave-now"
            ? `Leave NOW — ${tail} landing at ${destIata} in ${etaMinutes}m, ${driveMinutes}m drive`
            : urgency === "prepare"
            ? `Prepare to leave — ${tail} landing at ${destIata} in ${etaMinutes}m, ${driveMinutes}m drive`
            : `Upcoming — ${tail} landing at ${destIata} in ${etaMinutes}m, ${driveMinutes}m drive`,
          urgency,
        });
      }
    }
  }

  // Sort by urgency (leave-now first) then by ETA
  const urgencyOrder = { "leave-now": 0, "prepare": 1, "upcoming": 2 };
  alerts.sort((a, b) => urgencyOrder[a.urgency] - urgencyOrder[b.urgency] || a.etaMinutes - b.etaMinutes);

  return alerts;
}
