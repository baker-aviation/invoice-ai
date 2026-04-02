"use client";

/**
 * NightBeforeTab — Overnight van repositioning planner.
 *
 * Shows dispatchers where vans need to be for tomorrow's first arrivals
 * and recommends overnight moves from current Samsara GPS positions.
 */

import { useMemo, useState } from "react";
import type { Flight } from "@/lib/opsApi";
import {
  FIXED_VAN_ZONES,
  haversineKm,
  computeOvernightPositionsFromFlights,
  assignVans,
  type VanZone,
  type VanAssignment,
} from "@/lib/maintenanceData";
import { getAirportInfo } from "@/lib/airportCoords";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type LivePos = { lat: number; lon: number };

type VanMove = {
  vanId: number;
  zone: VanZone;
  currentPos: LivePos;
  currentLabel: string;           // nearest airport or "Home"
  demandAirport: string | null;   // where first arrival lands, null = no demand
  demandLabel: string;            // airport name or "No flights"
  tomorrowAircraft: number;       // how many aircraft assigned to this van
  firstArrivalET: string | null;  // HH:MM ET of earliest arrival
  distanceMi: number;             // current → demand position
  alreadyInPosition: boolean;     // within 50mi
  recommendation: string;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const KM_TO_MI = 0.621371;
const IN_POSITION_KM = 80.5; // 50mi

function fmtTimeET(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
    timeZone: "America/New_York",
  });
}

