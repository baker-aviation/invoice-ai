"use client";

import { useState, useCallback, useEffect, Fragment } from "react";

// ─── Types ────────────────────────────────────────────────────────────

interface CrewMember {
  position: string;
  crewId: string;
  weight: number | null;
}

interface FlightSummary {
  flightId: string;
  departure: string;
  destination: string;
  route: string | null;
  aircraftRegistration: string;
  filingStatus: string;
  departureTime: string;
  arrivalTime: string;
  crew: CrewMember[];
  released: boolean;
  callSign: string | null;
  atcStatus: string;
  tripTime: number;
  timeUpdated: string;
  timeCreated: string;
  tripId: string | null;
  tags: string[];
  load: {
    people: number;
    cargo: number;
    passengers: unknown[];
  };
  filingInfo: {
    filingStatus: string;
    ctot: string | null;
    atcMessages: Array<{
      content: string;
      type: string;
      sender: string;
      timestamp: string;
    }>;
  } | null;
}

type SubResource = "flightDetail" | "navlog" | "briefing" | "rwa" | "wb" | "icao";

const SUB_RESOURCE_LABELS: Record<SubResource, string> = {
  flightDetail: "Full Detail",
  navlog: "Navlog",
  briefing: "Briefing",
  rwa: "Runway Analysis",
  wb: "W&B",
  icao: "ICAO",
};

// ─── Helpers ──────────────────────────────────────────────────────────

function crewName(crewId: string): string {
  return crewId.split("@")[0];
}

function fmtLocalTime(utc: string): string {
  try {
    const d = new Date(utc);
    return d.toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZoneName: "short",
    });
  } catch {
    return utc;
  }
}

