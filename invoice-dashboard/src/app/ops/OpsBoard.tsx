"use client";

import { useState, useMemo } from "react";
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
    }) + " UTC"
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
  return d.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric", timeZone: "UTC" });
}

function severityClasses(severity: string) {
  if (severity === "critical") return "bg-red-100 text-red-800 border border-red-200";
  if (severity === "warning")  return "bg-amber-100 text-amber-800 border border-amber-200";
  return "bg-blue-100 text-blue-700 border border-blue-200";
}

const ALERT_TYPE_LABELS: Record<string, string> = {
  EDCT: "EDCT",
  NOTAM_RUNWAY: "RWY",
  NOTAM_TAXIWAY: "TWY",
  NOTAM_TFR: "TFR",
  NOTAM_AERODROME: "AD",
  NOTAM_OTHER: "NOTAM",
};

// ─── NOTAM helpers ────────────────────────────────────────────────────────────

function icaoToIso(t: string): string {
  // YYMMDDHHMM → YYYY-MM-DD HH:MMZ
  const yr = "20" + t.slice(0, 2);
  const mo = t.slice(2, 4);
  const dy = t.slice(4, 6);
  const hr = t.slice(6, 8);
  const mn = t.slice(8, 10);
  return `${yr}-${mo}-${dy} ${hr}:${mn}Z`;
}

// Extracts effective FROM / TO from NOTAM body text.
// Handles ICAO B)/C) field format and domestic YYMMDDHHMM-YYMMDDHHMM format.
function parseNotamTimes(body: string | null): { from: string | null; to: string | null } {
  if (!body) return { from: null, to: null };

  // ICAO format: B) YYMMDDHHMM C) YYMMDDHHMM
  const fromM = body.match(/\bB\)\s*(\d{10})\b/);
  const toM   = body.match(/\bC\)\s*(\d{10}|PERM)\b/);
  if (fromM) {
    return {
      from: icaoToIso(fromM[1]),
      to:   toM ? (toM[1] === "PERM" ? "PERM" : icaoToIso(toM[1])) : null,
    };
  }

  // Domestic format: YYMMDDHHMM-YYMMDDHHMM at end of text
  const domM = body.match(/\b(\d{10})-(\d{10})\b/);
  if (domM) {
    return { from: icaoToIso(domM[1]), to: icaoToIso(domM[2]) };
  }

  return { from: null, to: null };
}

// Extract structured fields from the FAA NMS raw_data GeoJSON feature.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseNotamRawData(rawData: Record<string, any> | null): {
  effectiveStart: string | null;
  effectiveEnd: string | null;
  issued: string | null;
  status: string | null;
  startDateUtc: string | null;
  endDateUtc: string | null;
  issueDateUtc: string | null;
} {
  const empty = { effectiveStart: null, effectiveEnd: null, issued: null, status: null, startDateUtc: null, endDateUtc: null, issueDateUtc: null };
  if (!rawData) return empty;
  try {
    // Handle double-encoded JSON (stored as string inside JSONB)
    const feature = typeof rawData === "string" ? JSON.parse(rawData) : rawData;
    const notam = feature?.properties?.coreNOTAMData?.notam;
    if (!notam) return empty;
    return {
      effectiveStart: notam.effectiveStart ?? null,
      effectiveEnd:   notam.effectiveEnd   ?? null,
      issued:         notam.issued         ?? null,
      status:         notam.status         ?? null,
      // Human-readable UTC strings from FAA (e.g. "03/05/2026 0801")
      startDateUtc:   notam.startDate      ?? null,
      endDateUtc:     notam.endDate        ?? null,
      issueDateUtc:   notam.issueDate      ?? null,
    };
  } catch {
    return empty;
  }
}

function fmtNotamDate(iso: string | null, humanFallback: string | null): string | null {
  if (iso) {
    const d = new Date(iso);
    if (!isNaN(d.getTime())) {
      return d.toLocaleString("en-US", {
        month: "short", day: "numeric", year: "numeric",
        hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC",
      }) + " UTC";
    }
  }
  if (humanFallback) return humanFallback + " UTC";
  return null;
}

// ─── Alert row (expandable) ───────────────────────────────────────────────────

