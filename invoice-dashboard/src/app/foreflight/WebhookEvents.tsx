"use client";

import { useState, useCallback, useEffect } from "react";

interface WebhookEvent {
  id: number;
  flight_id: string;
  change_type: string;
  changed_fields: string[];
  flight_data: Record<string, unknown> | null;
  processed: boolean;
  received_at: string;
}

function fmtTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString("en-US", {
      month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit",
      hour12: false, timeZoneName: "short",
    });
  } catch { return iso; }
}

function changeTypeBadge(type: string) {
  const styles: Record<string, string> = {
    FlightCreated: "bg-green-100 text-green-700",
    FlightDeleted: "bg-red-100 text-red-700",
    FlightReleased: "bg-blue-100 text-blue-700",
    Filing: "bg-purple-100 text-purple-700",
    Flight: "bg-amber-100 text-amber-700",
  };
  return (
    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${styles[type] ?? "bg-gray-100 text-gray-600"}`}>
      {type}
    </span>
  );
}

export default function WebhookEvents() {
  const [events, setEvents] = useState<WebhookEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [limit, setLimit] = useState(50);

  const fetchEvents = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/foreflight/webhook?limit=${limit}`);
      const data = await res.json();
      if (!res.ok) { setError(data.error ?? `HTTP ${res.status}`); return; }
      setEvents(data.events ?? []);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, [limit]);

  useEffect(() => { fetchEvents(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="px-6 py-6 space-y-4 max-w-7xl mx-auto">
      {/* Header */}
      <div className="rounded-lg border border-gray-200 bg-white p-5">
        <div className="flex items-center justify-between mb-1">
          <h2 className="text-lg font-semibold text-gray-900">Webhook Events</h2>
          <div className="flex items-center gap-2">
            <select
              value={limit}
              onChange={e => setLimit(Number(e.target.value))}
              className="rounded-md border border-gray-300 px-2 py-1.5 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            >
              <option value={25}>Last 25</option>
              <option value={50}>Last 50</option>
              <option value={100}>Last 100</option>
            </select>
            <button
              onClick={fetchEvents}
              disabled={loading}
              className="px-4 py-1.5 bg-blue-600 text-white text-sm font-medium rounded-md hover:bg-blue-500 disabled:opacity-50 transition-colors"
            >
              {loading ? "Loading..." : "Refresh"}
            </button>
          </div>
        </div>
        <p className="text-sm text-gray-500">
          Real-time events from ForeFlight Dispatch. Each event auto-fetches the full flight detail.
        </p>
        {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
      </div>

      {/* Events */}
      {events.length > 0 ? (
        <div className="rounded-lg border border-gray-200 bg-white overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-gray-500 border-b border-gray-200 bg-gray-50">
                  <th className="py-2.5 px-3 font-medium">Time</th>
                  <th className="py-2.5 px-3 font-medium">Event</th>
                  <th className="py-2.5 px-3 font-medium">Tail</th>
                  <th className="py-2.5 px-3 font-medium">Route</th>
                  <th className="py-2.5 px-3 font-medium">Changed</th>
                  <th className="py-2.5 px-1 font-medium w-8"></th>
                </tr>
              </thead>
              <tbody>
                {events.map(ev => {
                  const isExpanded = expandedId === ev.id;
                  // Modified endpoint stores data at top level; webhook stores under flightData
                  const raw = ev.flight_data ?? {};
                  const fd = (raw.flightData ?? raw) as Record<string, unknown>;
                  const perf = (raw.performance ?? {}) as Record<string, unknown>;
                  const tail = (fd.aircraftRegistration ?? "") as string;
                  const dep = (fd.departure ?? "") as string;
                  const dest = (fd.destination ?? "") as string;
                  const fuel = perf?.fuel as Record<string, unknown> | undefined;
                  const times = perf?.times as Record<string, unknown> | undefined;
                  const crew = (fd.crew ?? []) as Array<{ position: string; crewId: string }>;
                  const filingInfo = (fd.filingInfo ?? raw.filingInfo ?? {}) as Record<string, unknown>;

                  return (
                    <tr key={ev.id} className="border-b border-gray-100">
                      <td className="py-2.5 px-3 text-gray-500 whitespace-nowrap text-xs">{fmtTime(ev.received_at)}</td>
                      <td className="py-2.5 px-3">{changeTypeBadge(ev.change_type)}</td>
                      <td className="py-2.5 px-3 font-mono font-semibold">{tail || "—"}</td>
                      <td className="py-2.5 px-3">
                        {dep && dest ? (
                          <>
                            <span className="font-mono">{dep}</span>
                            <span className="text-gray-400 mx-1">→</span>
                            <span className="font-mono">{dest}</span>
                          </>
                        ) : ev.change_type === "FlightDeleted" ? (
                          <span className="text-xs text-gray-400 italic">deleted</span>
                        ) : "—"}
                      </td>
                      <td className="py-2.5 px-3">
                        {ev.changed_fields.length > 0 ? (
                          <div className="flex flex-wrap gap-1">
                            {ev.changed_fields.slice(0, 4).map((f, i) => (
                              <span key={i} className="px-1.5 py-0.5 bg-gray-100 rounded text-xs text-gray-600">{f}</span>
                            ))}
                            {ev.changed_fields.length > 4 && (
                              <span className="text-xs text-gray-400">+{ev.changed_fields.length - 4}</span>
                            )}
                          </div>
                        ) : "—"}
                      </td>
                      <td className="py-2.5 px-1">
                        <button
                          onClick={() => setExpandedId(isExpanded ? null : ev.id)}
                          className="text-gray-400 hover:text-gray-600"
                        >
                          <svg className={`w-4 h-4 transition-transform ${isExpanded ? "rotate-180" : ""}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                          </svg>
                        </button>
                      </td>
                      {isExpanded && (
                        <td colSpan={6} className="p-0">
                          <div className="bg-gray-50 border-t border-gray-200 p-4 space-y-3">
                            {/* Quick info */}
                            {fd && (
                              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
                                {tail && <div><span className="text-xs text-gray-400">Tail</span><div className="font-mono font-semibold">{tail}</div></div>}
                                {(fd.callsign as string) && <div><span className="text-xs text-gray-400">Callsign</span><div className="font-mono">{fd.callsign as string}</div></div>}
                                {crew.length > 0 && (
                                  <div>
                                    <span className="text-xs text-gray-400">Crew</span>
                                    <div className="text-xs">
                                      {crew.map(c => `${c.position}: ${(c.crewId as string).split("@")[0]}`).join(", ")}
                                    </div>
                                  </div>
                                )}
                                {(fd.tripId as string) && <div><span className="text-xs text-gray-400">Trip</span><div className="font-mono text-xs">{fd.tripId as string}</div></div>}
                              </div>
                            )}

                            {/* Performance summary */}
                            {fuel && times && (
                              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
                                <div><span className="text-xs text-gray-400">ETE</span><div className="font-mono">{Math.floor((times.timeToDestinationMinutes as number) / 60)}h {Math.round((times.timeToDestinationMinutes as number) % 60)}m</div></div>
                                <div><span className="text-xs text-gray-400">Total Fuel</span><div className="font-mono">{(fuel.totalFuel as number)?.toLocaleString()} lb</div></div>
                                <div><span className="text-xs text-gray-400">Landing Fuel</span><div className="font-mono">{(fuel.landingFuel as number)?.toLocaleString()} lb</div></div>
                                <div><span className="text-xs text-gray-400">Distance</span><div className="font-mono">{((perf?.distances as Record<string, unknown>)?.destination as number)?.toLocaleString(undefined, { maximumFractionDigits: 1 })} NM</div></div>
                              </div>
                            )}

                            {/* ATC Messages if Filing event */}
                            {ev.change_type === "Filing" && filingInfo && (
                              <div>
                                <span className="text-xs text-gray-400 block mb-1">ATC Messages</span>
                                <div className="space-y-1">
                                  {((filingInfo.atcMessages ?? []) as Array<{ type: string; sender: string; content: string; timestamp: string }>).map((msg, i) => (
                                    <div key={i} className={`rounded border p-2 text-xs ${
                                      msg.type === "ACK" ? "border-green-200 bg-green-50" :
                                      msg.type === "FPL" ? "border-blue-200 bg-blue-50" :
                                      msg.type === "CNL" ? "border-red-200 bg-red-50" :
                                      "border-gray-200 bg-gray-50"
                                    }`}>
                                      <div className="flex items-center gap-2 mb-1">
                                        <span className={`px-1.5 py-0.5 rounded text-xs font-bold ${
                                          msg.type === "ACK" ? "bg-green-200 text-green-800" :
                                          msg.type === "FPL" ? "bg-blue-200 text-blue-800" :
                                          msg.type === "CNL" ? "bg-red-200 text-red-800" :
                                          "bg-gray-200 text-gray-800"
                                        }`}>{msg.type}</span>
                                        <span className="text-gray-500 font-mono">{msg.sender}</span>
                                        <span className="text-gray-400 ml-auto">{fmtTime(msg.timestamp)}</span>
                                      </div>
                                      <pre className="font-mono text-gray-700 whitespace-pre-wrap">{msg.content}</pre>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            )}

                            {/* Flight ID */}
                            <div className="text-xs text-gray-400 font-mono">Flight ID: {ev.flight_id}</div>

                            {/* Raw JSON */}
                            <details className="text-xs">
                              <summary className="cursor-pointer text-blue-600 hover:text-blue-800 font-medium">Show Raw JSON</summary>
                              <pre className="mt-2 rounded border border-gray-200 bg-white p-3 font-mono text-gray-700 overflow-x-auto max-h-[400px] overflow-y-auto">
                                {JSON.stringify(ev.flight_data, null, 2)}
                              </pre>
                            </details>
                          </div>
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ) : !loading && !error ? (
        <div className="rounded-lg border border-gray-200 bg-white p-12 text-center">
          <p className="text-gray-400 text-sm">No webhook events yet. Events will appear here when flights are created, changed, or filed in ForeFlight Dispatch.</p>
        </div>
      ) : null}
    </div>
  );
}
