"use client";

import React, { useEffect, useState, useCallback } from "react";
import { getAirportTimezone } from "@/lib/airportTimezones";

// ─── Types ──────────────────────────────────────────────────────────────────

type LegDetail = {
  flight_number: string;
  status: string;
  delay_minutes: number | null;
  origin: string;
  destination: string;
  scheduled_departure: string | null;
  actual_departure: string | null;
  estimated_arrival: string | null;
  actual_arrival: string | null;
};

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
  leg_details: LegDetail[];
  connection_at_risk: boolean;
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

type ImpactSuggestion = {
  type: string;
  description: string;
  estimated_cost_delta: number | null;
  crew_affected_count: number;
  auto_applicable: boolean;
};

type ImpactEntry = {
  tail_number: string;
  severity: "critical" | "warning" | "info";
  affected_crew: { name: string; role: string; direction: string; detail: string }[];
  suggestions?: ImpactSuggestion[] | null;
  resolved: boolean;
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fmtTime24(timeStr: string | null): string {
  if (!timeStr) return "—";
  // Handle "0900L", "0440L", "1247L" format
  const m = timeStr.match(/^(\d{2})(\d{2})L?$/);
  if (m) return `${m[1]}:${m[2]}L`;
  return timeStr;
}

function fmtLocalTime(isoTime: string, airportCode: string): string {
  const tz = getAirportTimezone(airportCode) ?? "America/New_York";
  const d = new Date(isoTime);
  const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: tz });
  const tzAbbr = d.toLocaleTimeString("en-US", { timeZoneName: "short", timeZone: tz }).split(" ").pop() ?? "";
  return `${time} ${tzAbbr}`;
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

function legDelayBadge(leg: LegDetail): { text: string; cls: string } {
  if (leg.status === "Cancelled") return { text: "CANX", cls: "text-red-600 font-bold" };
  if (leg.delay_minutes != null && leg.delay_minutes > 10) return { text: `+${leg.delay_minutes}m`, cls: "text-amber-700 font-bold" };
  if (leg.status === "Landed" || leg.status === "Arrived") return { text: "landed", cls: "text-green-600" };
  if (leg.status === "En Route" || leg.status === "Departed") return { text: "en route", cls: "text-blue-600" };
  return { text: "on time", cls: "text-gray-500" };
}

const AIRCRAFT_BADGE: Record<string, { cls: string; label: string }> = {
  citation_x: { cls: "bg-green-100 text-green-700", label: "CX" },
  challenger: { cls: "bg-yellow-100 text-yellow-700", label: "CL" },
  dual: { cls: "bg-purple-100 text-purple-700", label: "DU" },
};

// ─── Inline Suggestions ──────────────────────────────────────────────────────

function SuggestionPills({ suggestions, severity }: { suggestions: ImpactSuggestion[]; severity: string }) {
  const dotColor: Record<string, string> = {
    no_action: "bg-green-400",
    earlier_flight: "bg-blue-400",
    backup_flight: "bg-blue-300",
    ground_transport: "bg-purple-400",
    rebook: "bg-indigo-400",
    pool_swap: "bg-teal-400",
    reoptimize: "bg-amber-400",
    review_swap_points: "bg-amber-300",
  };

  return (
    <div className={`mt-1 px-2 py-1.5 rounded-md border text-[10px] space-y-0.5 ${
      severity === "critical" ? "bg-red-50/50 border-red-200" : "bg-amber-50/50 border-amber-200"
    }`}>
      <div className="text-[9px] text-gray-500 uppercase font-semibold tracking-wider">Suggested Actions</div>
      {suggestions.slice(0, 3).map((s, i) => (
        <div key={i} className="flex items-start gap-1.5">
          <span className={`mt-0.5 w-1.5 h-1.5 rounded-full flex-shrink-0 ${dotColor[s.type] ?? "bg-gray-400"}`} />
          <span className="text-gray-700">{s.description}</span>
          {s.estimated_cost_delta != null && s.estimated_cost_delta > 0 && (
            <span className="text-gray-400 flex-shrink-0">(~${s.estimated_cost_delta})</span>
          )}
        </div>
      ))}
    </div>
  );
}

