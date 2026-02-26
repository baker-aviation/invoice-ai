"use client";

import { useState } from "react";
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

function severityClasses(severity: string) {
  if (severity === "critical") return "bg-red-100 text-red-800 border border-red-200";
  if (severity === "warning")  return "bg-amber-100 text-amber-800 border border-amber-200";
  return "bg-blue-100 text-blue-700 border border-blue-200";
}

const NOTAM_TYPE_LABELS: Record<string, string> = {
  EDCT: "EDCT",
  NOTAM_RUNWAY: "RWY",
  NOTAM_TAXIWAY: "TWY",
  NOTAM_TFR: "TFR",
  NOTAM_AERODROME: "AD",
  NOTAM_OTHER: "NOTAM",
};

// ─── Sub-components ───────────────────────────────────────────────────────────

function SeverityBadge({ severity }: { severity: string }) {
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${severityClasses(severity)}`}>
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

// ─── NOTAM tab components ─────────────────────────────────────────────────────

function NotamItemRow({ alert }: { alert: OpsAlert }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="border rounded-lg overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-gray-50 text-sm"
      >
        <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${severityClasses(alert.severity)}`}>
          {alert.severity === "critical" ? "⚠ " : ""}{alert.severity}
        </span>
        <span className="inline-flex items-center rounded px-1.5 py-0.5 text-xs font-mono bg-slate-100 text-slate-700">
          {NOTAM_TYPE_LABELS[alert.alert_type] ?? alert.alert_type}
        </span>
        <span className="text-xs text-gray-600 truncate">{alert.subject || "—"}</span>
        <span className="ml-auto text-gray-400 shrink-0 text-xs">{expanded ? "▲" : "▼"}</span>
      </button>
      {expanded && alert.body && (
        <div className="px-3 pb-3 pt-1 bg-gray-50 border-t">
          <pre className="whitespace-pre-wrap font-sans text-xs text-gray-700 bg-white border rounded p-2 max-h-48 overflow-y-auto">
            {alert.body}
          </pre>
          <p className="text-xs text-gray-400 mt-1">Received {fmtTime(alert.created_at)}</p>
        </div>
      )}
    </div>
  );
}

function AirportNotamCard({ airport, alerts }: { airport: string; alerts: OpsAlert[] }) {
  const [open, setOpen] = useState(true);
  const critical = alerts.filter((a) => a.severity === "critical").length;
  const warning  = alerts.filter((a) => a.severity === "warning").length;

  return (
    <div className="border rounded-xl overflow-hidden bg-white shadow-sm">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-4 py-3 hover:bg-gray-50"
      >
        <div className="flex items-center gap-3">
          <span className="font-mono font-bold text-base text-slate-800">{airport}</span>
          <div className="flex gap-1">
            {critical > 0 && (
              <span className="bg-red-100 text-red-700 text-xs font-semibold px-2 py-0.5 rounded-full">
                ⚠ {critical} critical
              </span>
            )}
            {warning > 0 && (
              <span className="bg-amber-100 text-amber-700 text-xs font-semibold px-2 py-0.5 rounded-full">
                {warning} warning{warning !== 1 ? "s" : ""}
              </span>
            )}
          </div>
        </div>
        <span className="text-gray-400 text-sm">{open ? "▲" : "▼"}</span>
      </button>
      {open && (
        <div className="border-t px-4 py-3 space-y-2">
          {alerts.map((a) => <NotamItemRow key={a.id} alert={a} />)}
        </div>
      )}
    </div>
  );
}

