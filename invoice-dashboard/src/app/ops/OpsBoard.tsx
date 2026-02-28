"use client";

import { useState, useMemo, useCallback } from "react";
import type { Flight, OpsAlert } from "@/lib/opsApi";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fmtTime(s: string | null | undefined): string {
  if (!s) return "—";
  const d = new Date(s);
  if (isNaN(d.getTime())) return s;
  return (
    d.toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZone: "UTC",
    }) + "Z"
  );
}

function fmtDuration(dep: string, arr: string | null): string {
  if (!arr) return "";
  const diff = new Date(arr).getTime() - new Date(dep).getTime();
  if (isNaN(diff) || diff < 0) return "";
  const h = Math.floor(diff / 3600000);
  const m = Math.floor((diff % 3600000) / 60000);
  return `${h}h ${m}m`;
}

function fmtDayLabel(dateStr: string): string {
  const d = new Date(dateStr + "T12:00:00Z");
  const today = new Date();
  const todayStr = [
    today.getUTCFullYear(),
    String(today.getUTCMonth() + 1).padStart(2, "0"),
    String(today.getUTCDate()).padStart(2, "0"),
  ].join("-");
  const tomorrow = new Date(today);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  const tomorrowStr = [
    tomorrow.getUTCFullYear(),
    String(tomorrow.getUTCMonth() + 1).padStart(2, "0"),
    String(tomorrow.getUTCDate()).padStart(2, "0"),
  ].join("-");

  if (dateStr === todayStr) return "Today";
  if (dateStr === tomorrowStr) return "Tomorrow";
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
}

function severityClasses(severity: string) {
  if (severity === "critical") return "bg-red-100 text-red-800 border border-red-200";
  if (severity === "warning") return "bg-amber-100 text-amber-800 border border-amber-200";
  return "bg-blue-100 text-blue-700 border border-blue-200";
}

function severityDot(severity: string) {
  if (severity === "critical") return "bg-red-500";
  if (severity === "warning") return "bg-amber-500";
  return "bg-blue-500";
}

const ALERT_TYPE_LABELS: Record<string, string> = {
  EDCT: "EDCT",
  NOTAM_RUNWAY: "RWY",
  NOTAM_TFR: "TFR",
  NOTAM_AERODROME: "AD",
  NOTAM_AD_RESTRICTED: "AD",
  NOTAM_PPR: "PPR",
  NOTAM_OTHER: "NOTAM",
};

// ─── NOTAM helpers ────────────────────────────────────────────────────────────

function icaoToIso(t: string): string {
  const yr = "20" + t.slice(0, 2);
  const mo = t.slice(2, 4);
  const dy = t.slice(4, 6);
  const hr = t.slice(6, 8);
  const mn = t.slice(8, 10);
  return `${yr}-${mo}-${dy} ${hr}:${mn}Z`;
}

function parseNotamTimes(body: string | null): { from: string | null; to: string | null } {
  if (!body) return { from: null, to: null };
  const fromM = body.match(/\bB\)\s*(\d{10})\b/);
  const toM = body.match(/\bC\)\s*(\d{10}|PERM)\b/);
  if (fromM) {
    return {
      from: icaoToIso(fromM[1]),
      to: toM ? (toM[1] === "PERM" ? "PERM" : icaoToIso(toM[1])) : null,
    };
  }
  const domM = body.match(/\b(\d{10})-(\d{10})\b/);
  if (domM) return { from: icaoToIso(domM[1]), to: icaoToIso(domM[2]) };
  return { from: null, to: null };
}

function fmtNotamDate(iso: string | null, humanFallback: string | null): string | null {
  if (iso) {
    const d = new Date(iso);
    if (!isNaN(d.getTime())) {
      return d.toLocaleString("en-US", {
        month: "short", day: "numeric",
        hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC",
      }) + "Z";
    }
  }
  if (humanFallback) return humanFallback + " UTC";
  return null;
}

// ─── Filter categories ───────────────────────────────────────────────────────