function fmtMin(sec: number): string {
  const min = Math.round(sec / 60);
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function fmtNum(n: number, decimals = 0): string {
  return n.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

function statusBadge(status: string, released: boolean) {
  if (status === "Cancelled") return <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-700">Cancelled</span>;
  if (released && status === "Filed") return <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-700">Filed & Released</span>;
  if (status === "Filed") return <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-700">Filed</span>;
  return <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-500">{status || "None"}</span>;
}

function rowBg(flight: FlightSummary): string {
  if (flight.filingStatus === "Cancelled") return "bg-red-50/50";
  if (flight.released && flight.filingStatus === "Filed") return "bg-green-50/40";
  if (flight.filingStatus === "Filed") return "bg-blue-50/30";
  return "";
}

function todayStr(): string {
  return new Date().toISOString().split("T")[0];
}

function tomorrowStr(): string {
  const d = new Date();
  d.setDate(d.getDate() + 3);
  return d.toISOString().split("T")[0];
}

// ─── DataSection (lazy-loaded sub-resource panel) ─────────────────────

function DataSection({ label, data }: { label: string; data: unknown }) {
  const [showRaw, setShowRaw] = useState(false);

  const hasError = data && typeof data === "object" && "_error" in (data as Record<string, unknown>);

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4 mt-3">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-medium text-gray-700 uppercase">{label}</span>
        <button onClick={() => setShowRaw(!showRaw)} className="text-xs text-blue-600 hover:text-blue-800">
          {showRaw ? "Hide JSON" : "Show Raw JSON"}
        </button>
      </div>
      {hasError ? (
        <p className="text-sm text-red-600">{String((data as Record<string, unknown>)._error)}</p>
      ) : showRaw ? (
        <pre className="rounded border border-gray-200 bg-gray-50 p-3 text-xs font-mono text-gray-700 overflow-x-auto max-h-[500px] overflow-y-auto">
          {JSON.stringify(data, null, 2)}
        </pre>
      ) : (
        <FormattedView label={label} data={data} />
      )}
    </div>
  );
}

// ─── Formatted views for each sub-resource ────────────────────────────

function FormattedView({ label, data }: { label: string; data: unknown }) {
  const d = data as Record<string, unknown>;
  if (!d) return <p className="text-xs text-gray-400">No data</p>;

  // Detect URL-based responses (RWA, Briefing, W&B, ICAO, Navlog can return {url, timeGenerated})
  if (d.url && typeof d.url === "string") return <DocumentLinkView data={d} />;

  if (label === "Full Detail") return <FlightDetailView data={d} />;

  return (
    <pre className="rounded border border-gray-200 bg-gray-50 p-3 text-xs font-mono text-gray-700 overflow-x-auto max-h-[500px] overflow-y-auto">
      {JSON.stringify(data, null, 2)}
    </pre>
  );
}

function DocumentLinkView({ data }: { data: Record<string, unknown> }) {
  const url = data.url as string;
  const time = data.timeGenerated as string | undefined;

  return (
    <div className="flex items-center gap-3 flex-wrap">
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-md hover:bg-blue-500 transition-colors"
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
        </svg>
        Open Document
      </a>
      {time && <span className="text-xs text-gray-400">Generated {fmtLocalTime(time)}</span>}
    </div>
  );
}

function fmtTimeLocal(isoLocal: string | undefined, tz: string | undefined): string {
  if (!isoLocal) return "—";
  // isoLocal is like "2026-03-31T13:10:00" — parse and format nicely
  const [datePart, timePart] = isoLocal.split("T");
  if (!datePart || !timePart) return isoLocal;
  const [, mo, dy] = datePart.split("-");
  const [hh, mm] = timePart.split(":");
  const months = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${months[Number(mo)]} ${Number(dy)}, ${hh}:${mm}${tz ? ` ${tz}` : ""}`;
}

function fmtMinutes(min: number): string {
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function FlightDetailView({ data }: { data: Record<string, unknown> }) {
  const fd = data.flightData as Record<string, unknown> | undefined;
  const perf = data.performance as Record<string, unknown> | undefined;
  if (!fd) return <pre className="text-xs">{JSON.stringify(data, null, 2)}</pre>;

  const crew = (fd.crew as CrewMember[]) ?? [];
  const route = fd.routeToDestination as Record<string, unknown> | undefined;
  const alt = route?.altitude as Record<string, unknown> | undefined;
  const fuel = perf?.fuel as Record<string, unknown> | undefined;
  const times = perf?.times as Record<string, unknown> | undefined;
  const distances = perf?.distances as Record<string, unknown> | undefined;
  const weights = perf?.weights as Record<string, unknown> | undefined;
  const weather = perf?.weather as Record<string, unknown> | undefined;
  const routeInfo = perf?.destinationRouteInformation as Record<string, unknown> | undefined;
  const transitions = routeInfo?.transitions as Record<string, unknown> | undefined;
  const errors = (perf?.errors as string[]) ?? [];
  const warnings = (perf?.warnings as string[]) ?? [];
  const firs = (routeInfo?.overflownFirs as Record<string, unknown>[]) ?? [];
  const countries = (routeInfo?.overflownCountries as Record<string, unknown>[]) ?? [];
  const waypoints = (routeInfo?.waypoints as Record<string, unknown>[]) ?? [];

  return (
    <div className="space-y-5">
      {/* Errors / Warnings */}
      {(errors.length > 0 || warnings.length > 0) ? (
        <div className="rounded-md border border-red-200 bg-red-50 p-3">
          {errors.map((e, i) => (
            <p key={`e${i}`} className="text-sm font-medium text-red-700">{e}</p>
          ))}
          {warnings.map((w, i) => (
            <p key={`w${i}`} className="text-sm text-amber-700">{w}</p>
          ))}
        </div>
      ) : null}

      {/* Flight header */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3 text-sm">
        <Stat label="Route" value={`${fd.departure as string} → ${fd.destination as string}`} />
        <Stat label="Altitude" value={`FL${String(alt?.altitude ?? "—")}`} />
        <Stat label="Callsign" value={String(fd.callsign ?? "—")} />
        <Stat label="Cruise Profile" value={String(routeInfo?.cruiseProfile ?? "—")} />
        <Stat label="AIRAC" value={String(routeInfo?.airacCycle ?? "—")} />
      </div>

      {/* Route string */}
      {route?.route ? (
        <div>
          <span className="text-xs text-gray-400 block mb-1">Route</span>
          <p className="font-mono text-xs bg-gray-50 border border-gray-200 rounded px-3 py-2">{String(route.route)}</p>
        </div>
      ) : null}

      {/* SID/STAR */}
      {transitions ? (
        <div className="flex gap-6 text-sm">
          {transitions.sidName ? (
            <div>
              <span className="text-xs text-gray-400">SID</span>
              <div className="font-mono">{String(transitions.sidName)} via {String(transitions.sidTransitionPoint)}</div>
            </div>
          ) : null}
          {transitions.starName ? (
            <div>
              <span className="text-xs text-gray-400">STAR</span>
              <div className="font-mono">{String(transitions.starName)} via {String(transitions.starTransitionPoint)}</div>
            </div>
          ) : null}
        </div>
      ) : null}

      {/* Crew */}
      {crew.length > 0 && (
        <div className="flex gap-4 text-sm">
          {crew.map((c, i) => (
            <div key={i}>
              <span className="text-xs text-gray-400">{c.position}</span>
              <div className="font-medium">{crewName(c.crewId)}{c.weight ? <span className="text-xs text-gray-400 ml-1">({c.weight}lb)</span> : null}</div>
            </div>
          ))}
        </div>
      )}

      {/* Times */}
      {times ? (
        <div className="rounded-md border border-gray-200 bg-white p-3">
          <span className="text-xs font-medium text-gray-500 uppercase block mb-2">Times</span>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
            <Stat label="ETE" value={fmtMinutes(times.timeToDestinationMinutes as number)} />
            <Stat label="Total (w/ reserve)" value={fmtMinutes(times.totalTimeMinutes as number)} />
            <Stat label="ETD" value={fmtTimeLocal(times.departureTimeLocal as string, times.departureTimeZone as string)} />
            <Stat label="ETA" value={fmtTimeLocal(times.estimatedArrivalTimeLocal as string, times.arrivalTimeZone as string)} />
          </div>
        </div>
      ) : null}

      {/* Fuel */}
      {fuel ? (
        <div className="rounded-md border border-gray-200 bg-white p-3">
          <span className="text-xs font-medium text-gray-500 uppercase block mb-2">Fuel</span>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
            <Stat label="Flight Fuel" value={`${fmtNum(fuel.flightFuel as number)} lb`} />
            <Stat label="To Destination" value={`${fmtNum(fuel.fuelToDestination as number)} lb`} />
            <Stat label="Landing Fuel" value={`${fmtNum(fuel.landingFuel as number)} lb`} />
            <Stat label="Reserve" value={`${fmtNum(fuel.reserveFuel as number)} lb`} />
            <Stat label="Taxi" value={`${fmtNum(fuel.taxiFuel as number)} lb`} />
            <Stat label="Total Required" value={`${fmtNum(fuel.totalFuel as number)} lb`} />
            <Stat label="Max Capacity" value={`${fmtNum(fuel.maxTotalFuel as number)} lb`} />
            {typeof fuel.co2Emission === "number" ? <Stat label="CO2" value={`${fmtNum(fuel.co2Emission as number)} lb`} /> : null}
          </div>
        </div>
      ) : null}

      {/* Distances + Weather side by side */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {distances ? (
          <div className="rounded-md border border-gray-200 bg-white p-3">
            <span className="text-xs font-medium text-gray-500 uppercase block mb-2">Distances</span>
            <div className="grid grid-cols-2 gap-3 text-sm">
              <Stat label="Route" value={`${fmtNum(distances.destination as number, 1)} NM`} />
              <Stat label="Great Circle" value={`${fmtNum(distances.gcdDestination as number, 1)} NM`} />
            </div>
          </div>
        ) : null}

        {weather ? (
          <div className="rounded-md border border-gray-200 bg-white p-3">
            <span className="text-xs font-medium text-gray-500 uppercase block mb-2">Weather</span>
            <div className="grid grid-cols-2 gap-3 text-sm">
              <Stat label="Wind" value={`${fmtNum(weather.averageWindDirection as number)}° / ${fmtNum(weather.averageWindVelocity as number)} kt`} />
              <Stat label="Component" value={`${Number(weather.averageWindComponent) > 0 ? "+" : ""}${fmtNum(weather.averageWindComponent as number)} kt`} />
              <Stat label="ISA Dev" value={`${Number(weather.averageISADeviation) > 0 ? "+" : ""}${fmtNum(weather.averageISADeviation as number, 1)}°C`} />
            </div>
          </div>
        ) : null}
      </div>

      {/* Weights */}
      {weights ? (
        <div className="rounded-md border border-gray-200 bg-white p-3">
          <span className="text-xs font-medium text-gray-500 uppercase block mb-2">Weights</span>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
            <Stat label="Ramp" value={`${fmtNum(weights.rampWeight as number)} / ${fmtNum(weights.maxRampWeight as number)} lb`} />
            <Stat label="Takeoff" value={`${fmtNum(weights.takeOffWeight as number)} / ${fmtNum(weights.maxTakeOffWeight as number)} lb`} />
            <Stat label="ZFW" value={`${fmtNum(weights.zeroFuelWeight as number)} / ${fmtNum(weights.maxZeroFuelWeight as number)} lb`} />
            <Stat label="Landing" value={`${fmtNum(weights.landingWeight as number)} / ${fmtNum(weights.maxLandingWeight as number)} lb`} />
          </div>
        </div>
      ) : null}

      {/* Overflight — countries + FIRs */}
      {(countries.length > 0 || firs.length > 0) ? (
        <div className="rounded-md border border-gray-200 bg-white p-3">
          <span className="text-xs font-medium text-gray-500 uppercase block mb-2">Overflight</span>
          {countries.length > 0 ? (
            <div className="flex flex-wrap gap-2 mb-3">
              {[...new Set(countries.map(c => c.name as string))].map((name, i) => (
                <span key={i} className="px-2.5 py-1 bg-blue-50 border border-blue-200 rounded text-xs font-medium text-blue-700">{name}</span>
              ))}
            </div>
          ) : null}
          {firs.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-gray-500 border-b border-gray-100">
                    <th className="pb-1.5 pr-3">FIR</th>
                    <th className="pb-1.5 pr-3">Name</th>
                    <th className="pb-1.5 pr-3">Type</th>
                    <th className="pb-1.5 pr-3">Entry</th>
                    <th className="pb-1.5">Exit</th>
                  </tr>
                </thead>
                <tbody>
                  {firs.map((f, i) => (
                    <tr key={i} className="border-b border-gray-50">
                      <td className="py-1.5 pr-3 font-mono font-medium">{f.identifier as string}</td>
                      <td className="py-1.5 pr-3">{f.name as string}</td>
                      <td className="py-1.5 pr-3 text-gray-500">{f.airspaceType as string}</td>
                      <td className="py-1.5 pr-3 font-mono text-gray-500">{fmtLocalTime(f.entryTime as string)}</td>
                      <td className="py-1.5 font-mono text-gray-500">{fmtLocalTime(f.exitTime as string)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </div>
      ) : null}

      {/* Route waypoints */}
      {waypoints.length > 0 ? (
        <div className="rounded-md border border-gray-200 bg-white p-3">
          <span className="text-xs font-medium text-gray-500 uppercase block mb-2">Route Waypoints ({waypoints.length})</span>
          <WaypointsTable waypoints={waypoints} />
        </div>
      ) : null}

      {/* Dispatcher notes */}
      {fd.dispatcherNotes ? (
        <div className="rounded-md border border-amber-200 bg-amber-50 p-3">
          <span className="text-xs font-medium text-amber-700 uppercase block mb-1">Dispatcher Notes</span>
          <p className="text-sm">{String(fd.dispatcherNotes)}</p>
        </div>
      ) : null}
    </div>
  );
}

function WaypointsTable({ waypoints }: { waypoints: Record<string, unknown>[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="text-left text-gray-500 border-b border-gray-100">
            <th className="pb-1.5 pr-3">#</th>
            <th className="pb-1.5 pr-3">Waypoint</th>
            <th className="pb-1.5 pr-3">Airway</th>
            <th className="pb-1.5 pr-3">FL</th>
            <th className="pb-1.5 pr-3">Time Over</th>
            <th className="pb-1.5 pr-3">FIR</th>
            <th className="pb-1.5 pr-3">Lat</th>
            <th className="pb-1.5">Lon</th>
          </tr>
        </thead>
        <tbody>
          {waypoints.map((wp, i) => {
            const airway = wp.airway as Record<string, unknown> | null;
            return (
              <tr key={i} className="border-b border-gray-50">
                <td className="py-1.5 pr-3 text-gray-400">{i + 1}</td>
                <td className="py-1.5 pr-3 font-mono font-medium">{wp.identifier as string ?? "—"}</td>
                <td className="py-1.5 pr-3 font-mono text-gray-500">{airway?.identifier as string ?? ""}</td>
                <td className="py-1.5 pr-3 font-mono">{wp.altitude != null ? String(wp.altitude) : ""}</td>
                <td className="py-1.5 pr-3 font-mono text-gray-500">{wp.timeOverWaypoint ? fmtLocalTime(wp.timeOverWaypoint as string) : ""}</td>
                <td className="py-1.5 pr-3 font-mono">{wp.firIcaoCode as string ?? ""}</td>
                <td className="py-1.5 pr-3 font-mono text-gray-400">{typeof wp.latitude === "number" ? (wp.latitude as number).toFixed(3) : ""}</td>
                <td className="py-1.5 font-mono text-gray-400">{typeof wp.longitude === "number" ? (wp.longitude as number).toFixed(3) : ""}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span className="text-xs text-gray-400">{label}</span>
      <div className="font-mono text-gray-900">{value}</div>
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────

export default function DispatchFlights() {
  const [fromDate, setFromDate] = useState(todayStr);
  const [toDate, setToDate] = useState(tomorrowStr);
  const [search, setSearch] = useState("");
  const [flights, setFlights] = useState<FlightSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [detailCache, setDetailCache] = useState<Record<string, Record<string, unknown>>>({});
  const [loadingSubs, setLoadingSubs] = useState<Record<string, Set<string>>>({});
  const [sortField, setSortField] = useState<"departureTime" | "aircraftRegistration" | "departure">("departureTime");
  const [sortAsc, setSortAsc] = useState(true);

  const fetchFlights = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ action: "flights" });
      if (fromDate) params.set("fromDate", new Date(fromDate).toISOString());
      if (toDate) params.set("toDate", new Date(toDate + "T23:59:59").toISOString());
      if (search.trim()) params.set("search", search.trim());
      const res = await fetch(`/api/foreflight?${params}`);
      const data = await res.json();
      if (!res.ok) { setError(data.error ?? `HTTP ${res.status}`); return; }
      const list = Array.isArray(data) ? data : data.flights ?? [];
      setFlights(list);
      setExpandedId(null);
      setDetailCache({});
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, [fromDate, toDate, search]);

  // Auto-load on mount
  useEffect(() => { fetchFlights(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const fetchSubResource = useCallback(async (flightId: string, sub: SubResource) => {
    const cacheKey = sub;
    if (detailCache[flightId]?.[cacheKey]) return;

    setLoadingSubs(prev => {
      const set = new Set(prev[flightId] ?? []);
      set.add(sub);
      return { ...prev, [flightId]: set };
    });

    try {
      const action = sub === "flightDetail" ? "flightDetail" : sub;
      const res = await fetch(`/api/foreflight?action=${action}&flightId=${encodeURIComponent(flightId)}`);
      const data = await res.json();
      setDetailCache(prev => ({
        ...prev,
        [flightId]: { ...prev[flightId], [cacheKey]: res.ok ? data : { _error: data.error ?? `HTTP ${res.status}` } },
      }));
    } catch (err) {
      setDetailCache(prev => ({
        ...prev,
        [flightId]: { ...prev[flightId], [cacheKey]: { _error: String(err) } },
      }));
    } finally {
      setLoadingSubs(prev => {
        const set = new Set(prev[flightId] ?? []);
        set.delete(sub);
        return { ...prev, [flightId]: set };
      });
    }
  }, [detailCache]);

  const handleRowClick = useCallback((flightId: string) => {
    setExpandedId(prev => {
      const newId = prev === flightId ? null : flightId;
      // Auto-fetch full detail when expanding
      if (newId && !detailCache[flightId]?.flightDetail) {
        fetchSubResource(flightId, "flightDetail");
      }
      return newId;
    });
  }, [detailCache, fetchSubResource]);

  const handleSort = (field: typeof sortField) => {
    if (sortField === field) setSortAsc(!sortAsc);
    else { setSortField(field); setSortAsc(true); }
  };

  const sorted = [...flights].sort((a, b) => {
    const va = a[sortField] ?? "";
    const vb = b[sortField] ?? "";
    const cmp = va < vb ? -1 : va > vb ? 1 : 0;
    return sortAsc ? cmp : -cmp;
  });

  const sortIcon = (field: typeof sortField) =>
    sortField === field ? (sortAsc ? " ↑" : " ↓") : "";

  return (
    <div className="px-6 py-6 space-y-4 max-w-7xl mx-auto">
      {/* Controls */}
      <div className="rounded-lg border border-gray-200 bg-white p-5">
        <h2 className="text-lg font-semibold text-gray-900 mb-1">Dispatch Flights</h2>
        <p className="text-sm text-gray-500 mb-4">
          Browse flights from ForeFlight Dispatch. Click any flight to load detailed data.
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">From Date</label>
            <input
              type="date"
              value={fromDate}
              onChange={e => setFromDate(e.target.value)}
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">To Date</label>
            <input
              type="date"
              value={toDate}
              onChange={e => setToDate(e.target.value)}
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Search</label>
            <input
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Tail, airport, trip..."
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              onKeyDown={e => e.key === "Enter" && fetchFlights()}
            />
          </div>
          <div className="flex items-end">
            <button
              onClick={fetchFlights}
              disabled={loading}
              className="w-full px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-md hover:bg-blue-500 disabled:opacity-50 transition-colors"
            >
              {loading ? "Loading..." : "Load Flights"}
            </button>
          </div>
        </div>
        {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
      </div>

      {/* Flight count */}
      {flights.length > 0 && !loading && (
        <div className="flex items-center gap-4 text-sm text-gray-500 px-1">
          <span className="font-medium text-gray-700">{flights.length} flights</span>
          <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full bg-green-400 inline-block" /> Filed &amp; Released</span>
          <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full bg-blue-400 inline-block" /> Filed</span>
          <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full bg-gray-300 inline-block" /> None</span>
          <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full bg-red-400 inline-block" /> Cancelled</span>
        </div>
      )}

      {/* Flights table */}
      {flights.length > 0 && (
        <div className="rounded-lg border border-gray-200 bg-white overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-gray-500 border-b border-gray-200 bg-gray-50">
                  <th className="py-2.5 px-3 font-medium cursor-pointer hover:text-gray-700" onClick={() => handleSort("aircraftRegistration")}>
                    Tail{sortIcon("aircraftRegistration")}
                  </th>
                  <th className="py-2.5 px-3 font-medium cursor-pointer hover:text-gray-700" onClick={() => handleSort("departure")}>
                    Route{sortIcon("departure")}
                  </th>
                  <th className="py-2.5 px-3 font-medium cursor-pointer hover:text-gray-700" onClick={() => handleSort("departureTime")}>
                    Departure{sortIcon("departureTime")}
                  </th>
                  <th className="py-2.5 px-3 font-medium">Crew</th>
                  <th className="py-2.5 px-3 font-medium">Status</th>
                  <th className="py-2.5 px-3 font-medium">Trip</th>
                  <th className="py-2.5 px-3 font-medium">ETE</th>
                  <th className="py-2.5 px-1 font-medium w-8"></th>
                </tr>
              </thead>
              <tbody>
                {sorted.map(flight => {
                  const isExpanded = expandedId === flight.flightId;
                  const pic = flight.crew.find(c => c.position === "PIC");
                  const sic = flight.crew.find(c => c.position === "SIC");
                  const flightDetail = detailCache[flight.flightId];
                  const flightLoadingSubs = loadingSubs[flight.flightId] ?? new Set();

                  return (
                    <Fragment key={flight.flightId}>
                      <tr
                        className={`border-b border-gray-100 cursor-pointer hover:bg-gray-50 transition-colors ${rowBg(flight)} ${isExpanded ? "!bg-blue-50" : ""}`}
                        onClick={() => handleRowClick(flight.flightId)}
                      >
                        <td className="py-2.5 px-3 font-mono font-semibold text-gray-900">{flight.aircraftRegistration}</td>
                        <td className="py-2.5 px-3">
                          <span className="font-mono font-medium">{flight.departure}</span>
                          <span className="text-gray-400 mx-1">→</span>
                          <span className="font-mono font-medium">{flight.destination}</span>
                          {flight.route && <span className="text-xs text-gray-400 ml-2 hidden md:inline">{flight.route}</span>}
                        </td>
                        <td className="py-2.5 px-3 text-gray-600 whitespace-nowrap">{fmtLocalTime(flight.departureTime)}</td>
                        <td className="py-2.5 px-3 text-gray-600">
                          {pic ? <span className="text-xs"><span className="text-gray-400">P:</span> {crewName(pic.crewId)}</span> : null}
                          {pic && sic ? <span className="text-gray-300 mx-1">|</span> : null}
                          {sic ? <span className="text-xs"><span className="text-gray-400">S:</span> {crewName(sic.crewId)}</span> : null}
                          {!pic && !sic && <span className="text-xs text-gray-300">—</span>}
                        </td>
                        <td className="py-2.5 px-3">{statusBadge(flight.filingStatus, flight.released)}</td>
                        <td className="py-2.5 px-3 font-mono text-xs text-gray-500">{flight.tripId ?? "—"}</td>
                        <td className="py-2.5 px-3 text-gray-500 text-xs">{flight.tripTime > 0 ? fmtMin(flight.tripTime) : "—"}</td>
                        <td className="py-2.5 px-1 text-gray-400">
                          <svg className={`w-4 h-4 transition-transform ${isExpanded ? "rotate-180" : ""}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                          </svg>
                        </td>
                      </tr>

                      {/* Expanded detail */}
                      {isExpanded && (
                        <tr>
                          <td colSpan={8} className="bg-gray-50 border-b border-gray-200">
                            <div className="p-4 space-y-3">
                              {/* Quick summary bar */}
                              <div className="flex items-center gap-4 text-sm text-gray-600 flex-wrap">
                                <span className="font-semibold text-gray-900">{flight.aircraftRegistration}</span>
                                <span className="font-mono">{flight.departure} → {flight.destination}</span>
                                {flight.callSign && <span>Callsign: <span className="font-mono">{flight.callSign}</span></span>}
                                <span>Pax: {flight.load.people}</span>
                                {flight.load.cargo > 0 && <span>Cargo: {fmtNum(flight.load.cargo)} lb</span>}
                              </div>

                              {/* Sub-resource buttons */}
                              <div className="flex flex-wrap gap-2">
                                {(Object.keys(SUB_RESOURCE_LABELS) as SubResource[]).map(sub => {
                                  const loaded = !!flightDetail?.[sub];
                                  const isLoading = flightLoadingSubs.has(sub);
                                  return (
                                    <button
                                      key={sub}
                                      onClick={(e) => { e.stopPropagation(); fetchSubResource(flight.flightId, sub); }}
                                      disabled={isLoading}
                                      className={`px-3 py-1.5 text-xs font-medium rounded-md border transition-colors ${
                                        loaded
                                          ? "bg-blue-50 border-blue-300 text-blue-700"
                                          : isLoading
                                            ? "bg-gray-100 border-gray-300 text-gray-400"
                                            : "bg-white border-gray-300 text-gray-700 hover:bg-gray-50"
                                      }`}
                                    >
                                      {isLoading ? (
                                        <span className="flex items-center gap-1">
                                          <svg className="animate-spin h-3 w-3" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg>
                                          {SUB_RESOURCE_LABELS[sub]}
                                        </span>
                                      ) : (
                                        <>
                                          {loaded && <span className="mr-1">✓</span>}
                                          {SUB_RESOURCE_LABELS[sub]}
                                        </>
                                      )}
                                    </button>
                                  );
                                })}
                              </div>

                              {/* ATC Filing Messages */}
                              {flight.filingInfo?.atcMessages && flight.filingInfo.atcMessages.length > 0 ? (
                                <div className="rounded-lg border border-gray-200 bg-white p-4 mt-3">
                                  <span className="text-xs font-medium text-gray-700 uppercase block mb-3">
                                    Filing Messages ({flight.filingInfo.atcMessages.length})
                                  </span>
                                  <div className="space-y-2">
                                    {flight.filingInfo.atcMessages.map((msg, i) => (
                                      <div key={i} className={`rounded border p-3 ${
                                        msg.type === "ACK" ? "border-green-200 bg-green-50" :
                                        msg.type === "FPL" ? "border-blue-200 bg-blue-50" :
                                        msg.type === "CNL" ? "border-red-200 bg-red-50" :
                                        "border-gray-200 bg-gray-50"
                                      }`}>
                                        <div className="flex items-center justify-between mb-1.5">
                                          <div className="flex items-center gap-2">
                                            <span className={`px-2 py-0.5 rounded text-xs font-bold ${
                                              msg.type === "ACK" ? "bg-green-200 text-green-800" :
                                              msg.type === "FPL" ? "bg-blue-200 text-blue-800" :
                                              msg.type === "CNL" ? "bg-red-200 text-red-800" :
                                              "bg-gray-200 text-gray-800"
                                            }`}>{msg.type}</span>
                                            <span className="text-xs text-gray-500 font-mono">{msg.sender}</span>
                                          </div>
                                          <span className="text-xs text-gray-400">{fmtLocalTime(msg.timestamp)}</span>
                                        </div>
                                        <pre className="text-xs font-mono text-gray-700 whitespace-pre-wrap leading-relaxed">{msg.content}</pre>
                                      </div>
                                    ))}
                                  </div>
                                </div>
                              ) : null}

                              {/* Loaded data sections */}
                              {flightDetail && Object.entries(flightDetail).map(([key, val]) => (
                                <DataSection
                                  key={key}
                                  label={SUB_RESOURCE_LABELS[key as SubResource] ?? key}
                                  data={val}
                                />
                              ))}
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Empty state */}
      {!loading && flights.length === 0 && !error && (
        <div className="rounded-lg border border-gray-200 bg-white p-12 text-center">
          <p className="text-gray-400 text-sm">No flights found. Adjust the date range and try again.</p>
        </div>
      )}
    </div>
  );
}