function NotamSearch() {
  const [query, setQuery]   = useState("");
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<{ text: string; notamNumber?: string; startDate?: string; endDate?: string }[]>([]);
  const [error, setError]   = useState<string | null>(null);
  const [searched, setSearched] = useState(false);

  async function handleSearch() {
    const icao = query.trim().toUpperCase();
    if (!icao) return;
    setLoading(true);
    setError(null);
    setSearched(true);
    try {
      const res = await fetch(`/api/notams?airports=${icao}`);
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "Lookup failed");
      setResults(data.notams || []);
    } catch (e: unknown) {
      setError(String(e));
      setResults([]);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="border rounded-xl bg-white shadow-sm p-4 space-y-3">
      <div className="flex gap-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value.toUpperCase())}
          onKeyDown={(e) => e.key === "Enter" && handleSearch()}
          placeholder="ICAO (e.g. KTEB, KOPF)"
          maxLength={4}
          className="flex-1 border rounded-lg px-3 py-2 text-sm font-mono uppercase focus:outline-none focus:ring-2 focus:ring-slate-300"
        />
        <button
          onClick={handleSearch}
          disabled={loading || !query.trim()}
          className="px-4 py-2 bg-slate-800 text-white rounded-lg text-sm font-medium disabled:opacity-50 hover:bg-slate-700"
        >
          {loading ? "…" : "Search"}
        </button>
      </div>

      {error && (
        <div className="text-xs text-red-600 bg-red-50 border border-red-100 rounded px-3 py-2">{error}</div>
      )}

      {searched && !loading && !error && results.length === 0 && (
        <div className="text-xs text-gray-400 text-center py-3">No NOTAMs found for {query}.</div>
      )}

      {results.length > 0 && (
        <div className="space-y-2 max-h-80 overflow-y-auto">
          {results.map((n, idx) => (
            <div key={idx} className="border rounded-lg p-3 text-xs space-y-1">
              {n.notamNumber && (
                <div className="flex items-center gap-2">
                  <span className="font-mono font-semibold text-slate-700">{n.notamNumber}</span>
                  {n.startDate && <span className="text-gray-400">{n.startDate}</span>}
                  {n.endDate && <span className="text-gray-400">→ {n.endDate}</span>}
                </div>
              )}
              <pre className="whitespace-pre-wrap font-sans text-gray-700 bg-gray-50 rounded p-2 text-xs">
                {n.text || "No text available"}
              </pre>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function NotamTab({ flights }: { flights: Flight[] }) {
  const notamsByAirport = useMemo(() => {
    const seen = new Set<string>();
    const byAirport: Record<string, OpsAlert[]> = {};
    for (const f of flights) {
      for (const a of f.alerts ?? []) {
        if (!a.alert_type.startsWith("NOTAM")) continue;
        if (seen.has(a.id)) continue;
        seen.add(a.id);
        const key = a.airport_icao || "Unknown";
        (byAirport[key] = byAirport[key] ?? []).push(a);
      }
    }
    return byAirport;
  }, [flights]);

  const entries = Object.entries(notamsByAirport).sort(([, a], [, b]) => {
    const aCrit = a.some((x) => x.severity === "critical") ? 1 : 0;
    const bCrit = b.some((x) => x.severity === "critical") ? 1 : 0;
    return bCrit - aCrit;
  });

  return (
    <div className="space-y-6">
      <div>
        <div className="text-sm font-semibold text-gray-700 mb-1">Active NOTAMs from scheduled flights</div>
        <div className="text-xs text-gray-400 mb-3">
          Populated by ops-monitor every 30 min via FAA NOTAM API · linked to upcoming flight airports
        </div>
        {entries.length > 0 ? (
          <div className="space-y-3">
            {entries.map(([airport, alerts]) => (
              <AirportNotamCard key={airport} airport={airport} alerts={alerts} />
            ))}
          </div>
        ) : (
          <div className="rounded-xl border bg-white px-6 py-8 text-center text-gray-400 text-sm">
            No active NOTAMs in pipeline data.
          </div>
        )}
      </div>

      <div>
        <div className="text-sm font-semibold text-gray-700 mb-1">Live Airport NOTAM Lookup</div>
        <div className="text-xs text-gray-400 mb-3">
          Powered by aviationweather.gov · no authentication required · any ICAO
        </div>
        <NotamSearch />
      </div>
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
          Updated {now.toLocaleTimeString()} UTC
        </div>
      </div>

      {/* Schedule */}
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
