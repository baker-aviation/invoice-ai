"use client";

import { useEffect, useState, useCallback } from "react";
import { getAirportTimezone } from "@/lib/airportTimezones";

// ─── Types ──────────────────────────────────────────────────────────────────

type CrewTravel = {
  name: string;
  role: "PIC" | "SIC";
  direction: "oncoming" | "offgoing";
  aircraft_type: string;
  tail_number: string;
  swap_location: string;
  transport_type: "commercial" | "uber" | "rental" | "brightline" | "staying" | "standby" | "unknown";
  flight_number: string | null;
  flight_numbers: string[]; // split connections: ["UA1232", "UA5369"]
  date: string | null;
  duty_on: string | null;
  arrival_time: string | null;
  price: string | null;
  notes: string | null;
  is_early_volunteer: boolean;
  is_skillbridge: boolean;
  is_checkairman: boolean;
  verified_ticket: boolean;
  home_airports: string[];
  // Live status (populated by flight status API or manual)
  status: "scheduled" | "boarding" | "departed" | "en_route" | "landed" | "arrived_fbo" | "delayed" | "cancelled" | "unknown";
  status_detail: string | null;
  live_departure: string | null;
  live_arrival: string | null;
  delay_minutes: number | null;
};

type SwapStatusData = {
  swap_date: string;
  sheet_name: string;
  oncoming: CrewTravel[];
  offgoing: CrewTravel[];
  fa_flights_resolved?: number;
  fa_flights_total?: number;
  last_updated: string;
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fmtTime24(timeStr: string | null): string {
  if (!timeStr) return "—";
  // Handle "0900L", "0440L", "1247L" format
  const m = timeStr.match(/^(\d{2})(\d{2})L?$/);
  if (m) return `${m[1]}:${m[2]}L`;
  return timeStr;
}

function statusColor(status: CrewTravel["status"]): string {
  switch (status) {
    case "landed":
    case "arrived_fbo":
      return "bg-green-100 text-green-800 border-green-200";
    case "en_route":
    case "departed":
    case "boarding":
      return "bg-blue-100 text-blue-800 border-blue-200";
    case "scheduled":
      return "bg-gray-100 text-gray-600 border-gray-200";
    case "delayed":
      return "bg-amber-100 text-amber-800 border-amber-200";
    case "cancelled":
      return "bg-red-100 text-red-800 border-red-200";
    default:
      return "bg-gray-100 text-gray-500 border-gray-200";
  }
}

function statusLabel(status: CrewTravel["status"], delayMin: number | null): string {
  switch (status) {
    case "landed": return "Landed";
    case "arrived_fbo": return "At FBO";
    case "en_route": return "En Route";
    case "departed": return "Departed";
    case "boarding": return "Boarding";
    case "scheduled": return "Scheduled";
    case "delayed": return delayMin ? `Delayed ${delayMin}m` : "Delayed";
    case "cancelled": return "Cancelled";
    default: return "—";
  }
}

function transportBadge(type: CrewTravel["transport_type"]): { label: string; cls: string } {
  switch (type) {
    case "commercial": return { label: "Flight", cls: "bg-blue-100 text-blue-700" };
    case "uber": return { label: "Uber", cls: "bg-violet-100 text-violet-700" };
    case "rental": return { label: "Rental", cls: "bg-orange-100 text-orange-700" };
    case "brightline": return { label: "Brightline", cls: "bg-teal-100 text-teal-700" };
    case "staying": return { label: "Staying", cls: "bg-emerald-100 text-emerald-700" };
    case "standby": return { label: "Standby", cls: "bg-gray-100 text-gray-500" };
    default: return { label: "TBD", cls: "bg-gray-100 text-gray-400" };
  }
}

const AIRCRAFT_BADGE: Record<string, { cls: string; label: string }> = {
  citation_x: { cls: "bg-green-100 text-green-700", label: "CX" },
  challenger: { cls: "bg-yellow-100 text-yellow-700", label: "CL" },
  dual: { cls: "bg-purple-100 text-purple-700", label: "DU" },
};

// ─── Crew Card ───────────────────────────────────────────────────────────────

function CrewCard({ crew, onStatusOverride }: {
  crew: CrewTravel;
  onStatusOverride: (name: string, status: CrewTravel["status"]) => void;
}) {
  const tb = transportBadge(crew.transport_type);
  const sc = statusColor(crew.status);
  const sl = statusLabel(crew.status, crew.delay_minutes);
  const ac = AIRCRAFT_BADGE[crew.aircraft_type] ?? { cls: "bg-gray-100 text-gray-500", label: "?" };

  return (
    <div className={`rounded-lg border p-3 space-y-1.5 ${
      crew.status === "cancelled" ? "border-red-300 bg-red-50/30" :
      crew.status === "delayed" ? "border-amber-300 bg-amber-50/30" :
      crew.status === "landed" || crew.status === "arrived_fbo" ? "border-green-200 bg-green-50/20" :
      "border-gray-200 bg-white"
    }`}>
      {/* Header: name + role + tail */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="font-medium text-sm text-gray-900">{crew.name}</span>
          <span className={`text-[10px] px-1.5 py-0.5 rounded font-bold ${
            crew.role === "PIC" ? "bg-blue-100 text-blue-700" : "bg-purple-100 text-purple-700"
          }`}>{crew.role}</span>
          {crew.is_checkairman && <span className="text-[10px] px-1 py-0.5 rounded bg-amber-100 text-amber-700 font-bold">CA</span>}
          {crew.is_early_volunteer && <span className="text-[10px] px-1 py-0.5 rounded bg-indigo-100 text-indigo-700">Early</span>}
        </div>
        <div className="flex items-center gap-1.5">
          <span className={`text-[10px] px-1.5 py-0.5 rounded font-mono ${ac.cls}`}>{ac.label}</span>
          <span className="text-xs font-mono font-bold text-gray-700">{crew.tail_number || "—"}</span>
        </div>
      </div>

      {/* Transport + status */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${tb.cls}`}>{tb.label}</span>
          {crew.flight_numbers.length > 0 && (
            <span className="font-mono text-xs text-gray-700">
              {crew.flight_numbers.join(" → ")}
            </span>
          )}
          {crew.transport_type === "uber" || crew.transport_type === "rental" ? (
            <span className="text-[10px] text-gray-500">{crew.swap_location && `→ ${crew.swap_location}`}</span>
          ) : null}
        </div>
        <div className="flex items-center gap-1.5">
          <span className={`text-[10px] px-2 py-0.5 rounded-full border font-medium ${sc}`}>{sl}</span>
          {/* Manual status override dropdown */}
          <select
            value=""
            onChange={(e) => { if (e.target.value) onStatusOverride(crew.name, e.target.value as CrewTravel["status"]); e.target.value = ""; }}
            className="text-[9px] text-gray-400 border rounded px-1 py-0.5 bg-white hover:text-gray-600"
            title="Override status"
          >
            <option value="">...</option>
            <option value="scheduled">Scheduled</option>
            <option value="departed">Departed</option>
            <option value="en_route">En Route</option>
            <option value="landed">Landed</option>
            <option value="arrived_fbo">At FBO</option>
            <option value="delayed">Delayed</option>
            <option value="cancelled">Cancelled</option>
          </select>
        </div>
      </div>

      {/* Times */}
      <div className="flex items-center gap-4 text-[11px] text-gray-500 flex-wrap">
        {crew.date && <span>Date: {crew.date}</span>}
        {crew.duty_on && <span>Duty On: <span className="font-mono text-gray-700">{fmtTime24(crew.duty_on)}</span></span>}
        {crew.live_departure ? (
          <span>Dep: <span className="font-mono text-blue-700">{new Date(crew.live_departure).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "America/New_York" })} ET</span></span>
        ) : crew.duty_on ? null : null}
        {crew.live_arrival ? (
          <span>ETA: <span className={`font-mono ${crew.delay_minutes && crew.delay_minutes > 15 ? "text-amber-700 font-bold" : "text-green-700"}`}>
            {new Date(crew.live_arrival).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "America/New_York" })} ET
          </span></span>
        ) : crew.arrival_time ? (
          <span>Sched Arr: <span className="font-mono text-gray-700">{fmtTime24(crew.arrival_time)}</span></span>
        ) : null}
        {crew.delay_minutes != null && crew.delay_minutes > 0 && (
          <span className="font-mono text-amber-700 font-bold">+{crew.delay_minutes}min</span>
        )}
        {crew.price && crew.price !== "---" && <span className="text-gray-400">{crew.price}</span>}
        {!crew.verified_ticket && crew.transport_type === "commercial" && (
          <span className="text-red-500 font-medium">UNVERIFIED</span>
        )}
        {crew.verified_ticket && (
          <span className="text-green-600 font-medium">VERIFIED</span>
        )}
      </div>

      {/* Status detail (from FA) */}
      {crew.status_detail && (
        <div className={`text-[10px] font-medium ${crew.status === "cancelled" || crew.status === "delayed" ? "text-amber-600" : "text-blue-500"}`}>
          {crew.status_detail}
        </div>
      )}

      {/* Notes */}
      {crew.notes && (
        <div className="text-[10px] text-gray-400 truncate" title={crew.notes}>{crew.notes}</div>
      )}
    </div>
  );
}

// ─── Summary Bar ─────────────────────────────────────────────────────────────

function SummaryBar({ data }: { data: SwapStatusData }) {
  const all = [...data.oncoming, ...data.offgoing];
  const flights = all.filter(c => c.transport_type === "commercial");
  const landed = flights.filter(c => c.status === "landed" || c.status === "arrived_fbo").length;
  const enRoute = flights.filter(c => c.status === "en_route" || c.status === "departed").length;
  const delayed = flights.filter(c => c.status === "delayed").length;
  const cancelled = flights.filter(c => c.status === "cancelled").length;
  const scheduled = flights.filter(c => c.status === "scheduled").length;
  const unverified = flights.filter(c => !c.verified_ticket).length;

  return (
    <div className="flex items-center gap-3 flex-wrap text-xs">
      <span className="font-medium text-gray-700">{all.length} crew</span>
      <span className="text-gray-300">|</span>
      <span className="text-blue-600">{flights.length} flights</span>
      {landed > 0 && <span className="px-2 py-0.5 rounded-full bg-green-100 text-green-700">{landed} landed</span>}
      {enRoute > 0 && <span className="px-2 py-0.5 rounded-full bg-blue-100 text-blue-700">{enRoute} en route</span>}
      {delayed > 0 && <span className="px-2 py-0.5 rounded-full bg-amber-100 text-amber-800">{delayed} delayed</span>}
      {cancelled > 0 && <span className="px-2 py-0.5 rounded-full bg-red-100 text-red-800">{cancelled} cancelled</span>}
      {scheduled > 0 && <span className="text-gray-400">{scheduled} scheduled</span>}
      {unverified > 0 && <span className="px-2 py-0.5 rounded-full bg-red-50 text-red-600 border border-red-200">{unverified} unverified</span>}
    </div>
  );
}

// ─── Main Component ──────────────────────────────────────────────────────────

export default function SwapStatus() {
  const [data, setData] = useState<SwapStatusData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "oncoming" | "offgoing">("all");
  const [statusFilter, setStatusFilter] = useState<"all" | "flights_only" | "problems">("all");

  const [enriching, setEnriching] = useState(false);

  const loadStatus = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // Step 1: Load sheet data (fast, ~2s)
      const res = await fetch("/api/crew/swap-status");
      if (!res.ok) {
        const d = await res.json().catch(() => ({ error: "Failed to load" }));
        setError(d.error ?? `Error ${res.status}`);
        return;
      }
      const d = await res.json();
      setData(d);

      // Step 2: Enrich with FlightAware (separate call, may take longer)
      setEnriching(true);
      try {
        const liveRes = await fetch("/api/crew/swap-status?live=true");
        if (liveRes.ok) {
          const liveData = await liveRes.json();
          setData(liveData);
        }
      } catch {
        // FA enrichment failed — keep sheet data with time-based guesses
      } finally {
        setEnriching(false);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadStatus(); }, [loadStatus]);

  const handleStatusOverride = useCallback((name: string, status: CrewTravel["status"]) => {
    setData(prev => {
      if (!prev) return prev;
      const update = (list: CrewTravel[]) => list.map(c => c.name === name ? { ...c, status } : c);
      return { ...prev, oncoming: update(prev.oncoming), offgoing: update(prev.offgoing) };
    });
  }, []);

  // Filter crew
  const getFiltered = () => {
    if (!data) return [];
    let list = filter === "oncoming" ? data.oncoming :
               filter === "offgoing" ? data.offgoing :
               [...data.oncoming, ...data.offgoing];

    if (statusFilter === "flights_only") {
      list = list.filter(c => c.transport_type === "commercial" || c.transport_type === "brightline");
    } else if (statusFilter === "problems") {
      list = list.filter(c => c.status === "delayed" || c.status === "cancelled" || (!c.verified_ticket && c.transport_type === "commercial"));
    }

    // Sort: problems first, then by arrival time
    list.sort((a, b) => {
      const priority = (c: CrewTravel) => c.status === "cancelled" ? 0 : c.status === "delayed" ? 1 : c.status === "scheduled" ? 3 : 2;
      const pa = priority(a), pb = priority(b);
      if (pa !== pb) return pa - pb;
      return (a.arrival_time ?? "9999").localeCompare(b.arrival_time ?? "9999");
    });

    return list;
  };

  const filtered = getFiltered();

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-bold text-gray-900">Swap Day Status</h2>
          {data && <div className="text-xs text-gray-500">{data.sheet_name} — {data.swap_date}</div>}
        </div>
        <div className="flex items-center gap-2">
          {data && (
            <span className="text-[10px] text-gray-400">
              Updated {new Date(data.last_updated).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}
              {data.fa_flights_resolved != null && (
                <span className="ml-1 text-blue-500">FA: {data.fa_flights_resolved}/{data.fa_flights_total}</span>
              )}
            </span>
          )}
          {enriching && <span className="text-[10px] text-blue-500 animate-pulse">Fetching live flight status...</span>}
          <button
            onClick={loadStatus}
            disabled={loading || enriching}
            className="px-3 py-1.5 text-xs font-medium border rounded-lg bg-blue-50 text-blue-700 hover:bg-blue-100 border-blue-200 disabled:opacity-50"
          >
            {loading ? "Loading..." : enriching ? "Enriching..." : "Refresh"}
          </button>
        </div>
      </div>

      {/* Summary */}
      {data && <SummaryBar data={data} />}

      {/* Filters */}
      <div className="flex items-center gap-2">
        <div className="flex bg-gray-100 rounded-lg p-0.5">
          {(["all", "oncoming", "offgoing"] as const).map(f => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`px-3 py-1 text-xs font-medium rounded-md transition-colors ${
                filter === f ? "bg-white text-gray-900 shadow-sm" : "text-gray-500 hover:text-gray-700"
              }`}
            >
              {f === "all" ? "All" : f === "oncoming" ? "Oncoming" : "Offgoing"}
            </button>
          ))}
        </div>
        <div className="flex bg-gray-100 rounded-lg p-0.5">
          {(["all", "flights_only", "problems"] as const).map(f => (
            <button
              key={f}
              onClick={() => setStatusFilter(f)}
              className={`px-3 py-1 text-xs font-medium rounded-md transition-colors ${
                statusFilter === f ? "bg-white text-gray-900 shadow-sm" : "text-gray-500 hover:text-gray-700"
              }`}
            >
              {f === "all" ? "All Transport" : f === "flights_only" ? "Flights Only" : "Problems"}
            </button>
          ))}
        </div>
        <span className="text-[10px] text-gray-400 ml-2">{filtered.length} shown</span>
      </div>

      {/* Error */}
      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
      )}

      {/* Crew cards */}
      {data && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-2">
          {filtered.map((crew) => (
            <CrewCard key={`${crew.name}-${crew.direction}`} crew={crew} onStatusOverride={handleStatusOverride} />
          ))}
        </div>
      )}

      {data && filtered.length === 0 && (
        <div className="text-center text-sm text-gray-400 py-8">No crew matching filters.</div>
      )}

      {!data && !loading && !error && (
        <div className="text-center text-sm text-gray-400 py-8">Click Refresh to load swap status from Google Sheets.</div>
      )}
    </div>
  );
}