function fmtDateLabel(dateStr: string): string {
  const d = new Date(dateStr + "T12:00:00");
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

/** Find nearest airport to a lat/lon from the van zones + a curated list */
function nearestAirportLabel(lat: number, lon: number): string {
  let bestCode = "Unknown";
  let bestDist = Infinity;
  for (const zone of FIXED_VAN_ZONES) {
    const d = haversineKm(lat, lon, zone.lat, zone.lon);
    if (d < bestDist) {
      bestDist = d;
      bestCode = zone.homeAirport;
    }
  }
  return bestDist < 30 ? bestCode : `${bestCode} area`;
}

/** Get flights arriving on a specific date (5AM–5AM ET window) */
function getArrivalsForDate(flights: Flight[], date: string): Flight[] {
  const VAN_DAY_START_HOUR_ET = 5;
  return flights.filter((f) => {
    if (!f.scheduled_arrival || !f.arrival_icao) return false;
    const shifted = new Date(new Date(f.scheduled_arrival).getTime() - VAN_DAY_START_HOUR_ET * 3600000);
    return shifted.toLocaleDateString("en-CA", { timeZone: "America/New_York" }) === date;
  });
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

type Props = {
  flights: Flight[];
  liveVanPositions: Map<number, LivePos>;
  liveVanIsLive?: Map<number, boolean>;
};

export default function NightBeforeTab({ flights, liveVanPositions, liveVanIsLive }: Props) {
  // Tomorrow's date
  const tomorrow = useMemo(() => {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0")].join("-");
  }, []);

  const [selectedDate, setSelectedDate] = useState(tomorrow);

  // Date options: tomorrow and day after
  const dateOptions = useMemo(() => {
    return Array.from({ length: 3 }, (_, i) => {
      const d = new Date();
      d.setDate(d.getDate() + 1 + i);
      return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0")].join("-");
    });
  }, []);

  // Compute van assignments for the selected date
  const moves = useMemo<VanMove[]>(() => {
    const arrivals = getArrivalsForDate(flights, selectedDate);

    // Compute overnight positions → van assignments using existing algorithm
    const overnightPositions = computeOvernightPositionsFromFlights(flights, selectedDate);
    const vanAssignments = assignVans(overnightPositions);

    // Build a map: vanId → assignment
    const assignmentMap = new Map<number, VanAssignment>();
    for (const va of vanAssignments) assignmentMap.set(va.vanId, va);

    // For each van, figure out earliest arrival among its assigned aircraft
    const tailFirstArrival = new Map<string, Flight>();
    for (const f of arrivals) {
      if (!f.tail_number) continue;
      const prev = tailFirstArrival.get(f.tail_number);
      if (!prev || (f.scheduled_arrival ?? "") < (prev.scheduled_arrival ?? "")) {
        tailFirstArrival.set(f.tail_number, f);
      }
    }

    return FIXED_VAN_ZONES.map((zone): VanMove => {
      const assignment = assignmentMap.get(zone.vanId);
      const aircraftCount = assignment?.aircraft.length ?? 0;
      const currentPos = liveVanPositions.get(zone.vanId) ?? { lat: zone.lat, lon: zone.lon };
      const isLive = liveVanIsLive?.get(zone.vanId) ?? false;
      const currentLabel = isLive ? nearestAirportLabel(currentPos.lat, currentPos.lon) : `${zone.homeAirport} (home)`;

      // Find the earliest arrival airport among assigned aircraft
      let demandAirport: string | null = null;
      let demandLabel = "No flights";
      let firstArrivalET: string | null = null;
      let demandLat = zone.lat;
      let demandLon = zone.lon;

      if (assignment && assignment.aircraft.length > 0) {
        // Find earliest first-arrival across all assigned aircraft
        let earliestFlight: Flight | null = null;
        for (const ac of assignment.aircraft) {
          const firstArr = tailFirstArrival.get(ac.tail);
          if (firstArr && (!earliestFlight || (firstArr.scheduled_arrival ?? "") < (earliestFlight.scheduled_arrival ?? ""))) {
            earliestFlight = firstArr;
          }
        }

        if (earliestFlight) {
          const arrIcao = earliestFlight.arrival_icao!.replace(/^K/, "");
          const info = getAirportInfo(arrIcao);
          demandAirport = arrIcao;
          demandLabel = info ? `${info.name} (${arrIcao})` : arrIcao;
          firstArrivalET = fmtTimeET(earliestFlight.scheduled_arrival!);
          if (info) {
            demandLat = info.lat;
            demandLon = info.lon;
          }
        } else {
          // Aircraft assigned but no arrivals tomorrow — they're parked
          demandAirport = assignment.aircraft[0].airport;
          const info = getAirportInfo(demandAirport);
          demandLabel = info ? `${info.name} (${demandAirport}) — parked` : `${demandAirport} — parked`;
          if (info) { demandLat = info.lat; demandLon = info.lon; }
        }
      }

      const distKm = haversineKm(currentPos.lat, currentPos.lon, demandLat, demandLon);
      const distMi = Math.round(distKm * KM_TO_MI);
      const alreadyInPosition = distKm <= IN_POSITION_KM;

      // Generate recommendation
      let recommendation: string;
      if (aircraftCount === 0) {
        recommendation = "No demand — stay put";
      } else if (alreadyInPosition) {
        recommendation = "Already in position";
      } else {
        const driveHrs = Math.round(distKm / 80); // rough 50mph avg
        const driveMins = Math.round((distKm / 80) * 60) % 60;
        const driveLabel = driveHrs > 0 ? `~${driveHrs}h ${driveMins}m` : `~${driveMins}m`;
        recommendation = `Move to ${demandAirport} tonight (${driveLabel} drive)`;
      }

      return {
        vanId: zone.vanId,
        zone,
        currentPos,
        currentLabel,
        demandAirport,
        demandLabel,
        tomorrowAircraft: aircraftCount,
        firstArrivalET,
        distanceMi: distMi,
        alreadyInPosition,
        recommendation,
      };
    });
  }, [flights, selectedDate, liveVanPositions, liveVanIsLive]);

  const needsMoveCount = moves.filter((m) => m.tomorrowAircraft > 0 && !m.alreadyInPosition).length;
  const idleCount = moves.filter((m) => m.tomorrowAircraft === 0).length;

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-lg font-bold text-gray-800">Overnight Van Repositioning</h2>
        <div className="flex gap-1.5">
          {dateOptions.map((d) => (
            <button
              key={d}
              onClick={() => setSelectedDate(d)}
              className={`px-3 py-1 rounded text-xs font-medium shadow-sm transition-colors ${
                selectedDate === d
                  ? "bg-blue-600 text-white"
                  : "bg-white text-gray-600 border border-gray-300 hover:bg-gray-50"
              }`}
            >
              {fmtDateLabel(d)}
            </button>
          ))}
        </div>
        <div className="flex-1" />
        <div className="flex gap-3 text-xs text-gray-500">
          {needsMoveCount > 0 && (
            <span className="px-2 py-1 rounded-full bg-amber-100 text-amber-700 font-medium">
              {needsMoveCount} van{needsMoveCount !== 1 ? "s" : ""} need repositioning
            </span>
          )}
          {idleCount > 0 && (
            <span className="px-2 py-1 rounded-full bg-gray-100 text-gray-600 font-medium">
              {idleCount} idle
            </span>
          )}
        </div>
      </div>

      {/* Van cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 gap-3">
        {moves
          .sort((a, b) => {
            // Needs move first, then in-position, then idle
            const pri = (m: VanMove) =>
              m.tomorrowAircraft === 0 ? 2 : m.alreadyInPosition ? 1 : 0;
            return pri(a) - pri(b) || a.vanId - b.vanId;
          })
          .map((m) => (
            <div
              key={m.vanId}
              className={`rounded-lg border p-3 space-y-2 ${
                m.tomorrowAircraft === 0
                  ? "border-gray-200 bg-gray-50 opacity-60"
                  : m.alreadyInPosition
                  ? "border-green-200 bg-green-50"
                  : "border-amber-300 bg-amber-50"
              }`}
            >
              {/* Van header */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className={`text-sm font-bold ${
                    m.tomorrowAircraft === 0
                      ? "text-gray-400"
                      : m.alreadyInPosition
                      ? "text-green-700"
                      : "text-amber-700"
                  }`}>
                    V{m.vanId}
                  </span>
                  <span className="text-xs text-gray-500">{m.zone.name}</span>
                </div>
                <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${
                  m.tomorrowAircraft === 0
                    ? "bg-gray-200 text-gray-500"
                    : m.alreadyInPosition
                    ? "bg-green-200 text-green-700"
                    : "bg-amber-200 text-amber-800"
                }`}>
                  {m.tomorrowAircraft === 0
                    ? "Idle"
                    : m.alreadyInPosition
                    ? "In Position"
                    : `${m.distanceMi} mi away`}
                </span>
              </div>

              {/* Current → Demand */}
              {m.tomorrowAircraft > 0 && (
                <div className="text-xs space-y-1">
                  <div className="flex items-center gap-2">
                    <span className="text-gray-400 w-12">Now:</span>
                    <span className="font-mono font-medium text-gray-700">{m.currentLabel}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-gray-400 w-12">Need:</span>
                    <span className="font-mono font-medium text-gray-700">{m.demandLabel}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-gray-400 w-12">1st arr:</span>
                    <span className="font-mono font-medium text-gray-700">
                      {m.firstArrivalET ?? "—"}
                    </span>
                    <span className="text-gray-400">· {m.tomorrowAircraft} aircraft</span>
                  </div>
                </div>
              )}

              {/* Recommendation */}
              <div className={`text-xs font-medium pt-1 border-t ${
                m.tomorrowAircraft === 0
                  ? "border-gray-200 text-gray-400"
                  : m.alreadyInPosition
                  ? "border-green-200 text-green-600"
                  : "border-amber-200 text-amber-700"
              }`}>
                {m.alreadyInPosition && m.tomorrowAircraft > 0 ? "✓ " : ""}
                {!m.alreadyInPosition && m.tomorrowAircraft > 0 ? "→ " : ""}
                {m.recommendation}
              </div>
            </div>
          ))}
      </div>
    </div>
  );
}
