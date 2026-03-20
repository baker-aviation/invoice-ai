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
export default function InternationalOps({ flights: _parentFlights }: { flights: Flight[] }) {
  const [subTab, setSubTab] = useState<SubTab>("Flight Board");
  const [countries, setCountries] = useState<Country[]>([]);
  const [alerts, setAlerts] = useState<IntlLegAlert[]>([]);
  const [allFlights, setAllFlights] = useState<Flight[]>([]);
  const [loading, setLoading] = useState(true);

  // The parent page only fetches 48h of flights. We need 30 days for the international board.
  const loadFlights = useCallback(async () => {
    try {
      const res = await fetch("/api/ops/flights?lookahead_hours=720&lookback_hours=24");
      const data = await res.json();
      setAllFlights(data.flights ?? data.items ?? []);
    } catch {
      // Fallback to parent flights if API fails
      setAllFlights(_parentFlights);
    }
  }, [_parentFlights]);

  const intlFlights = allFlights
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
    Promise.all([loadFlights(), loadCountries(), loadAlerts()]).finally(() => setLoading(false));
  }, [loadFlights, loadCountries, loadAlerts]);

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

  // Use fast great-circle-only endpoint for row badges (no ForeFlight call)
  useEffect(() => {
    if (ovfLoaded || !flight.departure_icao || !flight.arrival_icao) return;
    setOvfLoaded(true);
    fetch(`/api/ops/intl/overflights?dep=${flight.departure_icao}&arr=${flight.arrival_icao}`)
      .then((r) => r.json())
      .then((d) => {
        setOverflights(d.overflights ?? []);
        setRouteMethod("great_circle");
      })
      .catch(() => { setRouteMethod("error"); });
  }, [flight.departure_icao, flight.arrival_icao, ovfLoaded]);

  // Only fetch ForeFlight route when expanded
  useEffect(() => {
    if (!expanded || ffRoute !== null || !flight.departure_icao || !flight.arrival_icao || !flight.tail_number) return;
    const params = new URLSearchParams({ dep: flight.departure_icao, arr: flight.arrival_icao, tail: flight.tail_number });
    fetch(`/api/ops/intl/route-analysis?${params}`)
      .then((r) => r.json())
      .then((d) => {
        if (d.foreflight?.route) setFfRoute(d.foreflight.route);
        if (d.overflights?.length) setOverflights(d.overflights);
        setRouteMethod(d.method ?? "great_circle");
      })
      .catch(() => {});
  }, [expanded, ffRoute, flight.departure_icao, flight.arrival_icao, flight.tail_number]);

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

  // Compute relevant country IDs (memoize to avoid re-renders)
  const relevantCountryIdStr = countries
    .filter((c) => {
      const prefixes = c.icao_prefixes ?? [];
      const isDepArr = prefixes.some((p: string) => flight.departure_icao?.startsWith(p) || flight.arrival_icao?.startsWith(p));
      const isOverflown = overflights.some((o) => o.country_iso === c.iso_code);
      return isDepArr || isOverflown;
    })
    .map((c) => c.id)
    .sort()
    .join(",");

  const loadData = useCallback(async () => {
    try {
      const ids = relevantCountryIdStr.split(",").filter(Boolean);
      // Fetch permits, handlers, and all country requirements in parallel
      const fetches: Promise<Response>[] = [
        fetch(`/api/ops/intl/permits?flight_id=${flight.id}`),
        fetch(`/api/ops/intl/handlers?flight_id=${flight.id}`),
        ...ids.map((cid) => fetch(`/api/ops/intl/countries/${cid}/requirements`)),
      ];
      const responses = await Promise.all(fetches);
      const jsons = await Promise.all(responses.map((r) => r.json()));

      setPermits(jsons[0].permits ?? []);
      setHandlers(jsons[1].handlers ?? []);
      // Deduplicate requirements by name (e.g. "eAPIS Submission" appears per-country)
      const allReqs = jsons.slice(2).flatMap((r) => r.requirements ?? []);
      const seen = new Set<string>();
      const deduped = allReqs.filter((r: CountryRequirement) => {
        const key = `${r.name}|${r.requirement_type}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      setRequirements(deduped);
    } catch { /* ignore */ }
    setLoading(false);
  }, [flight.id, relevantCountryIdStr]);

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
  const relevantIds = new Set(relevantCountryIdStr.split(",").filter(Boolean));
  const missingPermits: Array<{ country: Country; type: "overflight" | "landing" }> = [];
  for (const c of countries) {
    if (!relevantIds.has(c.id)) continue;
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
      {/* Airspace / Overflight list */}
      <div>
        <div className="flex items-center gap-2 mb-1">
          <h4 className="text-xs font-semibold text-gray-700 uppercase">Airspace Transited</h4>
          <span className="text-[10px] bg-gray-100 text-gray-500 px-1.5 py-0.5 rounded">
            {routeMethod === "foreflight+great_circle" ? "ForeFlight + GC" : routeMethod === "great_circle" ? "Great Circle" : routeMethod === "loading" ? "analyzing..." : routeMethod}
          </span>
        </div>
        {ffRoute && (
          <p className="text-xs text-gray-600 font-mono bg-white border border-gray-200 rounded px-2 py-1 mb-1.5 break-all">
            {ffRoute}
          </p>
        )}
        {overflights.length > 0 ? (
          <div className="space-y-1">
            {overflights.map((o) => {
              const c = countries.find((c) => c.iso_code === o.country_iso);
              const needsOvfPermit = c?.overflight_permit_required;
              const needsLandPermit = c?.landing_permit_required;
              const isDestination = (c?.icao_prefixes ?? []).some((p: string) =>
                flight.departure_icao?.startsWith(p) || flight.arrival_icao?.startsWith(p)
              );
              return (
                <div key={o.fir_id} className={`flex items-center gap-2 text-xs px-2 py-1.5 rounded border ${
                  needsOvfPermit ? "bg-orange-50 border-orange-200" : "bg-white border-gray-200"
                }`}>
                  <span className="font-medium w-6 text-center">{o.country_iso}</span>
                  <span className="text-gray-700">{o.country_name}</span>
                  <span className="text-gray-400 text-[10px]">FIR: {o.fir_id}</span>
                  <span className="ml-auto flex gap-1">
                    {isDestination && <span className="text-[10px] bg-blue-100 text-blue-700 px-1.5 py-0.5 rounded">DEST</span>}
                    {needsOvfPermit && <span className="text-[10px] bg-orange-100 text-orange-700 px-1.5 py-0.5 rounded font-medium">OVF PERMIT REQ</span>}
                    {needsLandPermit && isDestination && <span className="text-[10px] bg-blue-100 text-blue-700 px-1.5 py-0.5 rounded font-medium">LANDING PERMIT REQ</span>}
                    {c?.permit_lead_time_days && <span className="text-[10px] bg-yellow-100 text-yellow-700 px-1.5 py-0.5 rounded">{c.permit_lead_time_days}{c.permit_lead_time_working_days ? " work" : ""} days</span>}
                    {!needsOvfPermit && !needsLandPermit && !isDestination && <span className="text-[10px] text-gray-400">transit only</span>}
                  </span>
                </div>
              );
            })}
          </div>
        ) : routeMethod !== "loading" ? (
          <p className="text-xs text-gray-400">No foreign airspace transited (direct US routing).</p>
        ) : null}
      </div>

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