type AlertFilter = "ALL" | "ALERTS_ONLY" | "CRITICAL" | "RWY" | "AD" | "TFR" | "PPR" | "EDCT";

const FILTER_OPTIONS: { key: AlertFilter; label: string; description: string }[] = [
  { key: "ALL", label: "All Flights", description: "Every scheduled flight" },
  { key: "ALERTS_ONLY", label: "Alerts Only", description: "Flights with alerts" },
  { key: "CRITICAL", label: "Critical", description: "Critical severity" },
  { key: "RWY", label: "RWY", description: "Runway closures" },
  { key: "AD", label: "AD", description: "Airport/aerodrome" },
  { key: "TFR", label: "TFR", description: "TFRs" },
  { key: "PPR", label: "PPR", description: "Prior permission" },
  { key: "EDCT", label: "EDCT", description: "Ground delays" },
];

// ─── Time horizons ───────────────────────────────────────────────────────────

type TimeRange = "TODAY" | "48H" | "7D" | "30D";

const TIME_RANGES: { key: TimeRange; label: string; hours: number }[] = [
  { key: "TODAY", label: "Today", hours: 24 },
  { key: "48H", label: "48 Hours", hours: 48 },
  { key: "7D", label: "7 Days", hours: 168 },
  { key: "30D", label: "30 Days", hours: 720 },
];

// ─── Alert types we process ──────────────────────────────────────────────────

const ALERT_TYPES_SHOWN = new Set([
  "NOTAM_RUNWAY", "NOTAM_AERODROME", "NOTAM_AD_RESTRICTED",
  "NOTAM_TFR", "NOTAM_PPR", "EDCT",
]);

// ─── Alert inline card ───────────────────────────────────────────────────────