// ─── Crew Card ───────────────────────────────────────────────────────────────

function CrewCard({ crew, onStatusOverride, impactInfo }: {
  crew: CrewTravel;
  onStatusOverride: (name: string, status: CrewTravel["status"]) => void;
  impactInfo?: { severity: string; suggestions: ImpactSuggestion[] } | null;
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
        <div className="flex items-center gap-2 flex-wrap">
          <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${tb.cls}`}>{tb.label}</span>
          {crew.leg_details && crew.leg_details.length > 0 ? (
            <span className="font-mono text-xs text-gray-700">
              {crew.leg_details.map((leg, i) => {
                const badge = legDelayBadge(leg);
                return (
                  <span key={leg.flight_number}>
                    {i > 0 && <span className="text-gray-400"> {"\u2192"} </span>}
                    <span>{leg.flight_number}</span>
                    {" "}
                    <span className={`text-[9px] ${badge.cls}`}>{badge.text}</span>
                  </span>
                );
              })}
            </span>
          ) : crew.flight_numbers.length > 0 ? (
            <span className="font-mono text-xs text-gray-700">
              {crew.flight_numbers.join(" \u2192 ")}
            </span>
          ) : null}
          {crew.transport_type === "uber" || crew.transport_type === "rental" ? (
            <span className="text-[10px] text-gray-500">{crew.swap_location && `\u2192 ${crew.swap_location}`}</span>
          ) : null}
          {crew.connection_at_risk && (
            <span className="text-[9px] px-1.5 py-0.5 rounded bg-red-100 text-red-700 font-medium border border-red-200">
              Connection at risk
            </span>
          )}
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
          <span>Dep: <span className="font-mono text-blue-700">{fmtLocalTime(crew.live_departure, crew.direction === "offgoing" ? crew.swap_location : (crew.home_airports[0] ?? crew.swap_location))}</span></span>
        ) : crew.duty_on ? null : null}
        {crew.live_arrival ? (
          <span>ETA: <span className={`font-mono ${crew.delay_minutes && crew.delay_minutes > 15 ? "text-amber-700 font-bold" : "text-green-700"}`}>
            {fmtLocalTime(crew.live_arrival, crew.direction === "oncoming" ? crew.swap_location : (crew.home_airports[0] ?? crew.swap_location))}
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

      {/* Impact suggestions */}
      {impactInfo && impactInfo.suggestions.length > 0 && (
        <SuggestionPills suggestions={impactInfo.suggestions} severity={impactInfo.severity} />
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
  const connectionsAtRisk = flights.filter(c => c.connection_at_risk).length;

  return (
    <div className="flex items-center gap-3 flex-wrap text-xs">
      <span className="font-medium text-gray-700">{all.length} crew</span>
      <span className="text-gray-300">|</span>
      <span className="text-blue-600">{flights.length} flights</span>
      {landed > 0 && <span className="px-2 py-0.5 rounded-full bg-green-100 text-green-700">{landed} landed</span>}
      {enRoute > 0 && <span className="px-2 py-0.5 rounded-full bg-blue-100 text-blue-700">{enRoute} en route</span>}
      {delayed > 0 && <span className="px-2 py-0.5 rounded-full bg-amber-100 text-amber-800">{delayed} delayed</span>}
      {cancelled > 0 && <span className="px-2 py-0.5 rounded-full bg-red-100 text-red-800">{cancelled} cancelled</span>}
      {connectionsAtRisk > 0 && <span className="px-2 py-0.5 rounded-full bg-red-100 text-red-700 border border-red-200">{connectionsAtRisk} connection{connectionsAtRisk > 1 ? "s" : ""} at risk</span>}
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
  const [statusFilter, setStatusFilter] = useState<"all" | "flights_only" | "problems" | "standby">("all");
  const [viewMode, setViewMode] = useState<"list" | "cards" | "tail">("list");

  const [enriching, setEnriching] = useState(false);
  const [impacts, setImpacts] = useState<ImpactEntry[]>([]);

  // Build lookup: "name|tail" → suggestions for unresolved impacts
  const suggestionLookup = new Map<string, { severity: string; suggestions: ImpactSuggestion[] }>();
  for (const imp of impacts) {
    if (imp.resolved || !imp.suggestions?.length) continue;
    for (const crew of imp.affected_crew) {
      const key = `${crew.name}|${imp.tail_number}`;
      if (!suggestionLookup.has(key)) {
        suggestionLookup.set(key, { severity: imp.severity, suggestions: imp.suggestions });
      }
    }
  }

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

      // Step 3: Fetch impact suggestions (if plan exists for this swap date)
      try {
        const impRes = await fetch(`/api/crew/swap-plan/impact?swap_date=${d.swap_date}`);
        if (impRes.ok) {
          const impData = await impRes.json();
          setImpacts(impData.impacts ?? []);
        }
      } catch {
        // Impact fetch failed — no suggestions shown, not critical
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

    if (statusFilter === "standby") {
      list = list.filter(c => c.transport_type === "standby");
    } else {
      // Hide standby by default
      list = list.filter(c => c.transport_type !== "standby");
      if (statusFilter === "flights_only") {
        list = list.filter(c => c.transport_type === "commercial" || c.transport_type === "brightline");
      } else if (statusFilter === "problems") {
        list = list.filter(c => c.status === "delayed" || c.status === "cancelled" || c.connection_at_risk || (!c.verified_ticket && c.transport_type === "commercial"));
      }
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
      <div className="flex items-center gap-2 flex-wrap">
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
          {(["all", "flights_only", "problems", "standby"] as const).map(f => (
            <button
              key={f}
              onClick={() => setStatusFilter(f)}
              className={`px-3 py-1 text-xs font-medium rounded-md transition-colors ${
                statusFilter === f ? "bg-white text-gray-900 shadow-sm" : "text-gray-500 hover:text-gray-700"
              }`}
            >
              {f === "all" ? "All Active" : f === "flights_only" ? "Flights Only" : f === "problems" ? "Problems" : "Standby"}
            </button>
          ))}
        </div>
        <div className="flex bg-gray-100 rounded-lg p-0.5">
          {(["list", "cards", "tail"] as const).map(v => (
            <button
              key={v}
              onClick={() => setViewMode(v)}
              className={`px-3 py-1 text-xs font-medium rounded-md transition-colors ${
                viewMode === v ? "bg-white text-gray-900 shadow-sm" : "text-gray-500 hover:text-gray-700"
              }`}
            >
              {v === "list" ? "List" : v === "cards" ? "Cards" : "By Tail"}
            </button>
          ))}
        </div>
        <span className="text-[10px] text-gray-400 ml-2">{filtered.length} shown</span>
      </div>

      {/* Error */}
      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
      )}

      {/* List view */}
      {data && viewMode === "list" && (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-gray-50 text-left text-[10px] text-gray-500 uppercase tracking-wider sticky top-0">
              <tr>
                <th className="px-2 py-1.5">Status</th>
                <th className="px-2 py-1.5">Name</th>
                <th className="px-2 py-1.5">Role</th>
                <th className="px-2 py-1.5">Dir</th>
                <th className="px-2 py-1.5">Tail</th>
                <th className="px-2 py-1.5">Transport</th>
                <th className="px-2 py-1.5">Flight</th>
                <th className="px-2 py-1.5">Date</th>
                <th className="px-2 py-1.5">Duty On</th>
                <th className="px-2 py-1.5">ETA</th>
                <th className="px-2 py-1.5">Delay</th>
                <th className="px-2 py-1.5">Ticket</th>
                <th className="px-2 py-1.5">Notes</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {filtered.map((crew) => {
                const sc = statusColor(crew.status);
                const tb = transportBadge(crew.transport_type);
                const eta = crew.live_arrival
                  ? fmtLocalTime(crew.live_arrival, crew.direction === "oncoming" ? crew.swap_location : (crew.home_airports[0] ?? crew.swap_location))
                  : crew.arrival_time ? fmtTime24(crew.arrival_time) : "—";
                const crewImpact = suggestionLookup.get(`${crew.name}|${crew.tail_number}`);
                return (<React.Fragment key={`${crew.name}-${crew.direction}`}>
                  <tr className={`hover:bg-gray-50 ${
                    crew.status === "cancelled" ? "bg-red-50/50" :
                    crew.status === "delayed" ? "bg-amber-50/50" :
                    crew.status === "landed" || crew.status === "arrived_fbo" ? "bg-green-50/30" : ""
                  }`}>
                    <td className="px-2 py-1.5">
                      <span className={`inline-block text-[9px] px-1.5 py-0.5 rounded-full border font-medium whitespace-nowrap ${sc}`}>
                        {statusLabel(crew.status, crew.delay_minutes)}
                      </span>
                    </td>
                    <td className="px-2 py-1.5 font-medium text-gray-900 whitespace-nowrap">{crew.name}</td>
                    <td className="px-2 py-1.5">
                      <span className={`text-[9px] px-1 py-0.5 rounded font-bold ${
                        crew.role === "PIC" ? "bg-blue-100 text-blue-700" : "bg-purple-100 text-purple-700"
                      }`}>{crew.role}</span>
                    </td>
                    <td className="px-2 py-1.5 text-[10px] text-gray-500">{crew.direction === "oncoming" ? "ON" : "OFF"}</td>
                    <td className="px-2 py-1.5 font-mono text-[10px] font-bold text-gray-700">{crew.tail_number || "—"}</td>
                    <td className="px-2 py-1.5">
                      <span className={`text-[9px] px-1 py-0.5 rounded font-medium ${tb.cls}`}>{tb.label}</span>
                    </td>
                    <td className="px-2 py-1.5 font-mono text-[10px] text-gray-700">
                      {crew.leg_details && crew.leg_details.length > 0 ? (
                        <div className="space-y-0.5">
                          <div className="whitespace-nowrap">
                            {crew.leg_details.map((leg, i) => {
                              const badge = legDelayBadge(leg);
                              return (
                                <span key={leg.flight_number}>
                                  {i > 0 && <span className="text-gray-400"> {"\u2192"} </span>}
                                  <span>{leg.flight_number}</span>
                                  {" "}
                                  <span className={`text-[9px] ${badge.cls}`}>{badge.text}</span>
                                </span>
                              );
                            })}
                          </div>
                          {crew.connection_at_risk && (
                            <span className="inline-block text-[9px] px-1.5 py-0.5 rounded bg-red-100 text-red-700 font-medium border border-red-200">
                              Connection at risk
                            </span>
                          )}
                        </div>
                      ) : crew.flight_numbers.length > 0 ? (
                        <span className="whitespace-nowrap">{crew.flight_numbers.join(" \u2192 ")}</span>
                      ) : "—"}
                    </td>
                    <td className="px-2 py-1.5 text-[10px] text-gray-500">{crew.date ?? "—"}</td>
                    <td className="px-2 py-1.5 font-mono text-[10px] text-gray-600">{crew.duty_on ? fmtTime24(crew.duty_on) : "—"}</td>
                    <td className={`px-2 py-1.5 font-mono text-[10px] ${crew.delay_minutes && crew.delay_minutes > 15 ? "text-amber-700 font-bold" : "text-gray-700"}`}>
                      {eta}
                    </td>
                    <td className="px-2 py-1.5 text-[10px]">
                      {crew.leg_details && crew.leg_details.length > 1 ? (
                        <div className="space-y-0.5">
                          {crew.leg_details.map(leg => (
                            <div key={leg.flight_number} className="whitespace-nowrap">
                              {leg.delay_minutes != null && leg.delay_minutes > 0 ? (
                                <span className="text-amber-700 font-bold">+{leg.delay_minutes}m</span>
                              ) : <span className="text-gray-400">0m</span>}
                            </div>
                          ))}
                        </div>
                      ) : crew.delay_minutes != null && crew.delay_minutes > 0 ? (
                        <span className="text-amber-700 font-bold">+{crew.delay_minutes}m</span>
                      ) : "—"}
                    </td>
                    <td className="px-2 py-1.5 text-[10px]">
                      {crew.transport_type === "commercial" ? (
                        crew.verified_ticket
                          ? <span className="text-green-600 font-medium">OK</span>
                          : <span className="text-red-500 font-medium">NO</span>
                      ) : <span className="text-gray-300">—</span>}
                    </td>
                    <td className="px-2 py-1.5 text-[10px] text-gray-400 max-w-[200px] truncate" title={crew.notes ?? crew.status_detail ?? ""}>
                      {crew.status_detail ?? crew.notes ?? "—"}
                    </td>
                  </tr>
                  {crewImpact && crewImpact.suggestions.length > 0 && (
                    <tr className="bg-gray-50/50">
                      <td colSpan={12} className="px-2 py-1">
                        <SuggestionPills suggestions={crewImpact.suggestions} severity={crewImpact.severity} />
                      </td>
                    </tr>
                  )}
                </React.Fragment>);
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Card view */}
      {data && viewMode === "cards" && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-2">
          {filtered.map((crew) => (
            <CrewCard
              key={`${crew.name}-${crew.direction}`}
              crew={crew}
              onStatusOverride={handleStatusOverride}
              impactInfo={suggestionLookup.get(`${crew.name}|${crew.tail_number}`)}
            />
          ))}
        </div>
      )}

      {/* By Tail view */}
      {data && viewMode === "tail" && (() => {
        // Apply statusFilter to all crew (both directions), ignoring direction filter
        const applyStatusFilter = (list: CrewTravel[]) => {
          if (statusFilter === "standby") return list.filter(c => c.transport_type === "standby");
          let result = list.filter(c => c.transport_type !== "standby");
          if (statusFilter === "flights_only") result = result.filter(c => c.transport_type === "commercial" || c.transport_type === "brightline");
          else if (statusFilter === "problems") result = result.filter(c => c.status === "delayed" || c.status === "cancelled" || (!c.verified_ticket && c.transport_type === "commercial"));
          return result;
        };

        const filteredOncoming = applyStatusFilter(data.oncoming);
        const filteredOffgoing = applyStatusFilter(data.offgoing);
        const allFiltered = [...filteredOncoming, ...filteredOffgoing];

        // Collect unique tail numbers (skip empty — no-tail standby crew)
        const tailSet = new Set<string>();
        allFiltered.forEach(c => { if (c.tail_number) tailSet.add(c.tail_number); });

        // Sort: tails with problems first, then alphabetically
        const hasProblem = (tail: string) =>
          allFiltered.some(c => c.tail_number === tail && (c.status === "delayed" || c.status === "cancelled"));

        const tails = Array.from(tailSet).sort((a, b) => {
          const pa = hasProblem(a) ? 0 : 1;
          const pb = hasProblem(b) ? 0 : 1;
          if (pa !== pb) return pa - pb;
          return a.localeCompare(b);
        });

        const TailMiniTable = ({ crew, label }: { crew: CrewTravel[]; label: string }) => {
          if (crew.length === 0) return null;
          return (
            <div>
              <div className={`text-[10px] font-bold uppercase tracking-wider px-1 py-0.5 ${
                label === "Oncoming" ? "text-blue-600" : "text-orange-600"
              }`}>{label}</div>
              <table className="w-full text-xs">
                <thead className="text-[9px] text-gray-400 uppercase tracking-wider">
                  <tr>
                    <th className="px-1.5 py-0.5 text-left">Role</th>
                    <th className="px-1.5 py-0.5 text-left">Name</th>
                    <th className="px-1.5 py-0.5 text-left">Transport</th>
                    <th className="px-1.5 py-0.5 text-left">Flight</th>
                    <th className="px-1.5 py-0.5 text-left">Status</th>
                    <th className="px-1.5 py-0.5 text-left">ETA</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {crew.map(c => {
                    const tb = transportBadge(c.transport_type);
                    const sc = statusColor(c.status);
                    const eta = c.live_arrival
                      ? fmtLocalTime(c.live_arrival, c.direction === "oncoming" ? c.swap_location : (c.home_airports[0] ?? c.swap_location))
                      : c.arrival_time ? fmtTime24(c.arrival_time) : "\u2014";
                    return (
                      <tr key={`${c.name}-${c.direction}`} className={
                        c.status === "cancelled" ? "bg-red-50/50" :
                        c.status === "delayed" ? "bg-amber-50/50" :
                        c.status === "landed" || c.status === "arrived_fbo" ? "bg-green-50/30" : ""
                      }>
                        <td className="px-1.5 py-1">
                          <span className={`text-[9px] px-1 py-0.5 rounded font-bold ${
                            c.role === "PIC" ? "bg-blue-100 text-blue-700" : "bg-purple-100 text-purple-700"
                          }`}>{c.role}</span>
                        </td>
                        <td className="px-1.5 py-1 font-medium text-gray-900 whitespace-nowrap">{c.name}</td>
                        <td className="px-1.5 py-1">
                          <span className={`text-[9px] px-1 py-0.5 rounded font-medium ${tb.cls}`}>{tb.label}</span>
                        </td>
                        <td className="px-1.5 py-1 font-mono text-[10px] text-gray-700 whitespace-nowrap">
                          {c.flight_numbers.length > 0 ? c.flight_numbers.join(" \u2192 ") : "\u2014"}
                        </td>
                        <td className="px-1.5 py-1">
                          <span className={`text-[9px] px-1.5 py-0.5 rounded-full border font-medium whitespace-nowrap ${sc}`}>
                            {statusLabel(c.status, c.delay_minutes)}
                          </span>
                        </td>
                        <td className={`px-1.5 py-1 font-mono text-[10px] ${c.delay_minutes && c.delay_minutes > 15 ? "text-amber-700 font-bold" : "text-gray-700"}`}>
                          {eta}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          );
        };

        return (
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
            {tails.map(tail => {
              const oncoming = filteredOncoming.filter(c => c.tail_number === tail);
              const offgoing = filteredOffgoing.filter(c => c.tail_number === tail);
              const swapLoc = [...oncoming, ...offgoing].find(c => c.swap_location)?.swap_location;
              const tailHasProblem = hasProblem(tail);
              const ac = [...oncoming, ...offgoing][0];
              const acBadge = ac ? (AIRCRAFT_BADGE[ac.aircraft_type] ?? { cls: "bg-gray-100 text-gray-500", label: "?" }) : null;

              return (
                <div key={tail} className={`rounded-lg border p-3 space-y-2 ${
                  tailHasProblem ? "border-amber-300 bg-amber-50/20" : "border-gray-200 bg-white"
                }`}>
                  {/* Tail header */}
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-sm font-bold text-gray-900">{tail}</span>
                      {acBadge && <span className={`text-[10px] px-1.5 py-0.5 rounded font-mono ${acBadge.cls}`}>{acBadge.label}</span>}
                      {tailHasProblem && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-800 font-medium">Issues</span>}
                    </div>
                    {swapLoc && <span className="text-[10px] text-gray-500">Swap: <span className="font-medium text-gray-700">{swapLoc}</span></span>}
                  </div>
                  {/* Crew tables */}
                  <TailMiniTable crew={oncoming} label="Oncoming" />
                  <TailMiniTable crew={offgoing} label="Offgoing" />
                </div>
              );
            })}
            {tails.length === 0 && (
              <div className="col-span-2 text-center text-sm text-gray-400 py-8">No tails matching filters.</div>
            )}
          </div>
        );
      })()}

      {data && filtered.length === 0 && viewMode !== "tail" && (
        <div className="text-center text-sm text-gray-400 py-8">No crew matching filters.</div>
      )}

      {!data && !loading && !error && (
        <div className="text-center text-sm text-gray-400 py-8">Click Refresh to load swap status from Google Sheets.</div>
      )}
    </div>
  );
}
