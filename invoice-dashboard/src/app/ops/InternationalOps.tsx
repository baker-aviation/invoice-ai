"use client";

import { useState, useEffect, useCallback } from "react";
import type {
  Flight,
  Country,
  CountryRequirement,
  IntlLegAlert,
  UsCustomsAirport,
  IntlDocument,
  IntlTrip,
  IntlTripClearance,
} from "@/lib/opsApi";
import { isInternationalIcao } from "@/lib/intlUtils";

// ---------------------------------------------------------------------------
// Sub-tabs within International
// ---------------------------------------------------------------------------
const SUB_TABS = ["Flight Board", "Country Profiles", "Documents", "US Customs", "Alerts"] as const;
type SubTab = (typeof SUB_TABS)[number];

// ---------------------------------------------------------------------------
// Status badge colors
// ---------------------------------------------------------------------------
function statusColor(s: string) {
  switch (s) {
    case "approved": return "bg-green-100 text-green-800";
    case "submitted": return "bg-blue-100 text-blue-800";
    case "drafted": return "bg-yellow-100 text-yellow-800";
    default: return "bg-gray-100 text-gray-600";
  }
}

function difficultyColor(d: string | null) {
  switch (d) {
    case "easy": return "bg-green-100 text-green-800";
    case "moderate": return "bg-yellow-100 text-yellow-800";
    case "hard": return "bg-red-100 text-red-800";
    default: return "bg-gray-100 text-gray-600";
  }
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------
export default function InternationalOps({ flights: _parentFlights }: { flights: Flight[] }) {
  const [subTab, setSubTab] = useState<SubTab>("Flight Board");
  const [countries, setCountries] = useState<Country[]>([]);
  const [alerts, setAlerts] = useState<IntlLegAlert[]>([]);
  const [trips, setTrips] = useState<IntlTrip[]>([]);
  const [loading, setLoading] = useState(true);

  const loadTrips = useCallback(async (autoDetect = true) => {
    try {
      const qs = autoDetect ? "" : "?auto_detect=false";
      const res = await fetch("/api/ops/intl/trips" + qs);
      const data = await res.json();
      setTrips(data.trips ?? []);
    } catch { /* ignore */ }
  }, []);

  const loadCountries = useCallback(async () => {
    try {
      const res = await fetch("/api/ops/intl/countries");
      const data = await res.json();
      setCountries(data.countries ?? []);
    } catch { /* ignore */ }
  }, []);

  const loadAlerts = useCallback(async () => {
    try {
      const res = await fetch("/api/ops/intl/alerts");
      const data = await res.json();
      setAlerts(data.alerts ?? []);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    // Fast load: fetch cached trips without auto-detection, then detect in background
    Promise.all([loadTrips(false), loadCountries(), loadAlerts()])
      .finally(() => setLoading(false))
      .then(() => loadTrips(true)); // background: run detection and refresh
  }, [loadTrips, loadCountries, loadAlerts]);

  const unackedAlerts = alerts.filter((a) => !a.acknowledged);

  return (
    <div className="space-y-4">
      {/* Alert banner */}
      {unackedAlerts.length > 0 && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3">
          <p className="text-sm font-medium text-red-800">
            {unackedAlerts.length} unacknowledged international alert{unackedAlerts.length > 1 ? "s" : ""}
          </p>
          <div className="mt-1 space-y-1">
            {unackedAlerts.slice(0, 5).map((a) => (
              <p key={a.id} className="text-xs text-red-700">{a.message}</p>
            ))}
          </div>
        </div>
      )}

      {/* Sub-tab bar */}
      <div className="flex gap-1 border-b border-gray-200">
        {SUB_TABS.map((t) => (
          <button
            key={t}
            onClick={() => setSubTab(t)}
            className={`px-3 py-1.5 text-xs font-medium border-b-2 transition-colors ${
              subTab === t
                ? "border-blue-600 text-blue-600"
                : "border-transparent text-gray-500 hover:text-gray-700"
            }`}
          >
            {t}
            {t === "Alerts" && unackedAlerts.length > 0 && (
              <span className="ml-1 inline-flex items-center justify-center w-4 h-4 text-[10px] font-bold bg-red-500 text-white rounded-full">
                {unackedAlerts.length}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Sub-tab content */}
      {loading ? (
        <p className="text-sm text-gray-500 animate-pulse">Loading international data...</p>
      ) : subTab === "Flight Board" ? (
        <TripBoard trips={trips} countries={countries} onRefresh={loadTrips} />
      ) : subTab === "Country Profiles" ? (
        <CountryProfiles countries={countries} onRefresh={loadCountries} />
      ) : subTab === "Documents" ? (
        <DocumentLibrary />
      ) : subTab === "US Customs" ? (
        <CustomsTracker />
      ) : (
        <AlertsPanel alerts={alerts} onRefresh={loadAlerts} />
      )}
    </div>
  );
}

// ===========================================================================
// TRIP BOARD — trip-centric view with clearance progress
// ===========================================================================

const CLEARANCE_STATUSES = ["not_started", "submitted", "approved"] as const;
const CLEARANCE_LABELS: Record<string, string> = {
  outbound_clearance: "OB Clearance",
  landing_permit: "Landing Permit",
  inbound_clearance: "IB Clearance",
  overflight_permit: "Overflight Permit",
};
const CLEARANCE_LABELS_FULL: Record<string, string> = {
  outbound_clearance: "Outbound Clearance",
  landing_permit: "Landing Permit",
  inbound_clearance: "Inbound Clearance",
  overflight_permit: "Overflight Permit",
};

function clearanceStatusColor(s: string) {
  switch (s) {
    case "approved": return "bg-green-100 text-green-800";
    case "submitted": return "bg-blue-100 text-blue-800";
    default: return "bg-gray-100 text-gray-600";
  }
}

function clearanceStatusLabel(s: string) {
  switch (s) {
    case "approved": return "Approved";
    case "submitted": return "Submitted";
    default: return "Not Started";
  }
}

const TRIP_TIME_RANGES = [
  { key: "48h", label: "48 Hours", hours: 48 },
  { key: "7d", label: "1 Week", hours: 168 },
  { key: "30d", label: "Month", hours: 720 },
] as const;
type TripTimeRange = (typeof TRIP_TIME_RANGES)[number]["key"];
type ViewMode = "trips" | "segments";

// A single flight leg derived from a trip
type FlightSegment = {
  segmentKey: string;       // unique key for React
  trip: IntlTrip;           // parent trip
  legIndex: number;         // index within route (0 = first leg)
  depIcao: string;
  arrIcao: string;
  departureTime: Date | null;
  arrivalTime: Date | null;
  clearances: IntlTripClearance[]; // clearances relevant to this leg
  isFirstLeg: boolean;
  isLastLeg: boolean;
};

function flattenTripsToSegments(trips: IntlTrip[]): FlightSegment[] {
  const segments: FlightSegment[] = [];
  for (const trip of trips) {
    const route = trip.route_icaos;
    const snap = trip.schedule_snapshot ?? {};
    const totalLegs = route.length - 1;
    for (let i = 0; i < totalLegs; i++) {
      const flightId = trip.flight_ids[i];
      const times = flightId ? snap[flightId] : null;
      const isFirst = i === 0;
      const isLast = i === totalLegs - 1;

      // Map clearances to this leg
      const legClearances = (trip.clearances ?? []).filter((c) => {
        if (c.clearance_type === "outbound_clearance" && isFirst) return true;
        if (c.clearance_type === "inbound_clearance" && isLast) return true;
        if (c.clearance_type === "landing_permit" && c.airport_icao === route[i + 1]) return true;
        if (c.clearance_type === "overflight_permit") {
          // Match overflight to leg via notes (e.g. "... auto-detected on KTEB→MYNN")
          const marker = `${route[i]}→${route[i + 1]}`;
          if (c.notes?.includes(marker)) return true;
          // If no notes marker, show on first leg as fallback for manually-added overflights
          if (!c.notes?.includes("auto-detected on") && isFirst) return true;
        }
        return false;
      });

      segments.push({
        segmentKey: `${trip.id}-leg-${i}`,
        trip,
        legIndex: i,
        depIcao: route[i],
        arrIcao: route[i + 1],
        departureTime: times ? new Date(times.dep) : null,
        arrivalTime: times?.arr ? new Date(times.arr) : null,
        clearances: legClearances,
        isFirstLeg: isFirst,
        isLastLeg: isLast,
      });
    }
  }
  // Sort chronologically by departure time (nulls at end)
  segments.sort((a, b) => {
    if (!a.departureTime && !b.departureTime) return 0;
    if (!a.departureTime) return 1;
    if (!b.departureTime) return -1;
    return a.departureTime.getTime() - b.departureTime.getTime();
  });
  return segments;
}

function TripBoard({ trips, countries, onRefresh }: { trips: IntlTrip[]; countries: Country[]; onRefresh: () => void }) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [timeRange, setTimeRange] = useState<TripTimeRange>("7d");
  const [viewMode, setViewMode] = useState<ViewMode>("trips");

  const now = Date.now();

  // Trip view: show trips that have at least one future leg, up to the selected range
  const filteredTrips = trips.filter((t) => {
    const range = TRIP_TIME_RANGES.find((r) => r.key === timeRange);
    const snap = t.schedule_snapshot ?? {};
    const flightTimes = Object.values(snap).map((s) => new Date(s.dep).getTime());
    const hasFutureLeg = flightTimes.length > 0
      ? flightTimes.some((ft) => ft > now)
      : new Date(t.trip_date + "T00:00:00Z").getTime() > now; // fallback if no snapshot
    if (!hasFutureLeg) return false;
    if (!range) return true;
    // Upper bound: earliest future leg must be within the time range
    const earliestFuture = Math.min(...flightTimes.filter((ft) => ft > now));
    return (isFinite(earliestFuture) ? earliestFuture : new Date(t.trip_date + "T00:00:00Z").getTime()) <= now + range.hours * 3600000;
  });

  // Segment view: only show segments with future departures
  const allSegments = flattenTripsToSegments(trips);
  const filteredSegments = allSegments.filter((seg) => {
    const depTime = seg.departureTime?.getTime() ?? new Date(seg.trip.trip_date + "T00:00:00Z").getTime();
    if (depTime <= now) return false; // past segments hidden
    const range = TRIP_TIME_RANGES.find((r) => r.key === timeRange);
    if (!range) return true;
    return depTime <= now + range.hours * 3600000;
  });

  if (trips.length === 0) {
    return <p className="text-sm text-gray-500">No international trips detected in the next 30 days.</p>;
  }

  const count = viewMode === "trips" ? filteredTrips.length : filteredSegments.length;
  const label = viewMode === "trips" ? "trip" : "segment";

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        {/* View mode toggle */}
        <div className="flex rounded-md border border-gray-200 overflow-hidden">
          <button
            onClick={() => setViewMode("trips")}
            className={`px-3 py-1 text-xs font-medium transition-colors ${
              viewMode === "trips"
                ? "bg-gray-800 text-white"
                : "bg-white text-gray-600 hover:bg-gray-50"
            }`}
          >
            By Trip
          </button>
          <button
            onClick={() => setViewMode("segments")}
            className={`px-3 py-1 text-xs font-medium transition-colors border-l border-gray-200 ${
              viewMode === "segments"
                ? "bg-gray-800 text-white"
                : "bg-white text-gray-600 hover:bg-gray-50"
            }`}
          >
            By Segment
          </button>
        </div>

        {/* Time range pills */}
        <div className="flex gap-1">
          {TRIP_TIME_RANGES.map((r) => (
            <button
              key={r.key}
              onClick={() => setTimeRange(r.key)}
              className={`px-3 py-1 text-xs font-medium rounded-full transition-colors ${
                timeRange === r.key
                  ? "bg-blue-600 text-white"
                  : "bg-gray-100 text-gray-600 hover:bg-gray-200"
              }`}
            >
              {r.label}
            </button>
          ))}
        </div>
        <p className="text-xs text-gray-500">{count} {label}{count !== 1 ? "s" : ""}</p>
      </div>

      {viewMode === "trips" ? (
        <>
          {filteredTrips.map((trip) => (
            <TripRow
              key={trip.id}
              trip={trip}
              countries={countries}
              expanded={expandedId === trip.id}
              onToggle={() => setExpandedId(expandedId === trip.id ? null : trip.id)}
              onRefresh={onRefresh}
            />
          ))}
          {filteredTrips.length === 0 && (
            <p className="text-sm text-gray-500">No international trips in this time range.</p>
          )}
        </>
      ) : (
        <>
          {filteredSegments.map((seg) => (
            <SegmentRow
              key={seg.segmentKey}
              segment={seg}
              countries={countries}
              expanded={expandedId === seg.segmentKey}
              onToggle={() => setExpandedId(expandedId === seg.segmentKey ? null : seg.segmentKey)}
              onRefresh={onRefresh}
            />
          ))}
          {filteredSegments.length === 0 && (
            <p className="text-sm text-gray-500">No flight segments in this time range.</p>
          )}
        </>
      )}
    </div>
  );
}

// ===========================================================================
// SEGMENT ROW — individual flight leg in segment view
// ===========================================================================

function SegmentRow({ segment, countries, expanded, onToggle, onRefresh }: {
  segment: FlightSegment;
  countries: Country[];
  expanded: boolean;
  onToggle: () => void;
  onRefresh: () => void;
}) {
  const { trip, depIcao, arrIcao, departureTime, clearances } = segment;

  const allApproved = clearances.length > 0 && clearances.every((c) => c.status === "approved");
  const anySubmitted = clearances.some((c) => c.status === "submitted");

  const daysOut = departureTime
    ? Math.ceil((departureTime.getTime() - Date.now()) / (1000 * 60 * 60 * 24))
    : null;

  return (
    <div className={`border rounded-lg overflow-hidden ${
      allApproved ? "border-green-200" : anySubmitted ? "border-blue-200" : "border-gray-200"
    }`}>
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-gray-50 transition-colors"
      >
        {/* Tail */}
        <span className="text-sm font-semibold w-20">{trip.tail_number}</span>

        {/* Leg: DEP → ARR */}
        <span className="text-sm flex items-center gap-1">
          <span className={`font-medium ${isInternationalIcao(depIcao) ? "text-blue-700" : "text-gray-800"}`}>
            {depIcao}
          </span>
          <span className="text-gray-300">&rarr;</span>
          <span className={`font-medium ${isInternationalIcao(arrIcao) ? "text-blue-700" : "text-gray-800"}`}>
            {arrIcao}
          </span>
        </span>

        {/* Departure time */}
        {departureTime && (
          <span className="text-xs text-gray-500 tabular-nums">
            {departureTime.toLocaleDateString("en-US", { month: "short", day: "numeric" })}{" "}
            {departureTime.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" })}Z
          </span>
        )}

        {/* Clearance status badge */}
        {clearances.length > 0 && (
          <span className={`text-[11px] px-2 py-0.5 rounded-full font-medium ml-auto whitespace-nowrap ${
            allApproved ? "bg-green-100 text-green-700" :
            anySubmitted ? "bg-blue-100 text-blue-700" :
            "bg-gray-100 text-gray-500"
          }`}>
            {allApproved ? "Ready" :
             anySubmitted ? `${clearances.filter((c) => c.status === "approved").length}/${clearances.length} Cleared` :
             "Not Started"}
          </span>
        )}

        {/* Mini clearance badges */}
        <span className={`flex gap-1.5 ${clearances.length === 0 ? "ml-auto" : "mr-2"}`}>
          {clearances.map((c) => (
            <span
              key={c.id}
              className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${clearanceStatusColor(c.status)}`}
              title={`${CLEARANCE_LABELS[c.clearance_type]} (${c.airport_icao}): ${clearanceStatusLabel(c.status)}`}
            >
              {c.clearance_type === "outbound_clearance" ? "OB" :
               c.clearance_type === "inbound_clearance" ? "IB" :
               c.clearance_type === "overflight_permit" ? "OVF" :
               c.airport_icao}
            </span>
          ))}
        </span>

        {/* Date badge */}
        {daysOut !== null && (
          <span className={`text-xs px-2 py-0.5 rounded-full whitespace-nowrap ${
            daysOut < 0 ? "bg-gray-100 text-gray-400" : daysOut === 0 ? "bg-red-100 text-red-700" : daysOut <= 4 ? "bg-red-100 text-red-700" : daysOut <= 7 ? "bg-yellow-100 text-yellow-700" : "bg-gray-100 text-gray-600"
          }`}>
            {daysOut < 0 ? `${Math.abs(daysOut)}d ago` : daysOut === 0 ? "Today" : `${daysOut}d`}
          </span>
        )}

        {/* Chevron */}
        <svg className={`w-4 h-4 text-gray-400 transition-transform ${expanded ? "rotate-180" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {/* Expanded: show full trip detail */}
      {expanded && (
        <TripDetail trip={trip} countries={countries} onRefresh={onRefresh} />
      )}
    </div>
  );
}

function TripRow({ trip, countries, expanded, onToggle, onRefresh }: {
  trip: IntlTrip;
  countries: Country[];
  expanded: boolean;
  onToggle: () => void;
  onRefresh: () => void;
}) {
  const clearances = trip.clearances ?? [];
  const tripDate = new Date(trip.trip_date + "T00:00:00");
  const daysOut = Math.ceil((tripDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
  const now = Date.now();

  // Overall progress
  const total = clearances.length;
  const approved = clearances.filter((c) => c.status === "approved").length;
  const allApproved = total > 0 && approved === total;
  const anySubmitted = clearances.some((c) => c.status === "submitted");

  // Determine which legs are completed (departure in the past)
  const snap = trip.schedule_snapshot ?? {};
  const legCompleted: boolean[] = [];
  for (let i = 0; i < trip.route_icaos.length - 1; i++) {
    const fid = trip.flight_ids[i];
    const times = fid ? snap[fid] : null;
    legCompleted.push(times ? new Date(times.dep).getTime() <= now : false);
  }

  return (
    <div className={`border rounded-lg overflow-hidden ${
      allApproved ? "border-green-200" : anySubmitted ? "border-blue-200" : "border-gray-200"
    }`}>
      {/* Collapsed row */}
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-gray-50 transition-colors"
      >
        {/* Tail */}
        <span className="text-sm font-semibold w-20">{trip.tail_number}</span>

        {/* Route: KTEB → MYNN → MKJP → KOPF — completed legs greyed out */}
        <span className="text-sm flex items-center gap-1 flex-wrap">
          {trip.route_icaos.map((icao, i) => {
            // An airport is "done" if the leg departing FROM it is completed
            // The final airport is "done" if the leg arriving INTO it is completed
            const isDone = i < legCompleted.length ? legCompleted[i] : (i > 0 && legCompleted[i - 1]);
            const arrowDone = i > 0 && legCompleted[i - 1];
            return (
              <span key={i} className="flex items-center gap-1">
                {i > 0 && <span className={arrowDone ? "text-gray-200 line-through" : "text-gray-300"}>&rarr;</span>}
                <span className={
                  isDone
                    ? "font-medium text-gray-300 line-through"
                    : `font-medium ${isInternationalIcao(icao) ? "text-blue-700" : "text-gray-800"}`
                }>
                  {icao}
                </span>
              </span>
            );
          })}
        </span>

        {/* Completed legs indicator */}
        {legCompleted.some(Boolean) && (
          <span className="text-[10px] px-2 py-0.5 rounded-full bg-gray-100 text-gray-400 font-medium whitespace-nowrap">
            {legCompleted.filter(Boolean).length}/{legCompleted.length} legs done
          </span>
        )}

        {/* Overall status badge */}
        <span className={`text-[11px] px-2 py-0.5 rounded-full font-medium ml-auto whitespace-nowrap ${
          allApproved ? "bg-green-100 text-green-700" :
          anySubmitted ? "bg-blue-100 text-blue-700" :
          "bg-gray-100 text-gray-500"
        }`}>
          {allApproved ? "Ready" : anySubmitted ? `${approved}/${total} Cleared` : "Not Started"}
        </span>

        {/* Mini clearance badges */}
        <span className="flex gap-1.5 mr-2">
          {clearances.map((c) => (
            <span
              key={c.id}
              className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${clearanceStatusColor(c.status)}`}
              title={`${CLEARANCE_LABELS[c.clearance_type]} (${c.airport_icao}): ${clearanceStatusLabel(c.status)}`}
            >
              {c.clearance_type === "outbound_clearance" ? "OB" :
               c.clearance_type === "inbound_clearance" ? "IB" :
               c.clearance_type === "overflight_permit" ? "OVF" :
               c.airport_icao}
            </span>
          ))}
        </span>

        {/* Date badge */}
        <span className={`text-xs px-2 py-0.5 rounded-full whitespace-nowrap ${
          daysOut < 0 ? "bg-gray-100 text-gray-400" : daysOut === 0 ? "bg-red-100 text-red-700" : daysOut <= 4 ? "bg-red-100 text-red-700" : daysOut <= 7 ? "bg-yellow-100 text-yellow-700" : "bg-gray-100 text-gray-600"
        }`}>
          {tripDate.toLocaleDateString("en-US", { month: "short", day: "numeric" })}
          {daysOut < 0 ? ` (${Math.abs(daysOut)}d ago)` : daysOut === 0 ? " (Today)" : ` (${daysOut}d)`}
        </span>

        {/* Chevron */}
        <svg className={`w-4 h-4 text-gray-400 transition-transform ${expanded ? "rotate-180" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {/* Expanded detail */}
      {expanded && (
        <TripDetail trip={trip} countries={countries} onRefresh={onRefresh} />
      )}
    </div>
  );
}

// ===========================================================================
// TRIP DETAIL — expanded view with clearance cards per airport
// ===========================================================================

type OverflightInfo = { country_name: string; country_iso: string; fir_id: string };

function TripDetail({ trip, countries, onRefresh }: {
  trip: IntlTrip;
  countries: Country[];
  onRefresh: () => void;
}) {
  const [updating, setUpdating] = useState<string | null>(null);
  const [showAddOvf, setShowAddOvf] = useState(false);
  const [newOvfIcao, setNewOvfIcao] = useState("");
  const [addingOvf, setAddingOvf] = useState(false);
  const [overflights, setOverflights] = useState<OverflightInfo[]>([]);
  const [ovfLoaded, setOvfLoaded] = useState(false);
  const [autoCreatingOvf, setAutoCreatingOvf] = useState(false);
  const [legRoutes, setLegRoutes] = useState<Array<{ dep: string; arr: string; route: string | null; method: string }>>([]);

  const clearances = trip.clearances ?? [];

  // Auto-detect overflown countries for each leg via route-analysis (ForeFlight + great-circle)
  useEffect(() => {
    if (ovfLoaded) return;
    setOvfLoaded(true);
    const route = trip.route_icaos;
    if (route.length < 2) return;

    // Use route-analysis endpoint which calls ForeFlight when available
    const legFetches = [];
    for (let i = 0; i < route.length - 1; i++) {
      const dep = route[i];
      const arr = route[i + 1];
      const params = new URLSearchParams({ dep, arr });
      if (trip.tail_number) params.set("tail", trip.tail_number);
      legFetches.push(
        fetch(`/api/ops/intl/route-analysis?${params}`)
          .then((r) => r.json())
          .then((d) => ({
            dep,
            arr,
            overflights: d.overflights ?? [],
            ffRoute: d.foreflight?.route ?? null,
            method: d.method ?? "great_circle",
          }))
          .catch(() => ({ dep, arr, overflights: [], ffRoute: null, method: "error" }))
      );
    }
    Promise.all(legFetches).then((results) => {
      // Collect route strings per leg
      setLegRoutes(results.map((r) => ({ dep: r.dep, arr: r.arr, route: r.ffRoute, method: r.method })));
      const seen = new Set<string>();
      const all: OverflightInfo[] = [];

      // Add all FIR-detected overflights
      for (const leg of results) {
        for (const o of leg.overflights) {
          if (!seen.has(o.country_iso)) {
            seen.add(o.country_iso);
            all.push(o);
          }
        }
      }

      // Also add countries from ICAO prefixes for all non-US airports in the route
      // This catches cases where FIR data is incomplete (e.g., Canada)
      const ICAO_TO_COUNTRY: Record<string, { iso: string; name: string }> = {
        C: { iso: "CA", name: "Canada" },
        MM: { iso: "MX", name: "Mexico" },
        MY: { iso: "BS", name: "Bahamas" },
        MU: { iso: "CU", name: "Cuba" },
        MK: { iso: "JM", name: "Jamaica" },
        MB: { iso: "TC", name: "Turks & Caicos" },
        MD: { iso: "DO", name: "Dominican Republic" },
        MT: { iso: "HT", name: "Haiti" },
        MG: { iso: "GT", name: "Guatemala" },
        MH: { iso: "HN", name: "Honduras" },
        MR: { iso: "CR", name: "Costa Rica" },
        MP: { iso: "PA", name: "Panama" },
        MZ: { iso: "BZ", name: "Belize" },
        MN: { iso: "NI", name: "Nicaragua" },
        MS: { iso: "SV", name: "El Salvador" },
        MW: { iso: "KY", name: "Cayman Islands" },
        SK: { iso: "CO", name: "Colombia" },
        SV: { iso: "VE", name: "Venezuela" },
        SB: { iso: "BR", name: "Brazil" },
        SE: { iso: "EC", name: "Ecuador" },
        SP: { iso: "PE", name: "Peru" },
        SA: { iso: "AR", name: "Argentina" },
        SC: { iso: "CL", name: "Chile" },
        TN: { iso: "CW", name: "Curacao" },
        TT: { iso: "TT", name: "Trinidad & Tobago" },
        TB: { iso: "BB", name: "Barbados" },
        TF: { iso: "GP", name: "Guadeloupe" },
        TX: { iso: "BM", name: "Bermuda" },
      };

      for (const icao of route) {
        if (!isInternationalIcao(icao)) continue;
        // Try 2-char prefix, then 1-char
        const two = icao.slice(0, 2);
        const one = icao.slice(0, 1);
        const match = ICAO_TO_COUNTRY[two] ?? ICAO_TO_COUNTRY[one];
        if (match && !seen.has(match.iso)) {
          seen.add(match.iso);
          all.push({ country_iso: match.iso, country_name: match.name, fir_id: icao.slice(0, 2) });
        }
      }

      setOverflights(all);
    });
  }, [trip.route_icaos, ovfLoaded]);

  async function updateClearanceStatus(clearanceId: string, status: string) {
    setUpdating(clearanceId);
    try {
      await fetch(`/api/ops/intl/trips/${trip.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clearance_id: clearanceId, status }),
      });
      onRefresh();
    } catch { /* ignore */ }
    setUpdating(null);
  }

  async function updateClearanceNotes(clearanceId: string, notes: string) {
    try {
      await fetch(`/api/ops/intl/trips/${trip.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clearance_id: clearanceId, notes }),
      });
      onRefresh();
    } catch { /* ignore */ }
  }

  async function addOverflightPermit() {
    if (!newOvfIcao.trim()) return;
    setAddingOvf(true);
    try {
      await fetch(`/api/ops/intl/trips/${trip.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clearance_type: "overflight_permit",
          airport_icao: newOvfIcao.toUpperCase().trim(),
        }),
      });
      setNewOvfIcao("");
      setShowAddOvf(false);
      onRefresh();
    } catch { /* ignore */ }
    setAddingOvf(false);
  }

  async function removeClearance(clearanceId: string) {
    if (!confirm("Remove this clearance?")) return;
    try {
      await fetch(`/api/ops/intl/trips/${trip.id}?clearance_id=${clearanceId}`, {
        method: "DELETE",
      });
      onRefresh();
    } catch { /* ignore */ }
  }

  // Group clearances for display: ordered by sort_order
  const sortedClearances = [...clearances].sort((a, b) => a.sort_order - b.sort_order);

  async function updatePaxStatus(status: string) {
    try {
      await fetch(`/api/ops/intl/trips/${trip.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pax_data_status: status }),
      });
      onRefresh();
    } catch { /* ignore */ }
  }

  return (
    <div className="border-t border-gray-200 bg-gray-50 px-4 py-4 space-y-3">
      {/* JetInsight link */}
      {trip.jetinsight_url && (
        <a
          href={trip.jetinsight_url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 text-xs font-medium text-blue-600 hover:text-blue-800 hover:underline"
        >
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 6H5.25A2.25 2.25 0 003 8.25v10.5A2.25 2.25 0 005.25 21h10.5A2.25 2.25 0 0018 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25" />
          </svg>
          Open in JetInsight
        </a>
      )}

      {/* JetInsight Passenger Data Status */}
      <div className="border border-gray-200 bg-white rounded-lg px-3 py-2.5">
        <div className="flex items-center justify-between">
          <h4 className="text-xs font-semibold text-gray-700">JetInsight Passenger Data Uploaded?</h4>
          <select
            value={trip.pax_data_status ?? "not_started"}
            onChange={(e) => updatePaxStatus(e.target.value)}
            className={`text-xs border rounded px-2 py-1 font-medium ${
              trip.pax_data_status === "uploaded"
                ? "border-green-300 bg-green-50 text-green-700"
                : trip.pax_data_status === "salesperson_notified"
                ? "border-yellow-300 bg-yellow-50 text-yellow-700"
                : "border-gray-300 bg-gray-50 text-gray-600"
            }`}
          >
            <option value="not_started">Not Started</option>
            <option value="salesperson_notified">Salesperson Notified</option>
            <option value="uploaded">Passenger Data on JetInsight</option>
          </select>
        </div>
      </div>

      {/* Route header */}
      <div className="flex items-center justify-between">
        <h4 className="text-xs font-semibold text-gray-700 uppercase tracking-wide">
          Trip Clearance Progress
        </h4>
        <button
          onClick={() => setShowAddOvf(!showAddOvf)}
          className="text-xs text-blue-600 hover:text-blue-800 font-medium"
        >
          + Add Overflight Permit
        </button>
      </div>

      {/* Add overflight form */}
      {showAddOvf && (
        <div className="flex gap-2 items-end p-2 bg-white border border-gray-200 rounded">
          <div>
            <label className="text-[10px] text-gray-500">Country/Airspace ICAO</label>
            <input
              value={newOvfIcao}
              onChange={(e) => setNewOvfIcao(e.target.value.toUpperCase())}
              placeholder="e.g. MUFH"
              className="block w-32 text-xs border border-gray-300 rounded px-2 py-1"
            />
          </div>
          <button
            onClick={addOverflightPermit}
            disabled={addingOvf}
            className="px-2 py-1 text-xs bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
          >
            {addingOvf ? "Adding..." : "Add"}
          </button>
          <button onClick={() => setShowAddOvf(false)} className="px-2 py-1 text-xs text-gray-500">Cancel</button>
        </div>
      )}

      {/* Clearance cards */}
      <div className="space-y-2">
        {sortedClearances.map((c) => (
          <ClearanceCard
            key={c.id}
            clearance={c}
            countries={countries}
            tripId={trip.id}
            updating={updating === c.id}
            onStatusChange={(status) => updateClearanceStatus(c.id, status)}
            onNotesChange={(notes) => updateClearanceNotes(c.id, notes)}
            onRemove={c.clearance_type === "overflight_permit" ? () => removeClearance(c.id) : undefined}
            onRefresh={onRefresh}
          />
        ))}
      </div>

      {/* Download All button — only if any clearance has a file */}
      {clearances.some((c) => c.file_filename) && (
        <div className="flex justify-end">
          <button
            onClick={async () => {
              try {
                const res = await fetch(`/api/ops/intl/trips/${trip.id}`);
                const data = await res.json();
                const files = data.files ?? [];
                if (files.length === 0) return;
                if (files.length === 1) {
                  window.open(files[0].url, "_blank");
                  return;
                }
                const JSZip = (await import("jszip")).default;
                const zip = new JSZip();
                await Promise.all(
                  files.map(async (f: { clearance_type: string; airport_icao: string; filename: string; url: string }) => {
                    try {
                      const response = await fetch(f.url);
                      const blob = await response.blob();
                      zip.file(`${f.clearance_type}_${f.airport_icao}_${f.filename}`, blob);
                    } catch { /* skip */ }
                  })
                );
                const zipBlob = await zip.generateAsync({ type: "blob" });
                const url = URL.createObjectURL(zipBlob);
                const a = document.createElement("a");
                a.href = url;
                a.download = `${trip.tail_number}_clearances.zip`;
                a.click();
                URL.revokeObjectURL(url);
              } catch { /* ignore */ }
            }}
            className="inline-flex items-center gap-2 px-3 py-1.5 bg-blue-600 text-white text-xs font-medium rounded-lg hover:bg-blue-700 transition-colors"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" />
            </svg>
            Download All Clearances
          </button>
        </div>
      )}

      {/* Detected overflights — suggest permits for countries that require them */}
      {overflights.length > 0 && (() => {
        const existingOvfIcaos = new Set(
          clearances
            .filter((c) => c.clearance_type === "overflight_permit")
            .map((c) => c.airport_icao)
        );
        const ovfPermitCountries = overflights.filter((o) => {
          const c = countries.find((c) => c.iso_code === o.country_iso);
          return c?.overflight_permit_required && !existingOvfIcaos.has(o.fir_id);
        });

        return (
          <div className="space-y-2">
            {/* ForeFlight route strings per leg */}
            {legRoutes.some((lr) => lr.route) && (
              <div>
                <h4 className="text-xs font-semibold text-gray-700 uppercase tracking-wide mb-1">Route</h4>
                {legRoutes.filter((lr) => lr.route).map((lr, i) => (
                  <div key={i} className="mb-1">
                    <span className="text-[10px] text-gray-400 mr-1">{lr.dep}→{lr.arr}</span>
                    <span className="text-[10px] bg-gray-100 text-gray-500 px-1 py-0.5 rounded mr-1">
                      {lr.method === "foreflight+great_circle" ? "ForeFlight" : lr.method}
                    </span>
                    <p className="text-xs text-gray-600 font-mono bg-white border border-gray-200 rounded px-2 py-1 mt-0.5 break-all">
                      {lr.route}
                    </p>
                  </div>
                ))}
              </div>
            )}

            {/* Airspace transited summary */}
            <div>
              <h4 className="text-xs font-semibold text-gray-700 uppercase tracking-wide mb-1">Airspace Transited</h4>
              <div className="flex gap-1 flex-wrap">
                {overflights.map((o) => {
                  const c = countries.find((c) => c.iso_code === o.country_iso);
                  const needsPermit = c?.overflight_permit_required;
                  return (
                    <span
                      key={o.fir_id}
                      className={`text-[10px] px-1.5 py-0.5 rounded ${
                        needsPermit ? "bg-orange-100 text-orange-700 font-medium" : "bg-gray-100 text-gray-500"
                      }`}
                      title={`${o.country_name}${needsPermit ? " — PERMIT REQUIRED" : ""}`}
                    >
                      {o.country_iso} {o.country_name}{needsPermit ? " !" : ""}
                    </span>
                  );
                })}
              </div>
            </div>

            {/* Auto-create missing overflight permits */}
            {ovfPermitCountries.length > 0 && (
              <div className="bg-orange-50 border border-orange-200 rounded px-3 py-2">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-xs font-medium text-orange-800">
                      {ovfPermitCountries.length} overflight permit{ovfPermitCountries.length > 1 ? "s" : ""} may be needed:
                    </p>
                    <p className="text-xs text-orange-700 mt-0.5">
                      {ovfPermitCountries.map((o) => o.country_name).join(", ")}
                    </p>
                  </div>
                  <button
                    onClick={async () => {
                      setAutoCreatingOvf(true);
                      for (const o of ovfPermitCountries) {
                        await fetch(`/api/ops/intl/trips/${trip.id}`, {
                          method: "POST",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({
                            clearance_type: "overflight_permit",
                            airport_icao: o.fir_id,
                            notes: `${o.country_name} (${o.country_iso}) — auto-detected`,
                          }),
                        });
                      }
                      setAutoCreatingOvf(false);
                      onRefresh();
                    }}
                    disabled={autoCreatingOvf}
                    className="px-3 py-1 text-xs bg-orange-600 text-white rounded hover:bg-orange-700 disabled:opacity-50"
                  >
                    {autoCreatingOvf ? "Creating..." : "Auto-Add Overflight Permits"}
                  </button>
                </div>
              </div>
            )}
          </div>
        );
      })()}

      {/* Trip documents */}
      {trip.tail_number && trip.route_icaos.length >= 2 && (
        <TripDocsPanel
          tail={trip.tail_number}
          dep={trip.route_icaos[0]}
          arr={trip.route_icaos[trip.route_icaos.length - 1]}
        />
      )}
    </div>
  );
}

// ===========================================================================
// CLEARANCE CARD — single clearance item with status control
// ===========================================================================

function ClearanceCard({ clearance, countries, tripId, updating, onStatusChange, onNotesChange, onRemove, onRefresh }: {
  clearance: IntlTripClearance;
  countries: Country[];
  tripId: string;
  updating: boolean;
  onStatusChange: (status: string) => void;
  onNotesChange: (notes: string) => void;
  onRemove?: () => void;
  onRefresh: () => void;
}) {
  const [editingNotes, setEditingNotes] = useState(false);
  const [notesVal, setNotesVal] = useState(clearance.notes ?? "");
  const [uploading, setUploading] = useState(false);

  const typeLabel = CLEARANCE_LABELS_FULL[clearance.clearance_type] ?? clearance.clearance_type;
  const isIntl = isInternationalIcao(clearance.airport_icao);

  // Color coding by type
  const typeBg = clearance.clearance_type === "outbound_clearance"
    ? "bg-amber-50 border-amber-200"
    : clearance.clearance_type === "landing_permit"
    ? "bg-blue-50 border-blue-200"
    : clearance.clearance_type === "inbound_clearance"
    ? "bg-emerald-50 border-emerald-200"
    : "bg-purple-50 border-purple-200"; // overflight

  const typeBadgeBg = clearance.clearance_type === "outbound_clearance"
    ? "bg-amber-100 text-amber-700"
    : clearance.clearance_type === "landing_permit"
    ? "bg-blue-100 text-blue-700"
    : clearance.clearance_type === "inbound_clearance"
    ? "bg-emerald-100 text-emerald-700"
    : "bg-purple-100 text-purple-700";

  return (
    <div className={`border rounded-lg px-4 py-3 ${typeBg}`}>
      <div className="flex items-center gap-3">
        {/* Type badge */}
        <span className={`text-[10px] font-semibold px-2 py-0.5 rounded uppercase tracking-wide ${typeBadgeBg}`}>
          {typeLabel}
        </span>

        {/* Airport */}
        <span className="text-sm font-bold">{clearance.airport_icao}</span>

        {/* Status dropdown */}
        <select
          value={clearance.status}
          onChange={(e) => onStatusChange(e.target.value)}
          disabled={updating}
          className={`ml-auto text-xs rounded-lg px-3 py-1.5 border-0 font-semibold cursor-pointer transition-colors ${clearanceStatusColor(clearance.status)} ${updating ? "opacity-50" : ""}`}
        >
          {CLEARANCE_STATUSES.map((s) => (
            <option key={s} value={s}>{clearanceStatusLabel(s)}</option>
          ))}
        </select>

        {/* Remove button (only for overflight permits) */}
        {onRemove && (
          <button
            onClick={onRemove}
            className="text-gray-400 hover:text-red-500 transition-colors"
            title="Remove overflight permit"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        )}
      </div>

      {/* Notes + File */}
      <div className="mt-2 flex items-start gap-4">
        {/* Notes */}
        <div className="flex-1">
          {editingNotes ? (
            <div className="flex gap-2 items-center">
              <input
                value={notesVal}
                onChange={(e) => setNotesVal(e.target.value)}
                className="flex-1 text-xs border border-gray-300 rounded px-2 py-1"
                placeholder="Add notes..."
                onKeyDown={(e) => {
                  if (e.key === "Enter") { onNotesChange(notesVal); setEditingNotes(false); }
                  if (e.key === "Escape") setEditingNotes(false);
                }}
                autoFocus
              />
              <button
                onClick={() => { onNotesChange(notesVal); setEditingNotes(false); }}
                className="text-xs text-blue-600 hover:text-blue-800"
              >
                Save
              </button>
              <button onClick={() => setEditingNotes(false)} className="text-xs text-gray-400">Cancel</button>
            </div>
          ) : (
            <button
              onClick={() => { setNotesVal(clearance.notes ?? ""); setEditingNotes(true); }}
              className="text-xs text-gray-500 hover:text-gray-700"
            >
              {clearance.notes || "Add notes..."}
            </button>
          )}
        </div>

        {/* File upload / view */}
        <div className="flex items-center gap-2">
          {clearance.file_filename ? (
            <>
              <button
                onClick={async () => {
                  const res = await fetch(`/api/ops/intl/trips/${tripId}?clearance_id=${clearance.id}`);
                  const data = await res.json();
                  if (data.download_url) window.open(data.download_url, "_blank");
                }}
                className="text-xs text-blue-600 hover:text-blue-800 flex items-center gap-1"
                title={clearance.file_filename}
              >
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M18.375 12.739l-7.693 7.693a4.5 4.5 0 01-6.364-6.364l10.94-10.94A3 3 0 1119.5 7.372L8.552 18.32m.009-.01l-.01.01m5.699-9.941l-7.81 7.81a1.5 1.5 0 002.112 2.13" />
                </svg>
                {clearance.file_filename.length > 20 ? clearance.file_filename.slice(0, 17) + "..." : clearance.file_filename}
              </button>
            </>
          ) : (
            <label className={`text-xs text-gray-400 hover:text-blue-600 cursor-pointer flex items-center gap-1 ${uploading ? "opacity-50 pointer-events-none" : ""}`}>
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" />
              </svg>
              {uploading ? "Uploading..." : "Upload"}
              <input
                type="file"
                className="hidden"
                accept=".pdf,.doc,.docx,.jpg,.png"
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  setUploading(true);
                  try {
                    const res = await fetch(`/api/ops/intl/trips/${tripId}`, {
                      method: "PATCH",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({
                        clearance_id: clearance.id,
                        filename: file.name,
                        content_type: file.type || "application/pdf",
                      }),
                    });
                    const data = await res.json();
                    if (data.upload_url) {
                      await fetch(data.upload_url, {
                        method: "PUT",
                        headers: { "Content-Type": file.type || "application/pdf" },
                        body: file,
                      });
                    }
                    onRefresh();
                  } catch { /* ignore */ }
                  setUploading(false);
                }}
              />
            </label>
          )}
        </div>
      </div>
    </div>
  );
}

// ===========================================================================
// TRIP DOCS PANEL — select & download documents for a trip
// ===========================================================================
type TripDoc = { id: string; name: string; document_type: string; entity_type: string; entity_id: string };

function TripDocsPanel({ tail, dep, arr }: { tail: string; dep: string; arr: string }) {
  const [open, setOpen] = useState(false);
  const [aircraft, setAircraft] = useState<TripDoc[]>([]);
  const [company, setCompany] = useState<TripDoc[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewName, setPreviewName] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editEntity, setEditEntity] = useState<{ type: string; id: string }>({ type: "", id: "" });

  const loadDocs = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/ops/intl/trip-docs?tail=${tail}`);
      const data = await res.json();
      const ac = data.aircraft ?? [];
      const co = data.company ?? [];
      setAircraft(ac);
      setCompany(co);
      if (!loaded) setSelected(new Set(ac.map((d: TripDoc) => d.id)));
      setLoaded(true);
    } catch { /* ignore */ }
    setLoading(false);
  }, [tail, loaded]);

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const selectAllGroup = (docs: TripDoc[]) => {
    setSelected((prev) => { const next = new Set(prev); docs.forEach((d) => next.add(d.id)); return next; });
  };
  const deselectAllGroup = (docs: TripDoc[]) => {
    setSelected((prev) => { const next = new Set(prev); docs.forEach((d) => next.delete(d.id)); return next; });
  };

  const previewDoc = async (docId: string, name: string) => {
    try {
      const res = await fetch(`/api/ops/intl/documents/${docId}`);
      const data = await res.json();
      if (data.download_url) { setPreviewUrl(data.download_url); setPreviewName(name); }
    } catch { /* ignore */ }
  };

  const startEdit = (d: TripDoc) => {
    setEditingId(d.id);
    setEditName(d.name);
    setEditEntity({ type: d.entity_type, id: d.entity_id });
  };

  const saveEdit = async () => {
    if (!editingId) return;
    try {
      await fetch(`/api/ops/intl/documents/${editingId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: editName, entity_type: editEntity.type, entity_id: editEntity.id }),
      });
      setEditingId(null);
      loadDocs(); // Refresh
    } catch { /* ignore */ }
  };

  const downloadSelected = async () => {
    if (selected.size === 0) return;
    setDownloading(true);
    try {
      const ids = [...selected].join(",");
      const res = await fetch(`/api/ops/intl/trip-docs?tail=${tail}&ids=${ids}`);
      const data = await res.json();
      const docs = data.documents ?? [];
      if (docs.length === 1) {
        window.open(docs[0].url, "_blank");
      } else {
        const JSZip = (await import("jszip")).default;
        const zip = new JSZip();
        await Promise.all(
          docs.map(async (doc: { name: string; entity_type: string; entity_id: string; url: string }) => {
            try {
              const response = await fetch(doc.url);
              const blob = await response.blob();
              const folder = doc.entity_type === "aircraft" ? `Aircraft - ${doc.entity_id}` : "Company";
              zip.file(`${folder}/${doc.name}.pdf`, blob);
            } catch { /* skip */ }
          })
        );
        const zipBlob = await zip.generateAsync({ type: "blob" });
        const url = URL.createObjectURL(zipBlob);
        const a = document.createElement("a"); a.href = url; a.download = `${tail}_${dep}-${arr}_trip-docs.zip`; a.click();
        URL.revokeObjectURL(url);
      }
    } catch { /* ignore */ }
    setDownloading(false);
  };

  const renderDoc = (d: TripDoc) => {
    if (editingId === d.id) {
      return (
        <div key={d.id} className="flex items-center gap-1 text-xs bg-yellow-50 rounded px-1 py-1 col-span-2">
          <input type="checkbox" checked={selected.has(d.id)} onChange={() => toggle(d.id)} className="rounded border-gray-300 text-blue-600" />
          <input value={editName} onChange={(e) => setEditName(e.target.value)} className="flex-1 border border-gray-300 rounded px-1.5 py-0.5 text-xs" />
          <select value={editEntity.type} onChange={(e) => setEditEntity({ ...editEntity, type: e.target.value, id: e.target.value === "company" ? "baker_aviation" : editEntity.id })} className="border border-gray-300 rounded px-1 py-0.5 text-[10px]">
            <option value="aircraft">Aircraft</option>
            <option value="company">Company</option>
          </select>
          {editEntity.type === "aircraft" && (
            <input value={editEntity.id} onChange={(e) => setEditEntity({ ...editEntity, id: e.target.value.toUpperCase() })} placeholder="N___" className="w-16 border border-gray-300 rounded px-1 py-0.5 text-[10px]" />
          )}
          <button onClick={saveEdit} className="text-green-600 hover:text-green-800 text-[10px] font-medium">Save</button>
          <button onClick={() => setEditingId(null)} className="text-gray-400 hover:text-gray-600 text-[10px]">Cancel</button>
        </div>
      );
    }
    return (
      <div key={d.id} className="flex items-center gap-1.5 text-xs hover:bg-gray-50 rounded px-1 py-0.5 group">
        <input type="checkbox" checked={selected.has(d.id)} onChange={() => toggle(d.id)} className="rounded border-gray-300 text-blue-600" />
        <button onClick={() => previewDoc(d.id, d.name)} className="truncate text-left text-blue-600 hover:text-blue-800 hover:underline flex-1" title="Click to preview">
          {d.name}
        </button>
        <button onClick={() => startEdit(d)} className="opacity-0 group-hover:opacity-100 text-gray-400 hover:text-gray-600 text-[10px]" title="Edit">
          ✎
        </button>
      </div>
    );
  };

  return (
    <div className="mt-4 pt-3 border-t border-gray-200">
      <div className="flex items-center justify-between">
        <h4 className="text-xs font-bold uppercase tracking-wide text-gray-500">Trip Documents</h4>
        <button
          onClick={() => { setOpen(!open); if (!loaded) loadDocs(); }}
          className="text-xs text-blue-600 hover:text-blue-800 font-medium"
        >
          {open ? "Hide" : `Select & Download`}
        </button>
      </div>

      {open && (
        <div className="mt-2 space-y-3">
          {loading ? (
            <p className="text-xs text-gray-400">Loading documents...</p>
          ) : (
            <>
              {aircraft.length > 0 && (
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs font-semibold text-gray-600">Aircraft — {tail}</span>
                    <div className="flex gap-2">
                      <button onClick={() => selectAllGroup(aircraft)} className="text-[10px] text-blue-500 hover:underline">All</button>
                      <button onClick={() => deselectAllGroup(aircraft)} className="text-[10px] text-gray-400 hover:underline">None</button>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-1">{aircraft.map(renderDoc)}</div>
                </div>
              )}

              {company.length > 0 && (
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs font-semibold text-gray-600">Company</span>
                    <div className="flex gap-2">
                      <button onClick={() => selectAllGroup(company)} className="text-[10px] text-blue-500 hover:underline">All</button>
                      <button onClick={() => deselectAllGroup(company)} className="text-[10px] text-gray-400 hover:underline">None</button>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-1">{company.map(renderDoc)}</div>
                </div>
              )}

              {aircraft.length === 0 && company.length === 0 && (
                <p className="text-xs text-gray-400">No documents found for {tail}</p>
              )}

              {selected.size > 0 && (
                <div className="flex justify-end">
                  <button onClick={downloadSelected} disabled={downloading}
                    className="inline-flex items-center gap-2 px-3 py-1.5 bg-blue-600 text-white text-xs font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors">
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" /></svg>
                    {downloading ? "Zipping..." : `Download ${selected.size} doc${selected.size > 1 ? "s" : ""}`}
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* PDF Preview Modal */}
      {previewUrl && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => setPreviewUrl(null)}>
          <div className="bg-white rounded-lg shadow-2xl w-[90vw] max-w-4xl h-[85vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-4 py-2 border-b border-gray-200">
              <h3 className="text-sm font-semibold text-gray-700 truncate">{previewName}</h3>
              <div className="flex items-center gap-2">
                <button onClick={() => window.open(previewUrl, "_blank")} className="text-xs text-blue-600 hover:text-blue-800">Open in new tab</button>
                <button onClick={() => setPreviewUrl(null)} className="text-gray-400 hover:text-gray-600 text-lg leading-none">✕</button>
              </div>
            </div>
            <div className="flex-1 min-h-0">
              <iframe src={previewUrl} className="w-full h-full border-0" title={previewName} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ===========================================================================
// COUNTRY PROFILES — growing knowledge base
// ===========================================================================
function CountryProfiles({ countries, onRefresh }: { countries: Country[]; onRefresh: () => void }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [requirements, setRequirements] = useState<CountryRequirement[]>([]);
  const [loadingReqs, setLoadingReqs] = useState(false);
  const [showAddReq, setShowAddReq] = useState(false);
  const [newReq, setNewReq] = useState({ name: "", requirement_type: "landing", description: "" });

  const selected = countries.find((c) => c.id === selectedId);

  useEffect(() => {
    if (!selectedId) { setRequirements([]); return; }
    setLoadingReqs(true);
    fetch(`/api/ops/intl/countries/${selectedId}/requirements`)
      .then((r) => r.json())
      .then((d) => setRequirements(d.requirements ?? []))
      .catch(() => setRequirements([]))
      .finally(() => setLoadingReqs(false));
  }, [selectedId]);

  async function addRequirement() {
    if (!selectedId || !newReq.name) return;
    await fetch(`/api/ops/intl/countries/${selectedId}/requirements`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(newReq),
    });
    setShowAddReq(false);
    setNewReq({ name: "", requirement_type: "landing", description: "" });
    // Reload requirements
    const res = await fetch(`/api/ops/intl/countries/${selectedId}/requirements`);
    const data = await res.json();
    setRequirements(data.requirements ?? []);
  }

  return (
    <div className="grid grid-cols-4 gap-4">
      {/* Country list */}
      <div className="col-span-1 space-y-1">
        <h3 className="text-xs font-semibold text-gray-700 uppercase mb-2">Countries ({countries.length})</h3>
        {countries.map((c) => (
          <button
            key={c.id}
            onClick={() => setSelectedId(c.id)}
            className={`w-full text-left px-2 py-1.5 rounded text-sm transition-colors ${
              selectedId === c.id ? "bg-blue-100 text-blue-800 font-medium" : "hover:bg-gray-100 text-gray-700"
            }`}
          >
            <span>{c.name}</span>
            <span className="text-xs text-gray-400 ml-1">({c.iso_code})</span>
            {c.overflight_permit_required && (
              <span className="ml-1 text-[10px] bg-orange-100 text-orange-700 px-1 rounded">OVF</span>
            )}
            {c.treat_as_international && (
              <span className="ml-1 text-[10px] bg-purple-100 text-purple-700 px-1 rounded">INTL*</span>
            )}
          </button>
        ))}
      </div>

      {/* Country detail */}
      <div className="col-span-3">
        {!selected ? (
          <p className="text-sm text-gray-500">Select a country to view its profile and requirements.</p>
        ) : (
          <CountryDetail country={selected} requirements={requirements} loadingReqs={loadingReqs}
            onAddReq={addRequirement} showAddReq={showAddReq} setShowAddReq={setShowAddReq}
            newReq={newReq} setNewReq={setNewReq}
            onReqChange={async () => {
              const res = await fetch(`/api/ops/intl/countries/${selectedId}/requirements`);
              const data = await res.json();
              setRequirements(data.requirements ?? []);
            }}
            onCountryChange={onRefresh}
          />
        )}
      </div>
    </div>
  );
}

// ===========================================================================
// COUNTRY DETAIL — editable country settings + requirements
// ===========================================================================
function CountryDetail({ country, requirements, loadingReqs, onAddReq, showAddReq, setShowAddReq, newReq, setNewReq, onReqChange, onCountryChange }: {
  country: Country;
  requirements: CountryRequirement[];
  loadingReqs: boolean;
  onAddReq: () => void;
  showAddReq: boolean;
  setShowAddReq: (v: boolean) => void;
  newReq: { name: string; requirement_type: string; description: string };
  setNewReq: (v: { name: string; requirement_type: string; description: string }) => void;
  onReqChange: () => void;
  onCountryChange: () => void;
}) {
  const [editingCountry, setEditingCountry] = useState(false);
  const [countryEdit, setCountryEdit] = useState({
    notes: country.notes ?? "",
    overflight_permit_required: country.overflight_permit_required,
    landing_permit_required: country.landing_permit_required,
    permit_lead_time_days: country.permit_lead_time_days?.toString() ?? "",
    permit_lead_time_working_days: country.permit_lead_time_working_days,
    treat_as_international: country.treat_as_international,
  });
  const [editingReqId, setEditingReqId] = useState<string | null>(null);

  async function saveCountry() {
    await fetch(`/api/ops/intl/countries/${country.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...countryEdit,
        permit_lead_time_days: countryEdit.permit_lead_time_days ? parseInt(countryEdit.permit_lead_time_days) : null,
      }),
    });
    setEditingCountry(false);
    onCountryChange();
  }

  async function updateReq(reqId: string, updates: Record<string, unknown>) {
    await fetch(`/api/ops/intl/requirements/${reqId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(updates),
    });
    setEditingReqId(null);
    onReqChange();
  }

  async function deleteReq(reqId: string) {
    if (!confirm("Delete this requirement?")) return;
    await fetch(`/api/ops/intl/requirements/${reqId}`, { method: "DELETE" });
    onReqChange();
  }

  return (
    <div className="space-y-4">
      {/* Country header */}
      <div>
        <div className="flex items-center gap-2">
          <h3 className="text-lg font-semibold">{country.name}</h3>
          <button onClick={() => setEditingCountry(!editingCountry)}
            className="text-xs text-blue-600 hover:text-blue-800">{editingCountry ? "Cancel" : "Edit"}</button>
        </div>

        {editingCountry ? (
          <div className="mt-2 p-3 bg-white border border-gray-200 rounded space-y-2">
            <div className="grid grid-cols-3 gap-3">
              <label className="flex items-center gap-1.5 text-xs cursor-pointer">
                <input type="checkbox" checked={countryEdit.overflight_permit_required}
                  onChange={(e) => setCountryEdit({ ...countryEdit, overflight_permit_required: e.target.checked })}
                  className="rounded border-gray-300" />
                Overflight Permit Required
              </label>
              <label className="flex items-center gap-1.5 text-xs cursor-pointer">
                <input type="checkbox" checked={countryEdit.landing_permit_required}
                  onChange={(e) => setCountryEdit({ ...countryEdit, landing_permit_required: e.target.checked })}
                  className="rounded border-gray-300" />
                Landing Permit Required
              </label>
              <label className="flex items-center gap-1.5 text-xs cursor-pointer">
                <input type="checkbox" checked={countryEdit.treat_as_international}
                  onChange={(e) => setCountryEdit({ ...countryEdit, treat_as_international: e.target.checked })}
                  className="rounded border-gray-300" />
                Treat as International
              </label>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="text-[10px] text-gray-500">Lead Time (days)</label>
                <input type="number" value={countryEdit.permit_lead_time_days}
                  onChange={(e) => setCountryEdit({ ...countryEdit, permit_lead_time_days: e.target.value })}
                  className="block w-full text-xs border border-gray-300 rounded px-2 py-1" />
              </div>
              <label className="flex items-center gap-1.5 text-xs cursor-pointer pt-4">
                <input type="checkbox" checked={countryEdit.permit_lead_time_working_days}
                  onChange={(e) => setCountryEdit({ ...countryEdit, permit_lead_time_working_days: e.target.checked })}
                  className="rounded border-gray-300" />
                Working Days Only
              </label>
            </div>
            <div>
              <label className="text-[10px] text-gray-500">Notes</label>
              <textarea value={countryEdit.notes}
                onChange={(e) => setCountryEdit({ ...countryEdit, notes: e.target.value })}
                className="block w-full text-xs border border-gray-300 rounded px-2 py-1 h-16" />
            </div>
            <button onClick={saveCountry} className="px-3 py-1 text-xs bg-blue-600 text-white rounded hover:bg-blue-700">Save Changes</button>
          </div>
        ) : (
          <>
            <div className="flex gap-2 mt-1 flex-wrap">
              {country.overflight_permit_required && (
                <span className="text-xs bg-orange-100 text-orange-700 px-2 py-0.5 rounded-full">Overflight Permit Required</span>
              )}
              {country.landing_permit_required && (
                <span className="text-xs bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full">Landing Permit Required</span>
              )}
              {country.permit_lead_time_days && (
                <span className="text-xs bg-yellow-100 text-yellow-700 px-2 py-0.5 rounded-full">
                  {country.permit_lead_time_days} {country.permit_lead_time_working_days ? "working" : ""} day{country.permit_lead_time_days > 1 ? "s" : ""} advance
                </span>
              )}
              {country.treat_as_international && (
                <span className="text-xs bg-purple-100 text-purple-700 px-2 py-0.5 rounded-full">Treated as International</span>
              )}
              {country.icao_prefixes?.length > 0 && (
                <span className="text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded-full">ICAO: {country.icao_prefixes.join(", ")}</span>
              )}
            </div>
            {country.notes && <p className="text-sm text-gray-600 mt-2">{country.notes}</p>}
          </>
        )}
      </div>

      {/* Requirements */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <h4 className="text-sm font-semibold text-gray-700">Requirements Checklist</h4>
          <button onClick={() => setShowAddReq(!showAddReq)} className="text-xs text-blue-600 hover:text-blue-800">+ Add Requirement</button>
        </div>

        {showAddReq && (
          <div className="flex gap-2 items-end mb-3 p-2 bg-white border border-gray-200 rounded">
            <div className="flex-1">
              <label className="text-[10px] text-gray-500">Name</label>
              <input value={newReq.name} onChange={(e) => setNewReq({ ...newReq, name: e.target.value })}
                className="block w-full text-xs border border-gray-300 rounded px-2 py-1" />
            </div>
            <div>
              <label className="text-[10px] text-gray-500">Type</label>
              <select value={newReq.requirement_type} onChange={(e) => setNewReq({ ...newReq, requirement_type: e.target.value })}
                className="block text-xs border border-gray-300 rounded px-2 py-1">
                <option value="landing">Landing</option>
                <option value="overflight">Overflight</option>
                <option value="customs">Customs</option>
                <option value="handling">Handling</option>
              </select>
            </div>
            <div className="flex-1">
              <label className="text-[10px] text-gray-500">Description</label>
              <input value={newReq.description} onChange={(e) => setNewReq({ ...newReq, description: e.target.value })}
                className="block w-full text-xs border border-gray-300 rounded px-2 py-1" />
            </div>
            <button onClick={onAddReq} className="px-2 py-1 text-xs bg-blue-600 text-white rounded hover:bg-blue-700">Save</button>
            <button onClick={() => setShowAddReq(false)} className="px-2 py-1 text-xs text-gray-500">Cancel</button>
          </div>
        )}

        {loadingReqs ? (
          <p className="text-xs text-gray-400 animate-pulse">Loading...</p>
        ) : requirements.length === 0 ? (
          <p className="text-xs text-gray-400">No requirements defined yet. Add requirements to build this country&apos;s checklist.</p>
        ) : (
          <div className="space-y-2">
            {requirements.map((r) => (
              <ReqCard key={r.id} req={r} editing={editingReqId === r.id}
                onEdit={() => setEditingReqId(editingReqId === r.id ? null : r.id)}
                onSave={(updates) => updateReq(r.id, updates)}
                onDelete={() => deleteReq(r.id)} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** Single editable requirement card */
function ReqCard({ req, editing, onEdit, onSave, onDelete }: {
  req: CountryRequirement; editing: boolean;
  onEdit: () => void; onSave: (u: Record<string, unknown>) => void; onDelete: () => void;
}) {
  const [edit, setEdit] = useState({
    name: req.name, description: req.description ?? "", requirement_type: req.requirement_type as string,
    required_documents: req.required_documents.join(", "),
  });
  const [uploading, setUploading] = useState(false);

  const handleAttachFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch(`/api/ops/intl/requirements/${req.id}/attach`, {
        method: "POST",
        body: form,
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Upload failed");
      }
      const { requirement } = await res.json();
      onSave({ attachment_url: requirement.attachment_url, attachment_filename: requirement.attachment_filename });
    } catch (err) {
      console.error("Upload failed:", err);
      alert("File upload failed — check console for details.");
    } finally {
      setUploading(false);
      e.target.value = "";
    }
  };

  const typeBg = req.requirement_type === "overflight" ? "bg-orange-100 text-orange-700" :
    req.requirement_type === "landing" ? "bg-blue-100 text-blue-700" :
    req.requirement_type === "customs" ? "bg-purple-100 text-purple-700" : "bg-gray-100 text-gray-600";

  if (editing) {
    return (
      <div className="bg-blue-50 border border-blue-200 rounded px-3 py-2 space-y-2">
        <div className="grid grid-cols-4 gap-2">
          <div className="col-span-2">
            <label className="text-[10px] text-gray-500">Name</label>
            <input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })}
              className="block w-full text-xs border border-gray-300 rounded px-2 py-1" />
          </div>
          <div>
            <label className="text-[10px] text-gray-500">Type</label>
            <select value={edit.requirement_type} onChange={(e) => setEdit({ ...edit, requirement_type: e.target.value })}
              className="block w-full text-xs border border-gray-300 rounded px-2 py-1">
              <option value="landing">Landing</option>
              <option value="overflight">Overflight</option>
              <option value="customs">Customs</option>
              <option value="handling">Handling</option>
            </select>
          </div>
        </div>
        <div>
          <label className="text-[10px] text-gray-500">Description</label>
          <input value={edit.description} onChange={(e) => setEdit({ ...edit, description: e.target.value })}
            className="block w-full text-xs border border-gray-300 rounded px-2 py-1" />
        </div>
        <div>
          <label className="text-[10px] text-gray-500">Required Documents (comma-separated)</label>
          <input value={edit.required_documents} onChange={(e) => setEdit({ ...edit, required_documents: e.target.value })}
            className="block w-full text-xs border border-gray-300 rounded px-2 py-1" placeholder="airworthiness_certificate, insurance_certificate" />
        </div>
        <div className="flex gap-2">
          <button onClick={() => onSave({
            name: edit.name, description: edit.description || null, requirement_type: edit.requirement_type,
            required_documents: edit.required_documents.split(",").map((d) => d.trim()).filter(Boolean),
          })} className="px-2 py-1 text-xs bg-blue-600 text-white rounded hover:bg-blue-700">Save</button>
          <button onClick={onEdit} className="px-2 py-1 text-xs text-gray-500">Cancel</button>
          <button onClick={onDelete} className="px-2 py-1 text-xs text-red-500 hover:text-red-700 ml-auto">Delete</button>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-white border border-gray-200 rounded px-3 py-2 group hover:border-gray-300">
      <div className="flex items-center gap-2">
        <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${typeBg}`}>{req.requirement_type}</span>
        <span className="text-sm font-medium">{req.name}</span>
        <button onClick={onEdit} className="ml-auto opacity-0 group-hover:opacity-100 text-xs text-blue-600 hover:text-blue-800 transition-opacity">Edit</button>
        <button onClick={onDelete} className="opacity-0 group-hover:opacity-100 text-xs text-red-400 hover:text-red-600 transition-opacity">Delete</button>
      </div>
      {req.description && <p className="text-xs text-gray-500 mt-1">{req.description}</p>}
      {req.required_documents.length > 0 && (
        <div className="flex gap-1 mt-1">
          <span className="text-[10px] text-gray-400">Docs:</span>
          {req.required_documents.map((d) => (
            <span key={d} className="text-[10px] bg-gray-100 text-gray-600 px-1 rounded">{d.replace(/_/g, " ")}</span>
          ))}
        </div>
      )}
      <div className="flex items-center gap-2 mt-1">
        {req.attachment_url ? (
          <a href={req.attachment_url} target="_blank" rel="noopener noreferrer"
            className="text-[11px] text-blue-600 hover:text-blue-800 flex items-center gap-1">
            <span>📎</span> {req.attachment_filename || "Attachment"}
          </a>
        ) : null}
        <label className={`opacity-0 group-hover:opacity-100 text-[10px] text-gray-400 hover:text-blue-600 cursor-pointer transition-opacity ${uploading ? "opacity-100" : ""}`}>
          {uploading ? "Uploading..." : req.attachment_url ? "Replace" : "📎 Attach file"}
          <input type="file" className="hidden" onChange={handleAttachFile} disabled={uploading} />
        </label>
      </div>
    </div>
  );
}

// ===========================================================================
// DOCUMENT LIBRARY
// ===========================================================================
function DocumentLibrary() {
  const [documents, setDocuments] = useState<IntlDocument[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<string>("all");
  const [showAdd, setShowAdd] = useState(false);
  const [newDoc, setNewDoc] = useState({
    name: "", document_type: "airworthiness", entity_type: "aircraft", entity_id: "", filename: "", expiration_date: "",
  });
  const [uploading, setUploading] = useState(false);
  const [fileToUpload, setFileToUpload] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewName, setPreviewName] = useState<string>("");

  const loadDocs = useCallback(async () => {
    const params = filter !== "all" ? `?entity_type=${filter}` : "";
    const res = await fetch(`/api/ops/intl/documents${params}`);
    const data = await res.json();
    setDocuments(data.documents ?? []);
    setLoading(false);
  }, [filter]);

  useEffect(() => { loadDocs(); }, [loadDocs]);

  async function uploadDocument() {
    if (!newDoc.name || !newDoc.entity_id || !fileToUpload) return;
    setUploading(true);
    try {
      const res = await fetch("/api/ops/intl/documents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...newDoc,
          filename: fileToUpload.name,
          content_type: fileToUpload.type || "application/pdf",
          expiration_date: newDoc.expiration_date || null,
        }),
      });
      const data = await res.json();
      if (data.upload_url) {
        await fetch(data.upload_url, {
          method: "PUT",
          headers: { "Content-Type": fileToUpload.type || "application/pdf" },
          body: fileToUpload,
        });
      }
      setShowAdd(false);
      setNewDoc({ name: "", document_type: "airworthiness", entity_type: "aircraft", entity_id: "", filename: "", expiration_date: "" });
      setFileToUpload(null);
      loadDocs();
    } catch { /* ignore */ }
    setUploading(false);
  }

  async function downloadDoc(docId: string) {
    const res = await fetch(`/api/ops/intl/documents/${docId}`);
    const data = await res.json();
    if (data.download_url) window.open(data.download_url, "_blank");
  }

  async function viewDoc(docId: string, name: string) {
    const res = await fetch(`/api/ops/intl/documents/${docId}`);
    const data = await res.json();
    if (data.download_url) {
      setPreviewUrl(data.download_url);
      setPreviewName(name);
    }
  }

  const docTypes = ["airworthiness", "medical", "certificate", "passport", "insurance", "other"];

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex gap-2 items-center">
          <h3 className="text-sm font-semibold text-gray-700">Document Library</h3>
          <select
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="text-xs border border-gray-300 rounded px-2 py-1"
          >
            <option value="all">All Types</option>
            <option value="aircraft">Aircraft</option>
            <option value="company">Company</option>
          </select>
        </div>
        <button onClick={() => setShowAdd(!showAdd)} className="text-xs text-blue-600 hover:text-blue-800">+ Upload Document</button>
      </div>

      {showAdd && (
        <div className="p-3 bg-white border border-gray-200 rounded space-y-2">
          <div className="grid grid-cols-3 gap-2">
            <div>
              <label className="text-[10px] text-gray-500">Document Name</label>
              <input value={newDoc.name} onChange={(e) => setNewDoc({ ...newDoc, name: e.target.value })}
                className="block w-full text-xs border border-gray-300 rounded px-2 py-1" placeholder="e.g. N520FX Airworthiness Certificate" />
            </div>
            <div>
              <label className="text-[10px] text-gray-500">Type</label>
              <select value={newDoc.document_type} onChange={(e) => setNewDoc({ ...newDoc, document_type: e.target.value })}
                className="block w-full text-xs border border-gray-300 rounded px-2 py-1">
                {docTypes.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
            <div>
              <label className="text-[10px] text-gray-500">Entity Type</label>
              <select value={newDoc.entity_type} onChange={(e) => setNewDoc({ ...newDoc, entity_type: e.target.value })}
                className="block w-full text-xs border border-gray-300 rounded px-2 py-1">
                <option value="aircraft">Aircraft</option>
                <option value="crew">Crew</option>
                <option value="company">Company</option>
              </select>
            </div>
          </div>
          <div className="grid grid-cols-3 gap-2">
            <div>
              <label className="text-[10px] text-gray-500">Entity ID (tail# / crew name / &quot;baker_aviation&quot;)</label>
              <input value={newDoc.entity_id} onChange={(e) => setNewDoc({ ...newDoc, entity_id: e.target.value })}
                className="block w-full text-xs border border-gray-300 rounded px-2 py-1" placeholder="N520FX" />
            </div>
            <div>
              <label className="text-[10px] text-gray-500">Expiration Date</label>
              <input type="date" value={newDoc.expiration_date} onChange={(e) => setNewDoc({ ...newDoc, expiration_date: e.target.value })}
                className="block w-full text-xs border border-gray-300 rounded px-2 py-1" />
            </div>
            <div>
              <label className="text-[10px] text-gray-500">File</label>
              <input type="file" onChange={(e) => setFileToUpload(e.target.files?.[0] ?? null)}
                className="block w-full text-xs border border-gray-300 rounded px-1 py-0.5" accept=".pdf,.doc,.docx,.jpg,.png" />
            </div>
          </div>
          <div className="flex gap-2">
            <button onClick={uploadDocument} disabled={uploading} className="px-3 py-1 text-xs bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50">
              {uploading ? "Uploading..." : "Upload"}
            </button>
            <button onClick={() => setShowAdd(false)} className="px-3 py-1 text-xs text-gray-500 hover:text-gray-700">Cancel</button>
          </div>
        </div>
      )}

      {loading ? (
        <p className="text-xs text-gray-500 animate-pulse">Loading documents...</p>
      ) : documents.length === 0 ? (
        <p className="text-xs text-gray-400">No documents uploaded yet. Upload airworthiness certificates, insurance, passports, etc.</p>
      ) : (
        <div className="border border-gray-200 rounded overflow-hidden">
          <table className="w-full text-xs">
            <thead className="bg-gray-50">
              <tr>
                <th className="text-left px-3 py-1.5 font-medium text-gray-600">Name</th>
                <th className="text-left px-3 py-1.5 font-medium text-gray-600">Type</th>
                <th className="text-left px-3 py-1.5 font-medium text-gray-600">Entity</th>
                <th className="text-left px-3 py-1.5 font-medium text-gray-600">Expires</th>
                <th className="text-left px-3 py-1.5 font-medium text-gray-600">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {documents.map((d) => {
                const isExpiring = d.expiration_date && new Date(d.expiration_date) < new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
                const isExpired = d.expiration_date && new Date(d.expiration_date) < new Date();
                return (
                  <tr key={d.id} className="hover:bg-gray-50">
                    <td className="px-3 py-1.5 font-medium">{d.name}</td>
                    <td className="px-3 py-1.5">
                      <span className="bg-gray-100 text-gray-600 px-1.5 py-0.5 rounded text-[10px]">{d.document_type}</span>
                    </td>
                    <td className="px-3 py-1.5 text-gray-500">{d.entity_type}: {d.entity_id}</td>
                    <td className="px-3 py-1.5">
                      {d.expiration_date ? (
                        <span className={isExpired ? "text-red-600 font-medium" : isExpiring ? "text-yellow-600" : "text-gray-500"}>
                          {new Date(d.expiration_date + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                          {isExpired && " (EXPIRED)"}
                        </span>
                      ) : (
                        <span className="text-gray-300">—</span>
                      )}
                    </td>
                    <td className="px-3 py-1.5 space-x-2">
                      <button onClick={() => viewDoc(d.id, d.name)} className="text-blue-600 hover:text-blue-800">View</button>
                      <button onClick={() => downloadDoc(d.id)} className="text-gray-400 hover:text-gray-600">Download</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* PDF Preview Modal */}
      {previewUrl && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => setPreviewUrl(null)}>
          <div className="bg-white rounded-lg shadow-2xl w-[90vw] max-w-4xl h-[85vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-4 py-2 border-b border-gray-200">
              <h3 className="text-sm font-semibold text-gray-700 truncate">{previewName}</h3>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => window.open(previewUrl, "_blank")}
                  className="text-xs text-blue-600 hover:text-blue-800"
                >
                  Open in new tab
                </button>
                <button
                  onClick={() => setPreviewUrl(null)}
                  className="text-gray-400 hover:text-gray-600 text-lg leading-none"
                >
                  ✕
                </button>
              </div>
            </div>
            <div className="flex-1 min-h-0">
              <iframe
                src={previewUrl}
                className="w-full h-full border-0"
                title={previewName}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ===========================================================================
// US CUSTOMS TRACKER
// ===========================================================================
function CustomsTracker() {
  const [airports, setAirports] = useState<UsCustomsAirport[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [newAirport, setNewAirport] = useState({
    icao: "", airport_name: "", customs_type: "AOE",
    hours_open: "", hours_close: "", timezone: "America/New_York",
    advance_notice_hours: "", overtime_available: false,
    restrictions: "", notes: "", difficulty: "",
  });

  const loadAirports = useCallback(async () => {
    const res = await fetch("/api/ops/intl/customs");
    const data = await res.json();
    setAirports(data.airports ?? []);
    setLoading(false);
  }, []);

  useEffect(() => { loadAirports(); }, [loadAirports]);

  async function addAirport() {
    if (!newAirport.icao || !newAirport.airport_name) return;
    await fetch("/api/ops/intl/customs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...newAirport,
        hours_open: newAirport.hours_open || null,
        hours_close: newAirport.hours_close || null,
        advance_notice_hours: newAirport.advance_notice_hours ? parseInt(newAirport.advance_notice_hours) : null,
        difficulty: newAirport.difficulty || null,
      }),
    });
    setShowAdd(false);
    setNewAirport({
      icao: "", airport_name: "", customs_type: "AOE",
      hours_open: "", hours_close: "", timezone: "America/New_York",
      advance_notice_hours: "", overtime_available: false,
      restrictions: "", notes: "", difficulty: "",
    });
    loadAirports();
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-gray-700">US Customs Airports</h3>
        <button onClick={() => setShowAdd(!showAdd)} className="text-xs text-blue-600 hover:text-blue-800">+ Add Airport</button>
      </div>

      {showAdd && (
        <div className="p-3 bg-white border border-gray-200 rounded space-y-2">
          <div className="grid grid-cols-4 gap-2">
            <div>
              <label className="text-[10px] text-gray-500">ICAO</label>
              <input value={newAirport.icao} onChange={(e) => setNewAirport({ ...newAirport, icao: e.target.value.toUpperCase() })}
                className="block w-full text-xs border border-gray-300 rounded px-2 py-1" placeholder="KOPF" />
            </div>
            <div>
              <label className="text-[10px] text-gray-500">Airport Name</label>
              <input value={newAirport.airport_name} onChange={(e) => setNewAirport({ ...newAirport, airport_name: e.target.value })}
                className="block w-full text-xs border border-gray-300 rounded px-2 py-1" placeholder="Opa-Locka Executive" />
            </div>
            <div>
              <label className="text-[10px] text-gray-500">Customs Type</label>
              <select value={newAirport.customs_type} onChange={(e) => setNewAirport({ ...newAirport, customs_type: e.target.value })}
                className="block w-full text-xs border border-gray-300 rounded px-2 py-1">
                <option value="AOE">AOE (Airport of Entry)</option>
                <option value="LRA">LRA (Landing Rights)</option>
                <option value="UserFee">User Fee</option>
                <option value="None">None</option>
              </select>
            </div>
            <div>
              <label className="text-[10px] text-gray-500">Difficulty</label>
              <select value={newAirport.difficulty} onChange={(e) => setNewAirport({ ...newAirport, difficulty: e.target.value })}
                className="block w-full text-xs border border-gray-300 rounded px-2 py-1">
                <option value="">Not rated</option>
                <option value="easy">Easy</option>
                <option value="moderate">Moderate</option>
                <option value="hard">Hard</option>
              </select>
            </div>
          </div>
          <div className="grid grid-cols-4 gap-2">
            <div>
              <label className="text-[10px] text-gray-500">Opens</label>
              <input type="time" value={newAirport.hours_open} onChange={(e) => setNewAirport({ ...newAirport, hours_open: e.target.value })}
                className="block w-full text-xs border border-gray-300 rounded px-2 py-1" />
            </div>
            <div>
              <label className="text-[10px] text-gray-500">Closes</label>
              <input type="time" value={newAirport.hours_close} onChange={(e) => setNewAirport({ ...newAirport, hours_close: e.target.value })}
                className="block w-full text-xs border border-gray-300 rounded px-2 py-1" />
            </div>
            <div>
              <label className="text-[10px] text-gray-500">Advance Notice (hrs)</label>
              <input type="number" value={newAirport.advance_notice_hours} onChange={(e) => setNewAirport({ ...newAirport, advance_notice_hours: e.target.value })}
                className="block w-full text-xs border border-gray-300 rounded px-2 py-1" />
            </div>
            <div className="flex items-end gap-2">
              <label className="flex items-center gap-1 text-xs cursor-pointer pb-1">
                <input type="checkbox" checked={newAirport.overtime_available}
                  onChange={(e) => setNewAirport({ ...newAirport, overtime_available: e.target.checked })}
                  className="rounded border-gray-300" />
                Overtime Available
              </label>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-[10px] text-gray-500">Restrictions</label>
              <input value={newAirport.restrictions} onChange={(e) => setNewAirport({ ...newAirport, restrictions: e.target.value })}
                className="block w-full text-xs border border-gray-300 rounded px-2 py-1" placeholder="e.g. No GA customs after 2200L" />
            </div>
            <div>
              <label className="text-[10px] text-gray-500">Notes</label>
              <input value={newAirport.notes} onChange={(e) => setNewAirport({ ...newAirport, notes: e.target.value })}
                className="block w-full text-xs border border-gray-300 rounded px-2 py-1" />
            </div>
          </div>
          <div className="flex gap-2">
            <button onClick={addAirport} className="px-3 py-1 text-xs bg-blue-600 text-white rounded hover:bg-blue-700">Save</button>
            <button onClick={() => setShowAdd(false)} className="px-3 py-1 text-xs text-gray-500 hover:text-gray-700">Cancel</button>
          </div>
        </div>
      )}

      {loading ? (
        <p className="text-xs text-gray-500 animate-pulse">Loading customs data...</p>
      ) : airports.length === 0 ? (
        <p className="text-xs text-gray-400">No customs airports added yet.</p>
      ) : (
        <div className="border border-gray-200 rounded overflow-hidden">
          <table className="w-full text-xs">
            <thead className="bg-gray-50">
              <tr>
                <th className="text-left px-3 py-1.5 font-medium text-gray-600 w-6"></th>
                <th className="text-left px-3 py-1.5 font-medium text-gray-600">ICAO</th>
                <th className="text-left px-3 py-1.5 font-medium text-gray-600">Airport</th>
                <th className="text-left px-3 py-1.5 font-medium text-gray-600">Type</th>
                <th className="text-left px-3 py-1.5 font-medium text-gray-600">Hours</th>
                <th className="text-left px-3 py-1.5 font-medium text-gray-600">Notice</th>
                <th className="text-left px-3 py-1.5 font-medium text-gray-600">OT</th>
                <th className="text-left px-3 py-1.5 font-medium text-gray-600">Difficulty</th>
                <th className="text-left px-3 py-1.5 font-medium text-gray-600">Notes</th>
                <th className="text-center px-3 py-1.5 font-medium text-gray-600">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {airports.map((a) => (
                <CustomsRow key={a.id} airport={a} onUpdate={loadAirports} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** Inline-editable customs airport row */
function CustomsRow({ airport: a, onUpdate }: { airport: UsCustomsAirport; onUpdate: () => void }) {
  const [editing, setEditing] = useState(false);
  const [edit, setEdit] = useState({
    customs_type: a.customs_type,
    hours_open: a.hours_open ?? "",
    hours_close: a.hours_close ?? "",
    advance_notice_hours: a.advance_notice_hours?.toString() ?? "",
    overtime_available: a.overtime_available,
    restrictions: a.restrictions ?? "",
    notes: a.notes ?? "",
    difficulty: a.difficulty ?? "",
  });
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    await fetch(`/api/ops/intl/customs/${a.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        customs_type: edit.customs_type,
        hours_open: edit.hours_open || null,
        hours_close: edit.hours_close || null,
        advance_notice_hours: edit.advance_notice_hours ? parseInt(edit.advance_notice_hours) : null,
        overtime_available: edit.overtime_available,
        restrictions: edit.restrictions || null,
        notes: edit.notes || null,
        difficulty: edit.difficulty || null,
      }),
    });
    setSaving(false);
    setEditing(false);
    onUpdate();
  }

  async function toggleConfirmed() {
    const newVal = !a.baker_confirmed;
    await fetch(`/api/ops/intl/customs/${a.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        baker_confirmed: newVal,
        ...(newVal ? { confirmed_at: new Date().toISOString() } : { confirmed_at: null, confirmed_by: null }),
      }),
    });
    onUpdate();
  }

  if (editing) {
    return (
      <tr className="bg-blue-50">
        <td className="px-3 py-1.5"></td>
        <td className="px-3 py-1.5 font-mono font-medium">{a.icao}</td>
        <td className="px-3 py-1.5">{a.airport_name}</td>
        <td className="px-3 py-1.5">
          <select value={edit.customs_type} onChange={(e) => setEdit({ ...edit, customs_type: e.target.value as UsCustomsAirport["customs_type"] })}
            className="text-xs border border-gray-300 rounded px-1 py-0.5 w-20">
            <option value="AOE">AOE</option><option value="LRA">LRA</option><option value="UserFee">UserFee</option><option value="None">None</option>
          </select>
        </td>
        <td className="px-3 py-1.5">
          <div className="flex gap-0.5">
            <input type="time" value={edit.hours_open} onChange={(e) => setEdit({ ...edit, hours_open: e.target.value })}
              className="text-xs border border-gray-300 rounded px-1 py-0.5 w-20" />
            <input type="time" value={edit.hours_close} onChange={(e) => setEdit({ ...edit, hours_close: e.target.value })}
              className="text-xs border border-gray-300 rounded px-1 py-0.5 w-20" />
          </div>
        </td>
        <td className="px-3 py-1.5">
          <input type="number" value={edit.advance_notice_hours} onChange={(e) => setEdit({ ...edit, advance_notice_hours: e.target.value })}
            className="text-xs border border-gray-300 rounded px-1 py-0.5 w-12" placeholder="hrs" />
        </td>
        <td className="px-3 py-1.5">
          <input type="checkbox" checked={edit.overtime_available} onChange={(e) => setEdit({ ...edit, overtime_available: e.target.checked })}
            className="rounded border-gray-300" />
        </td>
        <td className="px-3 py-1.5">
          <select value={edit.difficulty} onChange={(e) => setEdit({ ...edit, difficulty: e.target.value })}
            className="text-xs border border-gray-300 rounded px-1 py-0.5 w-20">
            <option value="">—</option><option value="easy">Easy</option><option value="moderate">Moderate</option><option value="hard">Hard</option>
          </select>
        </td>
        <td className="px-3 py-1.5">
          <input value={edit.notes} onChange={(e) => setEdit({ ...edit, notes: e.target.value })}
            className="text-xs border border-gray-300 rounded px-1 py-0.5 w-full" />
        </td>
        <td className="px-3 py-1.5 text-center">
          <div className="flex gap-1 justify-center">
            <button onClick={save} disabled={saving} className="text-[10px] bg-blue-600 text-white px-2 py-0.5 rounded hover:bg-blue-700 disabled:opacity-50">
              {saving ? "..." : "Save"}
            </button>
            <button onClick={() => setEditing(false)} className="text-[10px] text-gray-500 px-1">Cancel</button>
          </div>
        </td>
      </tr>
    );
  }

  return (
    <tr className="hover:bg-gray-50 cursor-pointer group" onDoubleClick={() => setEditing(true)}>
      <td className="px-1 py-1.5 text-center">
        <button onClick={() => setEditing(true)} className="opacity-0 group-hover:opacity-100 text-gray-400 hover:text-blue-600 transition-opacity" title="Edit">
          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" /></svg>
        </button>
      </td>
      <td className="px-3 py-1.5 font-mono font-medium">{a.icao}</td>
      <td className="px-3 py-1.5">{a.airport_name}</td>
      <td className="px-3 py-1.5">
        <span className="bg-gray-100 text-gray-600 px-1.5 py-0.5 rounded text-[10px]">{a.customs_type}</span>
      </td>
      <td className="px-3 py-1.5 text-gray-500">
        {a.hours_open && a.hours_close ? `${a.hours_open}–${a.hours_close}` : "—"}
      </td>
      <td className="px-3 py-1.5 text-gray-500">
        {a.advance_notice_hours ? `${a.advance_notice_hours}h` : "—"}
      </td>
      <td className="px-3 py-1.5">
        {a.overtime_available ? <span className="text-green-600">Yes</span> : <span className="text-gray-300">No</span>}
      </td>
      <td className="px-3 py-1.5">
        {a.difficulty ? (
          <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${difficultyColor(a.difficulty)}`}>{a.difficulty}</span>
        ) : "—"}
      </td>
      <td className="px-3 py-1.5 text-gray-500 max-w-xs truncate" title={[a.restrictions, a.notes].filter(Boolean).join(" | ")}>
        {a.restrictions || a.notes || "—"}
      </td>
      <td className="px-3 py-1.5 text-center">
        <button onClick={toggleConfirmed} title={a.baker_confirmed ? `Confirmed${a.confirmed_at ? ` on ${new Date(a.confirmed_at).toLocaleDateString()}` : ""}` : "Click to confirm"}>
          {a.baker_confirmed ? (
            <span className="inline-flex items-center gap-0.5 text-[10px] bg-green-100 text-green-700 px-1.5 py-0.5 rounded-full font-medium">
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" /></svg>
              Confirmed
            </span>
          ) : (
            <span className="inline-flex items-center gap-0.5 text-[10px] bg-gray-100 text-gray-400 px-1.5 py-0.5 rounded-full hover:bg-yellow-100 hover:text-yellow-600 transition-colors">
              Unverified
            </span>
          )}
        </button>
      </td>
    </tr>
  );
}

// ===========================================================================
// ALERTS PANEL
// ===========================================================================
function AlertsPanel({ alerts, onRefresh }: { alerts: IntlLegAlert[]; onRefresh: () => void }) {
  async function acknowledgeAlert(alertId: string) {
    await fetch(`/api/ops/intl/alerts/${alertId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ acknowledged: true }),
    });
    onRefresh();
  }

  if (alerts.length === 0) {
    return <p className="text-xs text-gray-400">No international alerts.</p>;
  }

  return (
    <div className="space-y-2">
      <h3 className="text-sm font-semibold text-gray-700">International Alerts</h3>
      {alerts.map((a) => (
        <div
          key={a.id}
          className={`flex items-start gap-3 px-3 py-2 rounded border ${
            a.acknowledged
              ? "bg-gray-50 border-gray-200 opacity-60"
              : a.severity === "critical"
              ? "bg-red-50 border-red-200"
              : a.severity === "warning"
              ? "bg-yellow-50 border-yellow-200"
              : "bg-blue-50 border-blue-200"
          }`}
        >
          <div className="flex-1">
            <div className="flex items-center gap-2">
              <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${
                a.severity === "critical" ? "bg-red-100 text-red-700" :
                a.severity === "warning" ? "bg-yellow-100 text-yellow-700" :
                "bg-blue-100 text-blue-700"
              }`}>{a.severity}</span>
              <span className="text-[10px] bg-gray-100 text-gray-600 px-1.5 py-0.5 rounded">{a.alert_type.replace(/_/g, " ")}</span>
              <span className="text-[10px] text-gray-400">{new Date(a.created_at).toLocaleString()}</span>
            </div>
            <p className="text-xs text-gray-700 mt-1">{a.message}</p>
          </div>
          {!a.acknowledged && (
            <button
              onClick={() => acknowledgeAlert(a.id)}
              className="text-xs text-gray-500 hover:text-gray-700 px-2 py-1 border border-gray-300 rounded"
            >
              Ack
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