function AlertCard({ alert, onAck }: { alert: OpsAlert; onAck: (id: string) => void }) {
  const [expanded, setExpanded] = useState(false);
  const [acking, setAcking] = useState(false);

  async function handleAck(e: React.MouseEvent) {
    e.stopPropagation();
    setAcking(true);
    try {
      await fetch(`/api/ops/alerts/${alert.id}/acknowledge`, { method: "POST" });
      onAck(alert.id);
    } catch {
      setAcking(false);
    }
  }

  const isNotam = alert.alert_type.startsWith("NOTAM");
  const notamTimes = isNotam ? parseNotamTimes(alert.body) : null;
  const nd = isNotam ? alert.notam_dates : null;

  const typeLabel = ALERT_TYPE_LABELS[alert.alert_type] ?? alert.alert_type;

  return (
    <div
      className={`rounded-lg border text-sm transition-all ${
        alert.severity === "critical"
          ? "border-red-200 bg-red-50/60"
          : "border-amber-200 bg-amber-50/60"
      }`}
    >
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full px-3 py-2 flex items-center gap-2 text-left hover:bg-white/40 transition-colors"
      >
        <span className={`w-2 h-2 rounded-full shrink-0 ${severityDot(alert.severity)}`} />
        <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-xs font-mono font-semibold ${severityClasses(alert.severity)}`}>
          {typeLabel}
        </span>
        {alert.airport_icao && (
          <span className="font-mono font-semibold text-gray-800 text-xs">{alert.airport_icao}</span>
        )}
        {alert.edct_time && (
          <span className="text-gray-700 text-xs">
            EDCT <span className="font-semibold">{alert.edct_time}</span>
            {alert.original_departure_time && (
              <span className="text-gray-500"> (was {alert.original_departure_time})</span>
            )}
          </span>
        )}
        {isNotam && (nd?.issued || nd?.issue_date_utc) && (
          <span className="text-xs text-gray-500 bg-white/80 rounded px-1.5 py-0.5">
            <span className="text-gray-400">Issued </span>
            <span className="font-mono">{fmtNotamDate(nd?.issued ?? null, nd?.issue_date_utc ?? null)}</span>
          </span>
        )}
        {(nd?.effective_start || nd?.start_date_utc || notamTimes?.from) && (
          <span className="text-xs text-gray-600 bg-white/80 rounded px-1.5 py-0.5">
            <span className="text-gray-400">Eff </span>
            <span className="font-mono">{fmtNotamDate(nd?.effective_start ?? null, nd?.start_date_utc ?? notamTimes?.from ?? null)}</span>
            {(nd?.effective_end || nd?.end_date_utc || notamTimes?.to) && (
              <span className="font-mono"> → {notamTimes?.to === "PERM" ? "PERM" : fmtNotamDate(nd?.effective_end ?? null, nd?.end_date_utc ?? notamTimes?.to ?? null)}</span>
            )}
          </span>
        )}
        <div className="ml-auto flex items-center gap-1.5 shrink-0">
          <button
            type="button"
            onClick={handleAck}
            disabled={acking}
            className="text-xs text-gray-500 hover:text-green-700 hover:bg-green-50 border border-gray-200 hover:border-green-300 rounded px-1.5 py-0.5 transition-colors disabled:opacity-50"
          >
            {acking ? "..." : "Dismiss"}
          </button>
          <span className="text-gray-400 text-xs">{expanded ? "▲" : "▼"}</span>
        </div>
      </button>
      {expanded && (
        <div className="px-3 pb-2.5 pt-1 text-xs text-gray-700 space-y-1.5 border-t border-gray-200/60">
          {isNotam && (nd?.issued || nd?.issue_date_utc || nd?.effective_start || notamTimes?.from) && (
            <div className="flex gap-4 flex-wrap bg-white border rounded p-2 text-xs">
              {(nd?.issued || nd?.issue_date_utc) && (
                <div>
                  <span className="text-gray-400">Issued: </span>
                  <span className="font-mono font-medium text-gray-700">
                    {fmtNotamDate(nd?.issued ?? null, nd?.issue_date_utc ?? null)}
                  </span>
                </div>
              )}
              {(nd?.effective_start || nd?.start_date_utc || notamTimes?.from) && (
                <div>
                  <span className="text-gray-400">Effective: </span>
                  <span className="font-mono font-medium text-amber-700">
                    {fmtNotamDate(nd?.effective_start ?? null, nd?.start_date_utc ?? notamTimes?.from ?? null)}
                  </span>
                </div>
              )}
              {(nd?.effective_end || nd?.end_date_utc || notamTimes?.to) && (
                <div>
                  <span className="text-gray-400">Expires: </span>
                  <span className="font-mono font-medium text-amber-700">
                    {notamTimes?.to === "PERM"
                      ? "PERM"
                      : fmtNotamDate(nd?.effective_end ?? null, nd?.end_date_utc ?? notamTimes?.to ?? null)}
                  </span>
                </div>
              )}
              {nd?.status && (
                <div>
                  <span className="text-gray-400">Status: </span>
                  <span className={`font-medium ${nd.status === "Active" ? "text-green-700" : "text-gray-600"}`}>
                    {nd.status}
                  </span>
                </div>
              )}
            </div>
          )}
          {alert.subject && <p><span className="font-medium">NOTAM #:</span> {alert.subject}</p>}
          {alert.body && (
            <pre className="whitespace-pre-wrap font-sans text-xs bg-white border rounded p-2 max-h-36 overflow-y-auto">
              {alert.body}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Flight card ──────────────────────────────────────────────────────────────

function FlightCard({ flight, ackedIds, onAck }: { flight: Flight; ackedIds: Set<string>; onAck: (id: string) => void }) {
  const alerts = (flight.alerts ?? []).filter((a) => !ackedIds.has(a.id));
  const hasCritical = alerts.some((a) => a.severity === "critical");
  const hasWarning = alerts.some((a) => a.severity === "warning");

  const borderColor = hasCritical ? "border-red-300" : hasWarning ? "border-amber-300" : "border-gray-200";

  return (
    <div className={`rounded-xl border ${borderColor} bg-white shadow-sm overflow-hidden`}>
      {/* Header */}
      <div className="px-4 py-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <div className="flex items-center gap-1.5 text-base font-bold font-mono tracking-wide shrink-0">
            <span>{flight.departure_icao ?? "????"}</span>
            <span className="text-gray-400 text-sm">→</span>
            <span>{flight.arrival_icao ?? "????"}</span>
          </div>
          <div className="text-xs text-gray-600 truncate">
            <span className="font-medium">{fmtTime(flight.scheduled_departure)}</span>
            {flight.scheduled_arrival && (
              <span className="text-gray-400">
                {" → "}{fmtTime(flight.scheduled_arrival)}{" "}
                <span className="text-gray-400">({fmtDuration(flight.scheduled_departure, flight.scheduled_arrival)})</span>
              </span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {flight.tail_number && (
            <span className="font-mono text-xs font-semibold text-gray-700 bg-gray-100 rounded px-2 py-1">
              {flight.tail_number}
            </span>
          )}
          {alerts.length > 0 ? (
            <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${
              hasCritical ? "bg-red-100 text-red-700" : "bg-amber-100 text-amber-700"
            }`}>
              {alerts.length}
            </span>
          ) : (
            <span className="text-xs font-medium text-green-700 bg-green-50 px-2 py-0.5 rounded-full">Clear</span>
          )}
        </div>
      </div>
      {/* Alerts */}
      {alerts.length > 0 && (
        <div className="px-3 pb-3 space-y-1.5">
          {alerts.map((a) => <AlertCard key={a.id} alert={a} onAck={onAck} />)}
        </div>
      )}
    </div>
  );
}

