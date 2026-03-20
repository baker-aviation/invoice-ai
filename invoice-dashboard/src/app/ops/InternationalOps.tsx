"use client";

import { useState, useEffect, useCallback } from "react";
import type {
  Flight,
  Country,
  CountryRequirement,
  IntlLegPermit,
  IntlLegHandler,
  IntlLegAlert,
  UsCustomsAirport,
  IntlDocument,
} from "@/lib/opsApi";
import { isInternationalFlight } from "@/lib/intlUtils";

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
export default function InternationalOps({ flights }: { flights: Flight[] }) {
  const [subTab, setSubTab] = useState<SubTab>("Flight Board");
  const [countries, setCountries] = useState<Country[]>([]);
  const [alerts, setAlerts] = useState<IntlLegAlert[]>([]);
  const [loading, setLoading] = useState(true);

  const intlFlights = flights
    .filter(isInternationalFlight)
    .filter((f) => {
      const dep = new Date(f.scheduled_departure);
      const now = new Date();
      return dep >= new Date(now.getTime() - 24 * 60 * 60 * 1000);
    })
    .sort((a, b) => new Date(a.scheduled_departure).getTime() - new Date(b.scheduled_departure).getTime());

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
    Promise.all([loadCountries(), loadAlerts()]).finally(() => setLoading(false));
  }, [loadCountries, loadAlerts]);

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
        <FlightBoard flights={intlFlights} countries={countries} />
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
// FLIGHT BOARD — 30-day international leg lookahead
// ===========================================================================
function FlightBoard({ flights, countries }: { flights: Flight[]; countries: Country[] }) {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  if (flights.length === 0) {
    return <p className="text-sm text-gray-500">No international flights in the next 30 days.</p>;
  }

  // Group by date
  const byDate = new Map<string, Flight[]>();
  for (const f of flights) {
    const d = new Date(f.scheduled_departure).toLocaleDateString("en-US", {
      weekday: "short", month: "short", day: "numeric",
    });
    if (!byDate.has(d)) byDate.set(d, []);
    byDate.get(d)!.push(f);
  }

  return (
    <div className="space-y-4">
      <p className="text-xs text-gray-500">{flights.length} international leg{flights.length > 1 ? "s" : ""} in the next 30 days</p>
      {Array.from(byDate.entries()).map(([date, dateFlights]) => (
        <div key={date}>
          <h3 className="text-xs font-semibold text-gray-700 uppercase tracking-wide mb-1">{date}</h3>
          <div className="space-y-1">
            {dateFlights.map((f) => (
              <FlightRow
                key={f.id}
                flight={f}
                countries={countries}
                expanded={expandedId === f.id}
                onToggle={() => setExpandedId(expandedId === f.id ? null : f.id)}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

type OverflightInfo = { country_name: string; country_iso: string; fir_id: string };

function FlightRow({ flight, countries, expanded, onToggle }: {
  flight: Flight;
  countries: Country[];
  expanded: boolean;
  onToggle: () => void;
}) {
  const [overflights, setOverflights] = useState<OverflightInfo[]>([]);
  const [ovfLoaded, setOvfLoaded] = useState(false);

  const dep = new Date(flight.scheduled_departure);
  const time = dep.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" });
  const daysOut = Math.ceil((dep.getTime() - Date.now()) / (1000 * 60 * 60 * 24));

  const [ffRoute, setFfRoute] = useState<string | null>(null);
  const [routeMethod, setRouteMethod] = useState<string>("loading");

  // Fetch overflights + ForeFlight route once per row
  useEffect(() => {
    if (ovfLoaded || !flight.departure_icao || !flight.arrival_icao) return;
    setOvfLoaded(true);
    const params = new URLSearchParams({ dep: flight.departure_icao, arr: flight.arrival_icao });
    if (flight.tail_number) params.set("tail", flight.tail_number);
    fetch(`/api/ops/intl/route-analysis?${params}`)
      .then((r) => r.json())
      .then((d) => {
        setOverflights(d.overflights ?? []);
        setFfRoute(d.foreflight?.route ?? null);
        setRouteMethod(d.method ?? "great_circle");
      })
      .catch(() => { setRouteMethod("error"); });
  }, [flight.departure_icao, flight.arrival_icao, flight.tail_number, ovfLoaded]);

  // Flag overflown countries that require permits
  const ovfPermitCountries = overflights.filter((o) => {
    const c = countries.find((c) => c.iso_code === o.country_iso);
    return c?.overflight_permit_required;
  });

  return (
    <div className="border border-gray-200 rounded-lg overflow-hidden">
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-3 px-3 py-2 text-left hover:bg-gray-50 transition-colors"
      >
        <span className="text-xs font-mono text-gray-500 w-12">{time}Z</span>
        <span className="text-sm font-medium w-16">{flight.tail_number ?? "?"}</span>
        <span className="text-sm">
          <span className="font-medium">{flight.departure_icao}</span>
          <span className="text-gray-400 mx-1">&rarr;</span>
          <span className="font-medium">{flight.arrival_icao}</span>
        </span>
        {/* Overflight badges */}
        {overflights.length > 0 && (
          <span className="flex gap-0.5 flex-wrap">
            {overflights.map((o) => {
              const needsPermit = ovfPermitCountries.some((p) => p.country_iso === o.country_iso);
              return (
                <span key={o.fir_id} className={`text-[10px] px-1 py-0.5 rounded ${
                  needsPermit ? "bg-orange-100 text-orange-700 font-medium" : "bg-gray-100 text-gray-500"
                }`} title={`Overflies ${o.country_name}${needsPermit ? " — PERMIT REQUIRED" : ""}`}>
                  {o.country_iso}{needsPermit ? "!" : ""}
                </span>
              );
            })}
          </span>
        )}
        <span className="text-xs text-gray-500 ml-auto">
          {flight.pic && <span className="mr-2">PIC: {flight.pic}</span>}
          {flight.sic && <span>SIC: {flight.sic}</span>}
        </span>
        <span className={`text-xs px-2 py-0.5 rounded-full ${
          daysOut <= 4 ? "bg-red-100 text-red-700" : daysOut <= 7 ? "bg-yellow-100 text-yellow-700" : "bg-gray-100 text-gray-600"
        }`}>
          {daysOut <= 0 ? "Today" : `${daysOut}d`}
        </span>
        <svg className={`w-4 h-4 text-gray-400 transition-transform ${expanded ? "rotate-180" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {expanded && (
        <FlightDetail flight={flight} countries={countries} overflights={overflights} ffRoute={ffRoute} routeMethod={routeMethod} />
      )}
    </div>
  );
}

// ===========================================================================
// FLIGHT DETAIL — permits, handlers, checklist for a single leg
// ===========================================================================
function FlightDetail({ flight, countries, overflights, ffRoute, routeMethod }: { flight: Flight; countries: Country[]; overflights: OverflightInfo[]; ffRoute: string | null; routeMethod: string }) {
  const [permits, setPermits] = useState<IntlLegPermit[]>([]);
  const [handlers, setHandlers] = useState<IntlLegHandler[]>([]);
  const [requirements, setRequirements] = useState<CountryRequirement[]>([]);
  const [loading, setLoading] = useState(true);
  const [autoCreating, setAutoCreating] = useState(false);

  // Form states
  const [showAddPermit, setShowAddPermit] = useState(false);
  const [showAddHandler, setShowAddHandler] = useState(false);
  const [newPermit, setNewPermit] = useState({ country_id: "", permit_type: "landing" as string, deadline: "" });
  const [newHandler, setNewHandler] = useState({ handler_name: "", airport_icao: flight.arrival_icao ?? "", handler_contact: "" });

  // Compute relevant countries: destination/departure + overflown
  const relevantCountryIds = new Set<string>();
  for (const c of countries) {
    const prefixes = c.icao_prefixes ?? [];
    // Destination/departure country
    if (prefixes.some((p: string) => flight.departure_icao?.startsWith(p) || flight.arrival_icao?.startsWith(p))) {
      relevantCountryIds.add(c.id);
    }
    // Overflown country
    if (overflights.some((o) => o.country_iso === c.iso_code)) {
      relevantCountryIds.add(c.id);
    }
  }

  const loadData = useCallback(async () => {
    try {
      const [permRes, handlerRes] = await Promise.all([
        fetch(`/api/ops/intl/permits?flight_id=${flight.id}`),
        fetch(`/api/ops/intl/handlers?flight_id=${flight.id}`),
      ]);
      const [permData, handlerData] = await Promise.all([permRes.json(), handlerRes.json()]);
      setPermits(permData.permits ?? []);
      setHandlers(handlerData.handlers ?? []);

      // Load requirements for all relevant countries (destination + overflown)
      const relevantCountries = countries.filter((c) => relevantCountryIds.has(c.id));
      if (relevantCountries.length > 0) {
        const reqResults = await Promise.all(
          relevantCountries.map((c) =>
            fetch(`/api/ops/intl/countries/${c.id}/requirements`).then((r) => r.json())
          )
        );
        setRequirements(reqResults.flatMap((r) => r.requirements ?? []));
      }
    } catch { /* ignore */ }
    setLoading(false);
  }, [flight.id, countries, relevantCountryIds]);

  useEffect(() => { loadData(); }, [loadData]);

  async function addPermit() {
    if (!newPermit.country_id) return;
    await fetch("/api/ops/intl/permits", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        flight_id: flight.id,
        country_id: newPermit.country_id,
        permit_type: newPermit.permit_type,
        deadline: newPermit.deadline || null,
      }),
    });
    setShowAddPermit(false);
    setNewPermit({ country_id: "", permit_type: "landing", deadline: "" });
    loadData();
  }

  async function updatePermitStatus(permitId: string, status: string) {
    await fetch(`/api/ops/intl/permits/${permitId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    loadData();
  }

  async function addHandler() {
    if (!newHandler.handler_name) return;
    await fetch("/api/ops/intl/handlers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        flight_id: flight.id,
        handler_name: newHandler.handler_name,
        handler_contact: newHandler.handler_contact || null,
        airport_icao: newHandler.airport_icao,
      }),
    });
    setShowAddHandler(false);
    setNewHandler({ handler_name: "", airport_icao: flight.arrival_icao ?? "", handler_contact: "" });
    loadData();
  }

  async function toggleHandlerStatus(handlerId: string, field: "requested" | "approved", value: boolean) {
    await fetch(`/api/ops/intl/handlers/${handlerId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ [field]: value }),
    });
    loadData();
  }

  // Compute which permits are missing for this leg
  const missingPermits: Array<{ country: Country; type: "overflight" | "landing" }> = [];
  for (const c of countries) {
    if (!relevantCountryIds.has(c.id)) continue;
    const isOverflown = overflights.some((o) => o.country_iso === c.iso_code);
    const isDestination = (c.icao_prefixes ?? []).some((p: string) =>
      flight.departure_icao?.startsWith(p) || flight.arrival_icao?.startsWith(p)
    );

    // Check overflight permit
    if (isOverflown && c.overflight_permit_required) {
      const hasIt = permits.some((p) => p.country_id === c.id && p.permit_type === "overflight");
      if (!hasIt) missingPermits.push({ country: c, type: "overflight" });
    }
    // Check landing permit
    if (isDestination && c.landing_permit_required) {
      const hasIt = permits.some((p) => p.country_id === c.id && p.permit_type === "landing");
      if (!hasIt) missingPermits.push({ country: c, type: "landing" });
    }
  }

  /** Compute deadline based on country lead time */
  function computeDeadline(c: Country): string | null {
    if (!c.permit_lead_time_days) return null;
    const dep = new Date(flight.scheduled_departure);
    if (c.permit_lead_time_working_days) {
      // Subtract working days (skip weekends)
      let remaining = c.permit_lead_time_days;
      const d = new Date(dep);
      while (remaining > 0) {
        d.setDate(d.getDate() - 1);
        const dow = d.getDay();
        if (dow !== 0 && dow !== 6) remaining--;
      }
      return d.toISOString().slice(0, 10);
    }
    const d = new Date(dep.getTime() - c.permit_lead_time_days * 24 * 60 * 60 * 1000);
    return d.toISOString().slice(0, 10);
  }

  async function autoCreatePermits() {
    if (missingPermits.length === 0) return;
    setAutoCreating(true);
    for (const mp of missingPermits) {
      await fetch("/api/ops/intl/permits", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          flight_id: flight.id,
          country_id: mp.country.id,
          permit_type: mp.type,
          deadline: computeDeadline(mp.country),
          notes: `Tail: ${flight.tail_number ?? "unknown"}`,
        }),
      });
    }
    setAutoCreating(false);
    loadData();
  }

  if (loading) return <div className="px-3 py-2 text-xs text-gray-500 animate-pulse">Loading...</div>;

  return (
    <div className="border-t border-gray-200 bg-gray-50 px-4 py-3 space-y-4">
      {/* Overflight route analysis */}
      {(overflights.length > 0 || ffRoute) && (
        <div>
          <div className="flex items-center gap-2 mb-1">
            <h4 className="text-xs font-semibold text-gray-700 uppercase">Route Overflight Analysis</h4>
            <span className="text-[10px] bg-gray-100 text-gray-500 px-1.5 py-0.5 rounded">
              {routeMethod === "foreflight+great_circle" ? "ForeFlight + GC" : routeMethod === "great_circle" ? "Great Circle" : routeMethod}
            </span>
          </div>
          {ffRoute && (
            <p className="text-xs text-gray-600 font-mono bg-white border border-gray-200 rounded px-2 py-1 mb-1.5 break-all">
              {ffRoute}
            </p>
          )}
          <div className="flex gap-1.5 flex-wrap">
            {overflights.map((o) => {
              const c = countries.find((c) => c.iso_code === o.country_iso);
              const needsPermit = c?.overflight_permit_required;
              return (
                <span key={o.fir_id} className={`text-xs px-2 py-0.5 rounded-full ${
                  needsPermit ? "bg-orange-100 text-orange-700 font-medium" : "bg-gray-100 text-gray-600"
                }`}>
                  {o.country_name} ({o.fir_id})
                  {needsPermit && " — PERMIT REQUIRED"}
                </span>
              );
            })}
          </div>
        </div>
      )}

      {/* Auto-create missing permits */}
      {missingPermits.length > 0 && (
        <div className="bg-yellow-50 border border-yellow-200 rounded px-3 py-2">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs font-medium text-yellow-800">
                {missingPermits.length} permit{missingPermits.length > 1 ? "s" : ""} not yet tracked:
              </p>
              <p className="text-xs text-yellow-700 mt-0.5">
                {missingPermits.map((mp) => `${mp.country.name} (${mp.type})`).join(", ")}
              </p>
            </div>
            <button
              onClick={autoCreatePermits}
              disabled={autoCreating}
              className="px-3 py-1 text-xs bg-yellow-600 text-white rounded hover:bg-yellow-700 disabled:opacity-50"
            >
              {autoCreating ? "Creating..." : "Auto-Create Permits"}
            </button>
          </div>
        </div>
      )}

      {/* Requirements checklist */}
      {requirements.length > 0 && (
        <div>
          <h4 className="text-xs font-semibold text-gray-700 uppercase mb-1">Country Requirements</h4>
          <div className="space-y-1">
            {requirements.map((r) => (
              <div key={r.id} className="flex items-start gap-2 text-xs">
                <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${
                  r.requirement_type === "overflight" ? "bg-orange-100 text-orange-700" :
                  r.requirement_type === "landing" ? "bg-blue-100 text-blue-700" :
                  r.requirement_type === "customs" ? "bg-purple-100 text-purple-700" :
                  "bg-gray-100 text-gray-600"
                }`}>{r.requirement_type}</span>
                <span className="font-medium">{r.name}</span>
                {r.description && <span className="text-gray-500">— {r.description}</span>}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Permits */}
      <div>
        <div className="flex items-center justify-between mb-1">
          <h4 className="text-xs font-semibold text-gray-700 uppercase">Permits</h4>
          <button onClick={() => setShowAddPermit(!showAddPermit)} className="text-xs text-blue-600 hover:text-blue-800">
            + Add Permit
          </button>
        </div>

        {showAddPermit && (
          <div className="flex gap-2 items-end mb-2 p-2 bg-white border border-gray-200 rounded">
            <div>
              <label className="text-[10px] text-gray-500">Country</label>
              <select
                value={newPermit.country_id}
                onChange={(e) => setNewPermit({ ...newPermit, country_id: e.target.value })}
                className="block w-40 text-xs border border-gray-300 rounded px-2 py-1"
              >
                <option value="">Select...</option>
                {countries.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-[10px] text-gray-500">Type</label>
              <select
                value={newPermit.permit_type}
                onChange={(e) => setNewPermit({ ...newPermit, permit_type: e.target.value })}
                className="block w-28 text-xs border border-gray-300 rounded px-2 py-1"
              >
                <option value="landing">Landing</option>
                <option value="overflight">Overflight</option>
              </select>
            </div>
            <div>
              <label className="text-[10px] text-gray-500">Deadline</label>
              <input
                type="date"
                value={newPermit.deadline}
                onChange={(e) => setNewPermit({ ...newPermit, deadline: e.target.value })}
                className="block text-xs border border-gray-300 rounded px-2 py-1"
              />
            </div>
            <button onClick={addPermit} className="px-2 py-1 text-xs bg-blue-600 text-white rounded hover:bg-blue-700">Save</button>
            <button onClick={() => setShowAddPermit(false)} className="px-2 py-1 text-xs text-gray-500 hover:text-gray-700">Cancel</button>
          </div>
        )}

        {permits.length === 0 && !showAddPermit ? (
          <p className="text-xs text-gray-400">No permits tracked yet</p>
        ) : (
          <div className="space-y-1">
            {permits.map((p) => (
              <div key={p.id} className="flex items-center gap-2 text-xs bg-white border border-gray-200 rounded px-2 py-1.5">
                <span className="font-medium w-28">{(p.country as Country | undefined)?.name ?? "?"}</span>
                <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${
                  p.permit_type === "overflight" ? "bg-orange-100 text-orange-700" : "bg-blue-100 text-blue-700"
                }`}>{p.permit_type}</span>
                <select
                  value={p.status}
                  onChange={(e) => updatePermitStatus(p.id, e.target.value)}
                  className={`text-xs rounded px-1.5 py-0.5 border-0 font-medium cursor-pointer ${statusColor(p.status)}`}
                >
                  <option value="not_started">Not Started</option>
                  <option value="drafted">Drafted</option>
                  <option value="submitted">Submitted</option>
                  <option value="approved">Approved</option>
                </select>
                {p.deadline && (
                  <span className="text-gray-500">
                    Due: {new Date(p.deadline + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                  </span>
                )}
                {p.reference_number && <span className="text-gray-400">Ref: {p.reference_number}</span>}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Handlers */}
      <div>
        <div className="flex items-center justify-between mb-1">
          <h4 className="text-xs font-semibold text-gray-700 uppercase">Ground Handling</h4>
          <button onClick={() => setShowAddHandler(!showAddHandler)} className="text-xs text-blue-600 hover:text-blue-800">
            + Add Handler
          </button>
        </div>

        {showAddHandler && (
          <div className="flex gap-2 items-end mb-2 p-2 bg-white border border-gray-200 rounded">
            <div>
              <label className="text-[10px] text-gray-500">Handler Name</label>
              <input
                value={newHandler.handler_name}
                onChange={(e) => setNewHandler({ ...newHandler, handler_name: e.target.value })}
                placeholder="e.g. Jet Aviation"
                className="block w-40 text-xs border border-gray-300 rounded px-2 py-1"
              />
            </div>
            <div>
              <label className="text-[10px] text-gray-500">Airport</label>
              <input
                value={newHandler.airport_icao}
                onChange={(e) => setNewHandler({ ...newHandler, airport_icao: e.target.value.toUpperCase() })}
                className="block w-20 text-xs border border-gray-300 rounded px-2 py-1"
              />
            </div>
            <div>
              <label className="text-[10px] text-gray-500">Contact</label>
              <input
                value={newHandler.handler_contact}
                onChange={(e) => setNewHandler({ ...newHandler, handler_contact: e.target.value })}
                placeholder="Phone/email"
                className="block w-36 text-xs border border-gray-300 rounded px-2 py-1"
              />
            </div>
            <button onClick={addHandler} className="px-2 py-1 text-xs bg-blue-600 text-white rounded hover:bg-blue-700">Save</button>
            <button onClick={() => setShowAddHandler(false)} className="px-2 py-1 text-xs text-gray-500 hover:text-gray-700">Cancel</button>
          </div>
        )}

        {handlers.length === 0 && !showAddHandler ? (
          <p className="text-xs text-gray-400">No handler assigned</p>
        ) : (
          <div className="space-y-1">
            {handlers.map((h) => (
              <div key={h.id} className="flex items-center gap-3 text-xs bg-white border border-gray-200 rounded px-2 py-1.5">
                <span className="font-medium">{h.handler_name}</span>
                <span className="text-gray-500">{h.airport_icao}</span>
                {h.handler_contact && <span className="text-gray-400">{h.handler_contact}</span>}
                <label className="flex items-center gap-1 ml-auto cursor-pointer">
                  <input
                    type="checkbox"
                    checked={h.requested}
                    onChange={(e) => toggleHandlerStatus(h.id, "requested", e.target.checked)}
                    className="rounded border-gray-300"
                  />
                  <span className={h.requested ? "text-blue-600" : "text-gray-400"}>Requested</span>
                </label>
                <label className="flex items-center gap-1 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={h.approved}
                    onChange={(e) => toggleHandlerStatus(h.id, "approved", e.target.checked)}
                    className="rounded border-gray-300"
                  />
                  <span className={h.approved ? "text-green-600" : "text-gray-400"}>Approved</span>
                </label>
              </div>
            ))}
          </div>
        )}
      </div>
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
          <div className="space-y-4">
            <div>
              <h3 className="text-lg font-semibold">{selected.name}</h3>
              <div className="flex gap-2 mt-1 flex-wrap">
                {selected.overflight_permit_required && (
                  <span className="text-xs bg-orange-100 text-orange-700 px-2 py-0.5 rounded-full">Overflight Permit Required</span>
                )}
                {selected.landing_permit_required && (
                  <span className="text-xs bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full">Landing Permit Required</span>
                )}
                {selected.permit_lead_time_days && (
                  <span className="text-xs bg-yellow-100 text-yellow-700 px-2 py-0.5 rounded-full">
                    {selected.permit_lead_time_days} {selected.permit_lead_time_working_days ? "working" : ""} day{selected.permit_lead_time_days > 1 ? "s" : ""} advance
                  </span>
                )}
                {selected.treat_as_international && (
                  <span className="text-xs bg-purple-100 text-purple-700 px-2 py-0.5 rounded-full">Treated as International</span>
                )}
                {selected.icao_prefixes?.length > 0 && (
                  <span className="text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded-full">ICAO: {selected.icao_prefixes.join(", ")}</span>
                )}
              </div>
              {selected.notes && <p className="text-sm text-gray-600 mt-2">{selected.notes}</p>}
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
                    <input
                      value={newReq.name}
                      onChange={(e) => setNewReq({ ...newReq, name: e.target.value })}
                      className="block w-full text-xs border border-gray-300 rounded px-2 py-1"
                    />
                  </div>
                  <div>
                    <label className="text-[10px] text-gray-500">Type</label>
                    <select
                      value={newReq.requirement_type}
                      onChange={(e) => setNewReq({ ...newReq, requirement_type: e.target.value })}
                      className="block text-xs border border-gray-300 rounded px-2 py-1"
                    >
                      <option value="landing">Landing</option>
                      <option value="overflight">Overflight</option>
                      <option value="customs">Customs</option>
                      <option value="handling">Handling</option>
                    </select>
                  </div>
                  <div className="flex-1">
                    <label className="text-[10px] text-gray-500">Description</label>
                    <input
                      value={newReq.description}
                      onChange={(e) => setNewReq({ ...newReq, description: e.target.value })}
                      className="block w-full text-xs border border-gray-300 rounded px-2 py-1"
                    />
                  </div>
                  <button onClick={addRequirement} className="px-2 py-1 text-xs bg-blue-600 text-white rounded hover:bg-blue-700">Save</button>
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
                    <div key={r.id} className="bg-white border border-gray-200 rounded px-3 py-2">
                      <div className="flex items-center gap-2">
                        <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${
                          r.requirement_type === "overflight" ? "bg-orange-100 text-orange-700" :
                          r.requirement_type === "landing" ? "bg-blue-100 text-blue-700" :
                          r.requirement_type === "customs" ? "bg-purple-100 text-purple-700" :
                          "bg-gray-100 text-gray-600"
                        }`}>{r.requirement_type}</span>
                        <span className="text-sm font-medium">{r.name}</span>
                      </div>
                      {r.description && <p className="text-xs text-gray-500 mt-1">{r.description}</p>}
                      {r.required_documents.length > 0 && (
                        <div className="flex gap-1 mt-1">
                          <span className="text-[10px] text-gray-400">Docs:</span>
                          {r.required_documents.map((d) => (
                            <span key={d} className="text-[10px] bg-gray-100 text-gray-600 px-1 rounded">{d.replace(/_/g, " ")}</span>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
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

  const loadDocs = useCallback(async () => {
    const params = filter !== "all" ? `?document_type=${filter}` : "";
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
            {docTypes.map((t) => (
              <option key={t} value={t}>{t.charAt(0).toUpperCase() + t.slice(1)}</option>
            ))}
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
                    <td className="px-3 py-1.5">
                      <button onClick={() => downloadDoc(d.id)} className="text-blue-600 hover:text-blue-800">Download</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
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
        <p className="text-xs text-gray-400">No customs airports added yet. Start building your knowledge base by adding airports your aircraft commonly clear customs at.</p>
      ) : (
        <div className="border border-gray-200 rounded overflow-hidden">
          <table className="w-full text-xs">
            <thead className="bg-gray-50">
              <tr>
                <th className="text-left px-3 py-1.5 font-medium text-gray-600">ICAO</th>
                <th className="text-left px-3 py-1.5 font-medium text-gray-600">Airport</th>
                <th className="text-left px-3 py-1.5 font-medium text-gray-600">Type</th>
                <th className="text-left px-3 py-1.5 font-medium text-gray-600">Hours</th>
                <th className="text-left px-3 py-1.5 font-medium text-gray-600">Notice</th>
                <th className="text-left px-3 py-1.5 font-medium text-gray-600">OT</th>
                <th className="text-left px-3 py-1.5 font-medium text-gray-600">Difficulty</th>
                <th className="text-left px-3 py-1.5 font-medium text-gray-600">Notes</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {airports.map((a) => (
                <tr key={a.id} className="hover:bg-gray-50">
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
                  <td className="px-3 py-1.5 text-gray-500 max-w-xs truncate">{a.restrictions || a.notes || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
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
