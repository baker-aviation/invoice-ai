"use client";

import { useState } from "react";
import type { Flight, OpsAlert } from "@/lib/opsApi";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fmtTime(s: string | null | undefined): string {
  if (!s) return "—";
  const d = new Date(s);
  if (isNaN(d.getTime())) return s;
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZoneName: "short",
  });
}

function fmtDuration(dep: string, arr: string | null): string {
  if (!arr) return "";
  const diff = new Date(arr).getTime() - new Date(dep).getTime();
  if (isNaN(diff) || diff < 0) return "";
  const h = Math.floor(diff / 3600000);
  const m = Math.floor((diff % 3600000) / 60000);
  return `${h}h ${m}m`;
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function SeverityBadge({ severity }: { severity: string }) {
  const classes =
    severity === "critical"
      ? "bg-red-100 text-red-800 border border-red-200"
      : severity === "warning"
      ? "bg-amber-100 text-amber-800 border border-amber-200"
      : "bg-blue-100 text-blue-700 border border-blue-200";
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${classes}`}>
      {severity === "critical" ? "⚠ " : ""}
      {severity}
    </span>
  );
}

function AlertTypeBadge({ type }: { type: string }) {
  const label: Record<string, string> = {
    EDCT: "EDCT",
    NOTAM_RUNWAY: "RWY NOTAM",
    NOTAM_TAXIWAY: "TWY NOTAM",
    NOTAM_TFR: "TFR",
    NOTAM_AERODROME: "AD NOTAM",
    NOTAM_OTHER: "NOTAM",
  };
  return (
    <span className="inline-flex items-center rounded px-1.5 py-0.5 text-xs font-mono font-medium bg-slate-100 text-slate-700">
      {label[type] ?? type}
    </span>
  );
}

function AlertRow({ alert }: { alert: OpsAlert }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="border rounded-lg overflow-hidden text-sm">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-start gap-3 px-4 py-3 text-left hover:bg-gray-50 transition-colors"
      >
        <div className="flex items-center gap-2 flex-wrap min-w-0">
          <SeverityBadge severity={alert.severity} />
          <AlertTypeBadge type={alert.alert_type} />
          {alert.airport_icao && (
            <span className="font-mono font-semibold text-gray-800">{alert.airport_icao}</span>
          )}
          {alert.edct_time && (
            <span className="text-gray-700">
              EDCT <span className="font-semibold">{alert.edct_time}</span>
              {alert.original_departure_time && (
                <span className="text-gray-500 font-normal"> (was {alert.original_departure_time})</span>
              )}
            </span>
          )}
          {!alert.edct_time && alert.subject && (
            <span className="text-gray-700 truncate max-w-xs">{alert.subject}</span>
          )}
        </div>
        <span className="ml-auto text-gray-400 shrink-0">{expanded ? "▲" : "▼"}</span>
      </button>

      {expanded && (
        <div className="px-4 pb-4 pt-1 bg-gray-50 border-t text-xs text-gray-700 space-y-1">
          {alert.subject && <p><span className="font-medium">Subject:</span> {alert.subject}</p>}
          {alert.body && (
            <pre className="whitespace-pre-wrap font-sans text-xs bg-white border rounded p-3 max-h-48 overflow-y-auto">
              {alert.body}
            </pre>
          )}
          <p className="text-gray-400">Received {fmtTime(alert.created_at)}</p>
        </div>
      )}
    </div>
  );
}

function FlightCard({ flight }: { flight: Flight }) {
  const alerts = flight.alerts ?? [];
  const hasCritical = alerts.some((a) => a.severity === "critical");
  const hasWarning = alerts.some((a) => a.severity === "warning");

  const borderColor = hasCritical
    ? "border-red-300"
    : hasWarning
    ? "border-amber-300"
    : "border-gray-200";

  const headerBg = hasCritical
    ? "bg-red-50"
    : hasWarning
    ? "bg-amber-50"
    : "bg-white";

  return (
    <div className={`rounded-xl border-2 ${borderColor} overflow-hidden shadow-sm`}>
      {/* Flight header */}
      <div className={`${headerBg} px-5 py-4 flex items-center justify-between gap-4`}>
        <div className="flex items-center gap-4">
          {/* Route */}
          <div className="flex items-center gap-2 text-xl font-bold font-mono tracking-wide">
            <span>{flight.departure_icao ?? "????"}</span>
            <span className="text-gray-400 text-base">→</span>
            <span>{flight.arrival_icao ?? "????"}</span>
          </div>

          {/* Meta */}
          <div className="text-sm text-gray-600 space-y-0.5">
            <div className="font-medium">{fmtTime(flight.scheduled_departure)}</div>
            {flight.scheduled_arrival && (
              <div className="text-gray-400 text-xs">
                → {fmtTime(flight.scheduled_arrival)}
                {" "}
                <span className="text-gray-400">({fmtDuration(flight.scheduled_departure, flight.scheduled_arrival)})</span>
              </div>
            )}
          </div>
        </div>

        <div className="flex items-center gap-3 shrink-0">
          {flight.tail_number && (
            <span className="font-mono text-sm font-semibold text-gray-700 bg-gray-100 rounded px-2 py-1">
              {flight.tail_number}
            </span>
          )}
          {alerts.length > 0 ? (
            <span className={`text-xs font-semibold px-2.5 py-1 rounded-full ${
              hasCritical
                ? "bg-red-100 text-red-700"
                : "bg-amber-100 text-amber-700"
            }`}>
              {alerts.length} alert{alerts.length !== 1 ? "s" : ""}
            </span>
          ) : (
            <span className="text-xs font-medium text-green-700 bg-green-100 px-2.5 py-1 rounded-full">
              Clear
            </span>
          )}
        </div>
      </div>

      {/* Alerts */}
      {alerts.length > 0 && (
        <div className="px-5 py-3 space-y-2 bg-white">
          {alerts.map((a) => (
            <AlertRow key={a.id} alert={a} />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Main board ───────────────────────────────────────────────────────────────

export default function OpsBoard({ initialFlights }: { initialFlights: Flight[] }) {
  const now = new Date();
  const criticalCount = initialFlights.filter((f) =>
    f.alerts?.some((a) => a.severity === "critical")
  ).length;
  const warningCount = initialFlights.filter((f) =>
    f.alerts?.some((a) => a.severity === "warning") && !f.alerts?.some((a) => a.severity === "critical")
  ).length;

  return (
    <div className="p-6 space-y-5">
      {/* Summary bar */}
      <div className="rounded-xl border bg-white shadow-sm px-5 py-4 flex items-center gap-6 flex-wrap">
        <div>
          <div className="text-xs text-gray-500">Flights next 48h</div>
          <div className="text-2xl font-bold">{initialFlights.length}</div>
        </div>
        <div className="w-px h-10 bg-gray-200" />
        <div>
          <div className="text-xs text-gray-500">Critical alerts</div>
          <div className={`text-2xl font-bold ${criticalCount > 0 ? "text-red-600" : "text-gray-400"}`}>
            {criticalCount}
          </div>
        </div>
        <div className="w-px h-10 bg-gray-200" />
        <div>
          <div className="text-xs text-gray-500">Warnings</div>
          <div className={`text-2xl font-bold ${warningCount > 0 ? "text-amber-600" : "text-gray-400"}`}>
            {warningCount}
          </div>
        </div>
        <div className="ml-auto text-xs text-gray-400">
          Updated {now.toLocaleTimeString()}
        </div>
      </div>

      {/* Flight cards */}
      {initialFlights.length === 0 ? (
        <div className="rounded-xl border bg-white shadow-sm px-6 py-12 text-center text-gray-400">
          No flights scheduled in the next 48 hours.
        </div>
      ) : (
        <div className="space-y-3">
          {initialFlights.map((f) => (
            <FlightCard key={f.id} flight={f} />
          ))}
        </div>
      )}
    </div>
  );
}