// ─── Day section header ──────────────────────────────────────────────────────

function DayHeader({ dateStr, flightCount, criticalCount, warningCount }: {
  dateStr: string; flightCount: number; criticalCount: number; warningCount: number;
}) {
  return (
    <div className="flex items-center gap-3 pt-4 pb-2 px-1 sticky top-0 bg-gray-50/95 backdrop-blur-sm z-10 border-b border-gray-200">
      <h3 className="font-bold text-sm text-slate-800">{fmtDayLabel(dateStr)}</h3>
      <span className="text-xs text-gray-500 font-mono">{dateStr}</span>
      <div className="flex items-center gap-1.5">
        <span className="text-xs bg-slate-100 text-slate-600 rounded-full px-2 py-0.5">
          {flightCount} flight{flightCount !== 1 ? "s" : ""}
        </span>
        {criticalCount > 0 && (
          <span className="text-xs bg-red-100 text-red-700 font-semibold rounded-full px-2 py-0.5">
            {criticalCount} critical
          </span>
        )}
        {warningCount > 0 && (
          <span className="text-xs bg-amber-100 text-amber-700 font-semibold rounded-full px-2 py-0.5">
            {warningCount} warning
          </span>
        )}
      </div>
    </div>
  );
}

// ─── Main board ───────────────────────────────────────────────────────────────

function filterAlerts(flights: Flight[]): Flight[] {
  return flights.map((f) => ({
    ...f,
    alerts: (f.alerts ?? []).filter((a) => ALERT_TYPES_SHOWN.has(a.alert_type)),
  }));
}