function AlertDetail({ alert }: { alert: OpsAlert }) {
  const [open, setOpen] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [acking, setAcking] = useState(false);

  if (dismissed) return null;

  async function handleAcknowledge(e: React.MouseEvent) {
    e.stopPropagation();
    setAcking(true);
    try {
      await fetch(`/api/ops/alerts/${alert.id}/acknowledge`, { method: "POST" });
      setDismissed(true);
    } catch {
      setAcking(false);
    }
  }
  const isNotam = alert.alert_type.startsWith("NOTAM");
  const notamTimes = isNotam ? parseNotamTimes(alert.body) : null;
  const notamRaw   = isNotam ? parseNotamRawData(alert.raw_data) : null;

  return (
    <div className="border rounded-lg overflow-hidden text-sm">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-start gap-2 px-3 py-2 text-left hover:bg-gray-50 transition-colors"
      >
        <div className="flex items-center gap-2 flex-wrap min-w-0">
          <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${severityClasses(alert.severity)}`}>
            {alert.severity === "critical" ? "⚠ " : ""}{alert.severity}
          </span>
          <span className="inline-flex items-center rounded px-1.5 py-0.5 text-xs font-mono font-medium bg-slate-100 text-slate-700">
            {ALERT_TYPE_LABELS[alert.alert_type] ?? alert.alert_type}
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
          {/* NOTAM active window — shown inline before expanding */}
          {notamTimes?.from && (
            <span className="text-xs text-gray-600 font-mono bg-gray-100 rounded px-1.5 py-0.5">
              {notamTimes.from}
              {notamTimes.to && <> → {notamTimes.to}</>}
            </span>
          )}
          {!alert.edct_time && alert.subject && (
            <span className="text-gray-600 text-xs truncate max-w-xs">{alert.subject}</span>
          )}
        </div>
        <div className="ml-auto flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={handleAcknowledge}
            disabled={acking}
            className="text-xs font-medium text-gray-500 hover:text-green-700 hover:bg-green-50 border border-gray-200 hover:border-green-300 rounded px-2 py-0.5 transition-colors disabled:opacity-50"
          >
            {acking ? "Saving…" : "Mark Reviewed"}
          </button>
          <span className="text-gray-400 text-xs">{open ? "▲" : "▼"}</span>
        </div>
      </button>
      {open && (
        <div className="px-3 pb-3 pt-2 bg-gray-50 border-t text-xs text-gray-700 space-y-2">
          {/* Structured NOTAM date fields */}
          {isNotam && (notamRaw?.issued || notamRaw?.effectiveStart || notamTimes?.from) && (
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-x-4 gap-y-1 bg-white border rounded p-2">
              {(notamRaw?.issued || notamRaw?.issueDateUtc) && (
                <div>
                  <span className="text-gray-400 block">Issue Date</span>
                  <span className="font-mono font-medium">
                    {fmtNotamDate(notamRaw.issued, notamRaw.issueDateUtc)}
                  </span>
                </div>
              )}
              {(notamRaw?.effectiveStart || notamRaw?.startDateUtc || notamTimes?.from) && (
                <div>
                  <span className="text-gray-400 block">Start Date UTC</span>
                  <span className="font-mono font-medium text-amber-700">
                    {fmtNotamDate(notamRaw?.effectiveStart ?? null, notamRaw?.startDateUtc ?? notamTimes?.from ?? null)}
                  </span>
                </div>
              )}
              {(notamRaw?.effectiveEnd || notamRaw?.endDateUtc || notamTimes?.to) && (
                <div>
                  <span className="text-gray-400 block">End Date UTC</span>
                  <span className="font-mono font-medium text-amber-700">
                    {notamTimes?.to === "PERM"
                      ? "PERM"
                      : fmtNotamDate(notamRaw?.effectiveEnd ?? null, notamRaw?.endDateUtc ?? notamTimes?.to ?? null)}
                  </span>
                </div>
              )}
              {notamRaw?.status && (
                <div>
                  <span className="text-gray-400 block">Status</span>
                  <span className={`font-medium ${notamRaw.status === "Active" ? "text-green-700" : "text-gray-600"}`}>
                    {notamRaw.status}
                  </span>
                </div>
              )}
            </div>
          )}

          {alert.subject && <p><span className="font-medium">NOTAM #:</span> {alert.subject}</p>}
          {alert.body && (
            <pre className="whitespace-pre-wrap font-sans text-xs bg-white border rounded p-2 max-h-48 overflow-y-auto">
              {alert.body}
            </pre>
          )}
          <p className="text-gray-400">Received {fmtTime(alert.created_at)}</p>
        </div>
      )}
    </div>
  );
}

// ─── Flight card (inside expanded day) ───────────────────────────────────────

function FlightCard({ flight }: { flight: Flight }) {
  const alerts = flight.alerts ?? [];
  const hasCritical = alerts.some((a) => a.severity === "critical");
  const hasWarning  = alerts.some((a) => a.severity === "warning");

  const borderColor = hasCritical ? "border-red-300" : hasWarning ? "border-amber-300" : "border-gray-200";
  const headerBg    = hasCritical ? "bg-red-50"     : hasWarning ? "bg-amber-50"     : "bg-white";

  return (
    <div className={`rounded-xl border-2 ${borderColor} overflow-hidden shadow-sm`}>
      <div className={`${headerBg} px-4 py-3 flex items-center justify-between gap-3`}>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5 text-lg font-bold font-mono tracking-wide">
            <span>{flight.departure_icao ?? "????"}</span>
            <span className="text-gray-400 text-sm">→</span>
            <span>{flight.arrival_icao ?? "????"}</span>
          </div>
          <div className="text-xs text-gray-600">
            <span className="font-medium">{fmtTime(flight.scheduled_departure)}</span>
            {flight.scheduled_arrival && (
              <span className="text-gray-400">
                {" "}→ {fmtTime(flight.scheduled_arrival)}{" "}
                ({fmtDuration(flight.scheduled_departure, flight.scheduled_arrival)})
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
              {alerts.length} alert{alerts.length !== 1 ? "s" : ""}
            </span>
          ) : (
            <span className="text-xs font-medium text-green-700 bg-green-100 px-2 py-0.5 rounded-full">Clear</span>
          )}
        </div>
      </div>
      {alerts.length > 0 && (
        <div className="px-4 py-3 space-y-2 bg-white">
          {alerts.map((a) => <AlertDetail key={a.id} alert={a} />)}
        </div>
      )}
    </div>
  );
}

// ─── Day row (collapsed = summary, expanded = flight cards) ──────────────────

function DayRow({ dateStr, flights, defaultOpen }: { dateStr: string; flights: Flight[]; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);

  const totalAlerts = flights.reduce((n, f) => n + (f.alerts?.length ?? 0), 0);
  const criticalCount = flights.filter((f) => f.alerts?.some((a) => a.severity === "critical")).length;
  const warningCount  = flights.filter((f) =>
    f.alerts?.some((a) => a.severity === "warning") && !f.alerts?.some((a) => a.severity === "critical")
  ).length;

  const hasCritical = criticalCount > 0;
  const hasWarning  = !hasCritical && warningCount > 0;
  const rowBorder   = hasCritical ? "border-red-300" : hasWarning ? "border-amber-300" : "border-gray-200";
  const rowBg       = hasCritical ? "bg-red-50" : hasWarning ? "bg-amber-50" : "bg-white";

  return (
    <div className={`rounded-xl border-2 ${rowBorder} overflow-hidden shadow-sm`}>
      {/* Collapsed header — always visible */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`w-full ${rowBg} px-5 py-4 flex items-center justify-between gap-4 hover:brightness-95 transition-all`}
      >
        <div className="flex items-center gap-4">
          <div className="text-left">
            <div className="font-bold text-base text-slate-800">{fmtDayLabel(dateStr)}</div>
            <div className="text-xs text-gray-500 mt-0.5">{dateStr}</div>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs bg-slate-100 text-slate-700 rounded-full px-2.5 py-1 font-medium">
              {flights.length} flight{flights.length !== 1 ? "s" : ""}
            </span>
            {criticalCount > 0 && (
              <span className="text-xs bg-red-100 text-red-700 font-semibold px-2.5 py-1 rounded-full">
                ⚠ {criticalCount} critical
              </span>
            )}
            {warningCount > 0 && (
              <span className="text-xs bg-amber-100 text-amber-700 font-semibold px-2.5 py-1 rounded-full">
                {warningCount} warning{warningCount !== 1 ? "s" : ""}
              </span>
            )}
            {totalAlerts === 0 && (
              <span className="text-xs bg-green-100 text-green-700 font-medium px-2.5 py-1 rounded-full">
                All clear
              </span>
            )}
          </div>
        </div>
        <span className="text-gray-400 text-sm shrink-0">{open ? "▲" : "▼"}</span>
      </button>

      {/* Expanded: individual flight cards */}
      {open && (
        <div className="px-4 pb-4 pt-2 space-y-3 bg-white border-t">
          {flights.map((f) => <FlightCard key={f.id} flight={f} />)}
        </div>
      )}
    </div>
  );
}

// ─── Main board ───────────────────────────────────────────────────────────────

// Temporary filter: show only runway + airport closures and EDCTs while FAA API key is pending.
// Remove ALERT_TYPES_SHOWN once the full NOTAM feed is operational.
const ALERT_TYPES_SHOWN = new Set(["NOTAM_RUNWAY", "NOTAM_AERODROME", "EDCT"]);

const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;

/** Alert is within ±5h of the relevant flight time (dep or arr depending on airport). */
function alertIsInWindow(alert: OpsAlert, flight: Flight, nowMs: number): boolean {
  const ap = alert.airport_icao;
  if (!ap) return true;
  if (ap === flight.departure_icao) {
    return Math.abs(new Date(flight.scheduled_departure).getTime() - nowMs) <= FIVE_HOURS_MS;
  }
  if (ap === flight.arrival_icao && flight.scheduled_arrival) {
    return Math.abs(new Date(flight.scheduled_arrival).getTime() - nowMs) <= FIVE_HOURS_MS;
  }
  return true;
}

function filterAlerts(flights: Flight[], nowMs: number): Flight[] {
  return flights.map((f) => ({
    ...f,
    alerts: (f.alerts ?? []).filter(
      (a) => ALERT_TYPES_SHOWN.has(a.alert_type) && alertIsInWindow(a, f, nowMs),
    ),
  }));
}

export default function OpsBoard({ initialFlights }: { initialFlights: Flight[] }) {
  const now = new Date();

  // Apply alert type filter + 5-hour window filter
  const flights = useMemo(() => filterAlerts(initialFlights, now.getTime()), [initialFlights]);

  // Group flights by UTC date
  const byDay = useMemo(() => {
    const map = new Map<string, Flight[]>();
    for (const f of flights) {
      const day = f.scheduled_departure.slice(0, 10); // YYYY-MM-DD
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
  }, [flights]);

  const totalAlerts = flights.reduce((n, f) => n + (f.alerts?.length ?? 0), 0);
  const criticalCount = flights.filter((f) => f.alerts?.some((a) => a.severity === "critical")).length;
  const warningCount  = flights.filter((f) =>
    f.alerts?.some((a) => a.severity === "warning") && !f.alerts?.some((a) => a.severity === "critical")
  ).length;

  return (
    <div className="p-6 space-y-5">
      {/* Temporary filter banner */}
      <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 flex items-center gap-3 text-sm">
        <span className="text-amber-600 font-semibold shrink-0">⚠ Filtered view</span>
        <span className="text-amber-800">
          Showing only <strong>runway closures</strong>, <strong>airport closures</strong>, and <strong>EDCTs</strong>.
          TFR, taxiway, and other NOTAMs are hidden until NOTAM feed is validated.
        </span>
      </div>

      {/* Summary bar */}
      <div className="rounded-xl border bg-white shadow-sm px-5 py-4 flex items-center gap-6 flex-wrap">
        <div>
          <div className="text-xs text-gray-500">Flights — 7 days</div>
          <div className="text-2xl font-bold">{flights.length}</div>
        </div>
        <div className="w-px h-10 bg-gray-200" />
        <div>
          <div className="text-xs text-gray-500">Days with critical alerts</div>
          <div className={`text-2xl font-bold ${criticalCount > 0 ? "text-red-600" : "text-gray-400"}`}>
            {criticalCount}
          </div>
        </div>
        <div className="w-px h-10 bg-gray-200" />
        <div>
          <div className="text-xs text-gray-500">Days with warnings</div>
          <div className={`text-2xl font-bold ${warningCount > 0 ? "text-amber-600" : "text-gray-400"}`}>
            {warningCount}
          </div>
        </div>
        <div className="w-px h-10 bg-gray-200" />
        <div>
          <div className="text-xs text-gray-500">Filtered alerts</div>
          <div className={`text-2xl font-bold ${totalAlerts > 0 ? "text-slate-700" : "text-gray-400"}`}>
            {totalAlerts}
          </div>
        </div>
        <div className="ml-auto text-xs text-gray-400">
          Updated {now.toLocaleTimeString()} · next 7 days
        </div>
      </div>

      {/* 7-day rows */}
      {byDay.length === 0 ? (
        <div className="rounded-xl border bg-white shadow-sm px-6 py-12 text-center text-gray-400">
          No flights scheduled in the next 7 days.
        </div>
      ) : (
        <div className="space-y-3">
          {byDay.map(({ date, flights: dayFlights }, idx) => (
            <DayRow
              key={date}
              dateStr={date}
              flights={dayFlights}
              defaultOpen={idx === 0}
            />
          ))}
        </div>
      )}
    </div>
  );
}