export default function OpsBoard({ initialFlights }: { initialFlights: Flight[] }) {
  const now = useMemo(() => new Date(), []);
  const [activeFilter, setActiveFilter] = useState<AlertFilter>("ALL");
  const [activeRange, setActiveRange] = useState<TimeRange>("7D");
  const [ackedIds, setAckedIds] = useState<Set<string>>(new Set());

  const handleAck = useCallback((id: string) => {
    setAckedIds((prev) => new Set(prev).add(id));
  }, []);

  // Apply alert type filtering
  const withFilteredAlerts = useMemo(() => filterAlerts(initialFlights), [initialFlights]);

  // Apply time range
  const cutoff = useMemo(() => {
    const range = TIME_RANGES.find((r) => r.key === activeRange);
    return new Date(now.getTime() + (range?.hours ?? 168) * 3600000);
  }, [activeRange, now]);

  const lookback = useMemo(() => new Date(now.getTime() - 12 * 3600000), [now]);

  const timeFiltered = useMemo(() => {
    return withFilteredAlerts.filter((f) => {
      const dep = new Date(f.scheduled_departure);
      return dep >= lookback && dep <= cutoff;
    });
  }, [withFilteredAlerts, cutoff, lookback]);

  // Apply category filter
  const filtered = useMemo(() => {
    if (activeFilter === "ALL") return timeFiltered;
    if (activeFilter === "ALERTS_ONLY") return timeFiltered.filter((f) => (f.alerts?.length ?? 0) > 0);
    if (activeFilter === "CRITICAL") return timeFiltered.filter((f) => f.alerts?.some((a) => a.severity === "critical"));

    const typeMap: Record<string, string[]> = {
      RWY: ["NOTAM_RUNWAY"],
      AD: ["NOTAM_AERODROME", "NOTAM_AD_RESTRICTED"],
      TFR: ["NOTAM_TFR"],
      PPR: ["NOTAM_PPR"],
      EDCT: ["EDCT"],
    };
    const types = typeMap[activeFilter] ?? [];
    return timeFiltered.filter((f) => f.alerts?.some((a) => types.includes(a.alert_type)));
  }, [timeFiltered, activeFilter]);

  // Group by day
  const byDay = useMemo(() => {
    const map = new Map<string, Flight[]>();
    for (const f of filtered) {
      const day = f.scheduled_departure.slice(0, 10);
      const arr = map.get(day) ?? [];
      arr.push(f);
      map.set(day, arr);
    }
    return Array.from(map.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, dayFlights]) => ({
        date,
        flights: dayFlights.sort((a, b) => a.scheduled_departure.localeCompare(b.scheduled_departure)),
      }));
  }, [filtered]);

  // Stats
  const totalFlights = timeFiltered.length;
  const totalAlerts = timeFiltered.reduce((n, f) => n + (f.alerts?.filter((a) => !ackedIds.has(a.id)).length ?? 0), 0);
  const criticalFlights = timeFiltered.filter((f) => f.alerts?.some((a) => a.severity === "critical" && !ackedIds.has(a.id))).length;
  const warningFlights = timeFiltered.filter((f) =>
    f.alerts?.some((a) => a.severity === "warning" && !ackedIds.has(a.id)) &&
    !f.alerts?.some((a) => a.severity === "critical" && !ackedIds.has(a.id))
  ).length;

  // Alert counts per category (for pill badges)
  const alertCounts = useMemo(() => {
    const counts: Record<string, number> = { ALERTS_ONLY: 0, CRITICAL: 0, RWY: 0, AD: 0, TFR: 0, PPR: 0, EDCT: 0 };
    for (const f of timeFiltered) {
      for (const a of f.alerts ?? []) {
        if (ackedIds.has(a.id)) continue;
        counts.ALERTS_ONLY++;
        if (a.severity === "critical") counts.CRITICAL++;
        if (a.alert_type === "NOTAM_RUNWAY") counts.RWY++;
        if (a.alert_type === "NOTAM_AERODROME" || a.alert_type === "NOTAM_AD_RESTRICTED") counts.AD++;
        if (a.alert_type === "NOTAM_TFR") counts.TFR++;
        if (a.alert_type === "NOTAM_PPR") counts.PPR++;
        if (a.alert_type === "EDCT") counts.EDCT++;
      }
    }
    return counts;
  }, [timeFiltered, ackedIds]);

  return (
    <div className="p-4 sm:p-6 space-y-4 bg-gray-50 min-h-screen">
      {/* Summary bar */}
      <div className="rounded-xl border bg-white shadow-sm px-5 py-4 flex items-center gap-6 flex-wrap">
        <div>
          <div className="text-xs text-gray-500">Flights</div>
          <div className="text-2xl font-bold">{totalFlights}</div>
        </div>
        <div className="w-px h-10 bg-gray-200" />
        <div>
          <div className="text-xs text-gray-500">Active Alerts</div>
          <div className={`text-2xl font-bold ${totalAlerts > 0 ? "text-slate-700" : "text-gray-400"}`}>
            {totalAlerts}
          </div>
        </div>
        <div className="w-px h-10 bg-gray-200" />
        <div>
          <div className="text-xs text-gray-500">Critical</div>
          <div className={`text-2xl font-bold ${criticalFlights > 0 ? "text-red-600" : "text-gray-400"}`}>
            {criticalFlights}
          </div>
        </div>
        <div className="w-px h-10 bg-gray-200" />
        <div>
          <div className="text-xs text-gray-500">Warnings</div>
          <div className={`text-2xl font-bold ${warningFlights > 0 ? "text-amber-600" : "text-gray-400"}`}>
            {warningFlights}
          </div>
        </div>
        <div className="ml-auto text-xs text-gray-400">
          Updated {now.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" })}Z
        </div>
      </div>

      {/* Time range tabs + filter pills */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center gap-3">
        {/* Time range tabs */}
        <div className="flex rounded-lg border border-gray-200 bg-white p-0.5 shadow-sm">
          {TIME_RANGES.map((r) => (
            <button
              key={r.key}
              type="button"
              onClick={() => setActiveRange(r.key)}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                activeRange === r.key
                  ? "bg-slate-800 text-white shadow-sm"
                  : "text-gray-600 hover:text-gray-900 hover:bg-gray-50"
              }`}
            >
              {r.label}
            </button>
          ))}
        </div>

        {/* Filter pills */}
        <div className="flex items-center gap-1.5 flex-wrap">
          {FILTER_OPTIONS.map((opt) => {
            const count = opt.key === "ALL" ? null : alertCounts[opt.key] ?? 0;
            const isActive = activeFilter === opt.key;
            return (
              <button
                key={opt.key}
                type="button"
                onClick={() => setActiveFilter(opt.key)}
                title={opt.description}
                className={`inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded-full border transition-colors ${
                  isActive
                    ? opt.key === "CRITICAL"
                      ? "bg-red-100 text-red-800 border-red-300"
                      : "bg-slate-800 text-white border-slate-800"
                    : "bg-white text-gray-600 border-gray-200 hover:border-gray-400 hover:bg-gray-50"
                }`}
              >
                {opt.label}
                {count !== null && count > 0 && (
                  <span className={`inline-flex items-center justify-center min-w-[16px] h-4 px-1 text-[10px] font-bold rounded-full ${
                    isActive
                      ? opt.key === "CRITICAL" ? "bg-red-200 text-red-900" : "bg-white/30 text-white"
                      : opt.key === "CRITICAL" ? "bg-red-100 text-red-700" : "bg-gray-100 text-gray-600"
                  }`}>
                    {count}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* Flight cards by day */}
      {filtered.length === 0 ? (
        <div className="rounded-xl border bg-white shadow-sm px-6 py-12 text-center text-gray-400">
          {activeFilter !== "ALL"
            ? "No flights match the current filter."
            : `No flights scheduled in the selected time range.`}
        </div>
      ) : (
        <div className="space-y-1">
          {byDay.map(({ date, flights: dayFlights }) => {
            const dayCritical = dayFlights.filter((f) =>
              f.alerts?.some((a) => a.severity === "critical" && !ackedIds.has(a.id))
            ).length;
            const dayWarning = dayFlights.filter((f) =>
              f.alerts?.some((a) => a.severity === "warning" && !ackedIds.has(a.id)) &&
              !f.alerts?.some((a) => a.severity === "critical" && !ackedIds.has(a.id))
            ).length;

            return (
              <div key={date}>
                <DayHeader
                  dateStr={date}
                  flightCount={dayFlights.length}
                  criticalCount={dayCritical}
                  warningCount={dayWarning}
                />
                <div className="grid gap-2 pt-2">
                  {dayFlights.map((f) => (
                    <FlightCard key={f.id} flight={f} ackedIds={ackedIds} onAck={handleAck} />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
