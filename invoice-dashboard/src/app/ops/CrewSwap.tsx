"use client";

import { useEffect, useMemo, useState, useCallback } from "react";
import type { Flight } from "@/lib/opsApi";

// ─── Crew Types ─────────────────────────────────────────────────────────────

type CrewMember = {
  id: string;
  name: string;
  role: "PIC" | "SIC";
  home_airports: string[];
  aircraft_types: string[];
  is_checkairman: boolean;
  is_skillbridge: boolean;
  priority: number;
  active: boolean;
  notes: string | null;
};

type RosterUploadResult = {
  ok: boolean;
  total_parsed: number;
  unique_crew: number;
  upserted: number;
  rotations_created: number;
  errors?: string[];
  summary: Record<string, number>;
};

// Optimizer result types (mirrors server types)
type ScoreBreakdown = {
  cost: number;
  reliability: number;
  convenience: number;
  compliance: number;
  fairness: number;
};

type TransportOption = {
  type: "commercial_flight" | "drive" | "positioning_flight";
  from: string;
  to: string;
  departure_time?: string;
  arrival_time?: string;
  duration_minutes: number;
  cost_estimate: number;
  details: string;
};

type SwapOption = {
  swap_airport: string;
  commercial_airport: string;
  is_live_leg_adjacent: boolean;
  gap_minutes: number;
  oncoming_transport: TransportOption[];
  offgoing_transport: TransportOption[];
  score: number;
  score_breakdown: ScoreBreakdown;
};

type TailSwapPlan = {
  tail_number: string;
  swap_date: string;
  aircraft_type: string | null;
  offgoing_pic: CrewMember | null;
  offgoing_sic: CrewMember | null;
  oncoming_pic: CrewMember | null;
  oncoming_sic: CrewMember | null;
  wednesday_legs: { departure_icao: string; arrival_icao: string; flight_type: string | null; scheduled_departure: string; scheduled_arrival: string | null }[];
  options: SwapOption[];
  warnings: string[];
};

type SwapPlanResult = {
  ok: boolean;
  swap_date: string;
  plans: TailSwapPlan[];
  unassigned_crew: CrewMember[];
  warnings: string[];
  commercial_flights_searched: number;
};

// ─── Types ──────────────────────────────────────────────────────────────────

type TailSchedule = {
  tail: string;
  flights: Flight[];
  currentPic: string | null;
  currentSic: string | null;
  // Wednesday legs for this tail
  wednesdayFlights: Flight[];
  // Best swap candidates: airports between live legs (not positioning)
  swapCandidates: SwapCandidate[];
  lastKnownAirport: string | null;
};

type SwapCandidate = {
  airport: string;
  beforeFlight: Flight | null; // the leg arriving at this airport
  afterFlight: Flight | null;  // the leg departing from this airport
  isLiveLeg: boolean;          // adjacent to a revenue/charter leg
  gapMinutes: number;          // time between arrival and next departure
};

// ─── Helpers ────────────────────────────────────────────────────────────────

function getNextWednesday(): Date {
  const now = new Date();
  const day = now.getDay();
  const daysUntilWed = (3 - day + 7) % 7 || 7;
  const wed = new Date(now);
  wed.setDate(now.getDate() + daysUntilWed);
  wed.setHours(0, 0, 0, 0);
  return wed;
}

function isWednesday(iso: string, targetWed: Date): boolean {
  const d = new Date(iso);
  return d.toISOString().slice(0, 10) === targetWed.toISOString().slice(0, 10);
}

function isLiveFlightType(type: string | null): boolean {
  if (!type) return false;
  const live = ["charter", "revenue", "owner"];
  return live.includes(type.toLowerCase());
}

function fmtTime(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

const FLIGHT_TYPE_COLORS: Record<string, string> = {
  Charter: "bg-blue-100 text-blue-700",
  Revenue: "bg-green-100 text-green-700",
  Positioning: "bg-amber-100 text-amber-700",
  Maintenance: "bg-purple-100 text-purple-700",
  Owner: "bg-emerald-100 text-emerald-700",
  "Ferry/Mx": "bg-gray-100 text-gray-700",
};

// ─── Component ──────────────────────────────────────────────────────────────

export default function CrewSwap({ flights }: { flights: Flight[] }) {
  const [selectedWed, setSelectedWed] = useState<Date>(getNextWednesday());
  const [crew, setCrew] = useState<CrewMember[]>([]);
  const [crewLoaded, setCrewLoaded] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadResult, setUploadResult] = useState<RosterUploadResult | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [showRoster, setShowRoster] = useState(false);
  const [optimizing, setOptimizing] = useState(false);
  const [swapPlan, setSwapPlan] = useState<SwapPlanResult | null>(null);
  const [optimizeError, setOptimizeError] = useState<string | null>(null);

  // Fetch crew roster
  const loadCrew = useCallback(async () => {
    try {
      const res = await fetch("/api/crew/roster");
      if (!res.ok) return;
      const data = await res.json();
      setCrew(data.crew ?? []);
      setCrewLoaded(true);
    } catch {
      // ignore
    }
  }, []);

  // Load crew on first render
  useEffect(() => {
    loadCrew();
  }, [loadCrew]);

  // Upload Excel roster
  async function handleUpload(file: File) {
    setUploading(true);
    setUploadError(null);
    setUploadResult(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/crew/roster", { method: "POST", body: fd });
      const data = await res.json();
      if (!res.ok) {
        setUploadError(data.error ?? "Upload failed");
      } else {
        setUploadResult(data);
        // Refresh crew list
        await loadCrew();
      }
    } catch (e) {
      setUploadError(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  }

  // Build per-tail schedule focused on the selected Wednesday
  const tailSchedules = useMemo(() => {
    // Group flights by tail
    const byTail = new Map<string, Flight[]>();
    for (const f of flights) {
      if (!f.tail_number) continue;
      if (!byTail.has(f.tail_number)) byTail.set(f.tail_number, []);
      byTail.get(f.tail_number)!.push(f);
    }

    const schedules: TailSchedule[] = [];

    for (const [tail, tailFlights] of byTail) {
      // Sort by departure time
      const sorted = [...tailFlights].sort(
        (a, b) => new Date(a.scheduled_departure).getTime() - new Date(b.scheduled_departure).getTime(),
      );

      // Get current crew from most recent flight with PIC/SIC
      let currentPic: string | null = null;
      let currentSic: string | null = null;
      const now = Date.now();
      for (const f of sorted) {
        if (new Date(f.scheduled_departure).getTime() <= now) {
          if (f.pic) currentPic = f.pic;
          if (f.sic) currentSic = f.sic;
        }
      }

      // Wednesday flights
      const wedFlights = sorted.filter((f) => isWednesday(f.scheduled_departure, selectedWed));

      // Find swap candidates — airports between legs, preferring before/after live legs
      const swapCandidates: SwapCandidate[] = [];

      if (wedFlights.length === 0) {
        // No Wednesday legs — use last known position
        const lastFlight = sorted
          .filter((f) => new Date(f.scheduled_departure).getTime() < selectedWed.getTime())
          .pop();
        if (lastFlight?.arrival_icao) {
          swapCandidates.push({
            airport: lastFlight.arrival_icao,
            beforeFlight: null,
            afterFlight: null,
            isLiveLeg: false,
            gapMinutes: -1,
          });
        }
      } else {
        // Before first Wednesday leg
        swapCandidates.push({
          airport: wedFlights[0].departure_icao ?? "?",
          beforeFlight: null,
          afterFlight: wedFlights[0],
          isLiveLeg: isLiveFlightType(wedFlights[0].flight_type),
          gapMinutes: -1,
        });

        // Between Wednesday legs
        for (let i = 0; i < wedFlights.length - 1; i++) {
          const arriving = wedFlights[i];
          const departing = wedFlights[i + 1];
          const gap =
            (new Date(departing.scheduled_departure).getTime() -
              new Date(arriving.scheduled_arrival ?? arriving.scheduled_departure).getTime()) /
            60_000;
          const isLive =
            isLiveFlightType(arriving.flight_type) || isLiveFlightType(departing.flight_type);
          swapCandidates.push({
            airport: arriving.arrival_icao ?? "?",
            beforeFlight: arriving,
            afterFlight: departing,
            isLiveLeg: isLive,
            gapMinutes: Math.round(gap),
          });
        }

        // After last Wednesday leg
        const lastWed = wedFlights[wedFlights.length - 1];
        swapCandidates.push({
          airport: lastWed.arrival_icao ?? "?",
          beforeFlight: lastWed,
          afterFlight: null,
          isLiveLeg: isLiveFlightType(lastWed.flight_type),
          gapMinutes: -1,
        });
      }

      // Sort: live legs first, then by gap time
      swapCandidates.sort((a, b) => {
        if (a.isLiveLeg !== b.isLiveLeg) return a.isLiveLeg ? -1 : 1;
        return 0;
      });

      const lastKnown = sorted.filter((f) => f.arrival_icao).pop()?.arrival_icao ?? null;

      schedules.push({
        tail,
        flights: sorted,
        currentPic,
        currentSic,
        wednesdayFlights: wedFlights,
        swapCandidates,
        lastKnownAirport: lastKnown,
      });
    }

    return schedules.sort((a, b) => a.tail.localeCompare(b.tail));
  }, [flights, selectedWed]);

  // Detect crew changes: flights where PIC/SIC differs from previous flight on same tail
  const crewChanges = useMemo(() => {
    const changes: { tail: string; airport: string; oldPic: string | null; newPic: string | null; oldSic: string | null; newSic: string | null; flight: Flight }[] = [];
    for (const ts of tailSchedules) {
      for (const wf of ts.wednesdayFlights) {
        // Find the previous flight on this tail
        const idx = ts.flights.indexOf(wf);
        if (idx <= 0) continue;
        const prev = ts.flights[idx - 1];
        const picChanged = prev.pic && wf.pic && prev.pic !== wf.pic;
        const sicChanged = prev.sic && wf.sic && prev.sic !== wf.sic;
        if (picChanged || sicChanged) {
          changes.push({
            tail: ts.tail,
            airport: wf.departure_icao ?? "?",
            oldPic: prev.pic,
            newPic: wf.pic,
            oldSic: prev.sic,
            newSic: wf.sic,
            flight: wf,
          });
        }
      }
    }
    return changes;
  }, [tailSchedules]);

  // Run swap optimizer
  async function runOptimizer(includeFlights: boolean) {
    setOptimizing(true);
    setOptimizeError(null);
    try {
      const res = await fetch("/api/crew/optimize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          swap_date: selectedWed.toISOString().slice(0, 10),
          search_flights: includeFlights,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setOptimizeError(data.error ?? "Optimization failed");
      } else {
        setSwapPlan(data);
      }
    } catch (e) {
      setOptimizeError(e instanceof Error ? e.message : "Optimization failed");
    } finally {
      setOptimizing(false);
    }
  }

  // Navigate weeks
  function shiftWeek(delta: number) {
    setSelectedWed((prev) => {
      const next = new Date(prev);
      next.setDate(prev.getDate() + delta * 7);
      return next;
    });
  }

  return (
    <div className="space-y-6">
      {/* Header + Week Selector */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-bold text-gray-900">Crew Swap Planning</h2>
          <p className="text-sm text-gray-500">
            Wednesday swap day: {selectedWed.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric" })}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => shiftWeek(-1)} className="px-3 py-1.5 text-sm font-medium border rounded-lg hover:bg-gray-50">
            Prev Week
          </button>
          <button onClick={() => setSelectedWed(getNextWednesday())} className="px-3 py-1.5 text-sm font-medium border rounded-lg hover:bg-gray-50">
            Next Swap
          </button>
          <button onClick={() => shiftWeek(1)} className="px-3 py-1.5 text-sm font-medium border rounded-lg hover:bg-gray-50">
            Next Week
          </button>
        </div>
      </div>

      {/* Detected Crew Changes */}
      {crewChanges.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold text-gray-700 uppercase tracking-wider mb-2">
            Detected Crew Changes ({crewChanges.length})
          </h3>
          <div className="space-y-2">
            {crewChanges.map((c, i) => (
              <div key={i} className="rounded-lg border border-blue-200 bg-blue-50 p-3">
                <div className="flex items-center gap-3">
                  <span className="font-mono font-bold text-blue-900">{c.tail}</span>
                  <span className="text-sm text-blue-700">at {c.airport}</span>
                  <span className="text-xs text-blue-500">{fmtTime(c.flight.scheduled_departure)}</span>
                </div>
                <div className="mt-1 grid grid-cols-2 gap-4 text-sm">
                  <div>
                    <span className="text-red-600 font-medium">Off: </span>
                    <span>{c.oldPic ?? "—"} (PIC)</span>
                    {c.oldSic && <span className="ml-2 text-gray-500">/ {c.oldSic} (SIC)</span>}
                  </div>
                  <div>
                    <span className="text-green-600 font-medium">On: </span>
                    <span>{c.newPic ?? "—"} (PIC)</span>
                    {c.newSic && <span className="ml-2 text-gray-500">/ {c.newSic} (SIC)</span>}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Per-Tail Swap Overview */}
      <div>
        <h3 className="text-sm font-semibold text-gray-700 uppercase tracking-wider mb-2">
          Aircraft Schedule ({tailSchedules.length} tails)
        </h3>
        <div className="space-y-3">
          {tailSchedules.map((ts) => (
            <div key={ts.tail} className="rounded-lg border bg-white shadow-sm overflow-hidden">
              {/* Tail header */}
              <div className="px-4 py-2.5 bg-gray-50 border-b flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <span className="font-mono font-bold text-gray-900">{ts.tail}</span>
                  <div className="flex gap-2 text-xs text-gray-500">
                    {ts.currentPic && <span>PIC: <span className="text-gray-700 font-medium">{ts.currentPic}</span></span>}
                    {ts.currentSic && <span>SIC: <span className="text-gray-700 font-medium">{ts.currentSic}</span></span>}
                  </div>
                </div>
                <div className="text-xs text-gray-400">
                  {ts.wednesdayFlights.length} legs on Wed
                  {ts.wednesdayFlights.length === 0 && ts.lastKnownAirport && (
                    <span className="ml-2 text-amber-600">Last: {ts.lastKnownAirport}</span>
                  )}
                </div>
              </div>

              {/* Wednesday legs */}
              {ts.wednesdayFlights.length > 0 ? (
                <div className="divide-y">
                  {ts.wednesdayFlights.map((f) => {
                    const typeColor = FLIGHT_TYPE_COLORS[f.flight_type ?? ""] ?? "bg-gray-100 text-gray-600";
                    return (
                      <div key={f.id} className="px-4 py-2 flex items-center gap-4 text-sm">
                        <span className={`px-2 py-0.5 rounded text-xs font-medium ${typeColor}`}>
                          {f.flight_type ?? "—"}
                        </span>
                        <span className="font-mono text-gray-700">
                          {f.departure_icao} → {f.arrival_icao}
                        </span>
                        <span className="text-gray-500">{fmtTime(f.scheduled_departure)}</span>
                        <span className="text-gray-400">→</span>
                        <span className="text-gray-500">{fmtTime(f.scheduled_arrival)}</span>
                        {f.pic && (
                          <span className="text-xs text-gray-400 ml-auto">
                            {f.pic}{f.sic ? ` / ${f.sic}` : ""}
                          </span>
                        )}
                        {f.pax_count != null && f.pax_count > 0 && (
                          <span className="text-xs bg-gray-100 px-1.5 py-0.5 rounded text-gray-600">
                            {f.pax_count} pax
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="px-4 py-3 text-sm text-gray-400 italic">
                  No flights scheduled — aircraft at {ts.lastKnownAirport ?? "unknown"}
                </div>
              )}

              {/* Swap candidates */}
              {ts.swapCandidates.length > 0 && (
                <div className="px-4 py-2 bg-gray-50 border-t">
                  <div className="text-xs font-medium text-gray-500 mb-1">Swap candidates:</div>
                  <div className="flex flex-wrap gap-1.5">
                    {ts.swapCandidates.map((sc, i) => (
                      <span
                        key={i}
                        className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                          sc.isLiveLeg
                            ? "bg-green-100 text-green-700 ring-1 ring-green-300"
                            : "bg-gray-100 text-gray-600"
                        }`}
                        title={
                          sc.gapMinutes > 0
                            ? `${sc.gapMinutes}min gap`
                            : sc.beforeFlight === null
                              ? "Before first leg"
                              : "After last leg"
                        }
                      >
                        {sc.airport}
                        {sc.isLiveLeg && " *"}
                        {sc.gapMinutes > 0 && ` (${sc.gapMinutes}m)`}
                      </span>
                    ))}
                  </div>
                  <div className="text-[10px] text-gray-400 mt-1">* Adjacent to live leg (preferred)</div>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Crew Roster Section */}
      <div className="rounded-lg border bg-white shadow-sm overflow-hidden">
        <div className="px-4 py-3 bg-gray-50 border-b flex items-center justify-between">
          <h3 className="text-sm font-semibold text-gray-700 uppercase tracking-wider">
            Crew Roster {crewLoaded && `(${crew.length})`}
          </h3>
          <div className="flex items-center gap-2">
            {crew.length > 0 && (
              <button
                onClick={() => setShowRoster(!showRoster)}
                className="px-3 py-1.5 text-xs font-medium border rounded-lg hover:bg-gray-50"
              >
                {showRoster ? "Hide" : "Show"} Roster
              </button>
            )}
            <label className={`px-3 py-1.5 text-xs font-medium border rounded-lg cursor-pointer ${
              uploading ? "bg-gray-100 text-gray-400" : "bg-blue-50 text-blue-700 hover:bg-blue-100 border-blue-200"
            }`}>
              {uploading ? "Uploading..." : "Upload Roster (.xlsx)"}
              <input
                type="file"
                accept=".xlsx,.xls"
                className="hidden"
                disabled={uploading}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) handleUpload(f);
                  e.target.value = "";
                }}
              />
            </label>
          </div>
        </div>

        {/* Upload result */}
        {uploadResult && (
          <div className="px-4 py-3 bg-green-50 border-b border-green-200 text-sm">
            <span className="text-green-700 font-medium">Roster uploaded: </span>
            <span className="text-green-600">
              {uploadResult.total_parsed} parsed, {uploadResult.unique_crew} unique, {uploadResult.upserted} upserted
              {uploadResult.rotations_created > 0 && `, ${uploadResult.rotations_created} rotations`}
            </span>
            {uploadResult.summary && (
              <span className="text-green-500 ml-2 text-xs">
                (On-PIC: {uploadResult.summary.oncoming_pic ?? 0}, On-SIC: {uploadResult.summary.oncoming_sic ?? 0},
                 Off-PIC: {uploadResult.summary.offgoing_pic ?? 0}, Off-SIC: {uploadResult.summary.offgoing_sic ?? 0})
              </span>
            )}
            {uploadResult.errors && uploadResult.errors.length > 0 && (
              <div className="mt-1 text-xs text-red-600">
                Errors: {uploadResult.errors.join("; ")}
              </div>
            )}
          </div>
        )}
        {uploadError && (
          <div className="px-4 py-3 bg-red-50 border-b border-red-200 text-sm text-red-700">
            {uploadError}
          </div>
        )}

        {/* Roster table */}
        {showRoster && crew.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-left text-xs text-gray-500 uppercase tracking-wider">
                <tr>
                  <th className="px-4 py-2">Name</th>
                  <th className="px-4 py-2">Role</th>
                  <th className="px-4 py-2">Home</th>
                  <th className="px-4 py-2">Aircraft</th>
                  <th className="px-4 py-2">Flags</th>
                  <th className="px-4 py-2">Notes</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {crew.map((c) => (
                  <tr key={c.id} className="hover:bg-gray-50">
                    <td className="px-4 py-2 font-medium text-gray-900">{c.name}</td>
                    <td className="px-4 py-2">
                      <span className={`text-xs px-2 py-0.5 rounded font-medium ${
                        c.role === "PIC" ? "bg-blue-100 text-blue-700" : "bg-purple-100 text-purple-700"
                      }`}>
                        {c.role}
                      </span>
                    </td>
                    <td className="px-4 py-2 font-mono text-xs text-gray-600">
                      {c.home_airports.join(" / ")}
                    </td>
                    <td className="px-4 py-2 text-xs text-gray-600">
                      {c.aircraft_types.map((t) => (
                        <span key={t} className={`inline-block mr-1 px-1.5 py-0.5 rounded ${
                          t === "citation_x" ? "bg-green-100 text-green-700"
                            : t === "challenger" ? "bg-yellow-100 text-yellow-700"
                            : t === "dual" ? "bg-purple-100 text-purple-700"
                            : "bg-gray-100 text-gray-600"
                        }`}>
                          {t === "citation_x" ? "Cit X" : t === "challenger" ? "CL" : t === "dual" ? "Dual" : t}
                        </span>
                      ))}
                    </td>
                    <td className="px-4 py-2">
                      <div className="flex gap-1">
                        {c.is_checkairman && (
                          <span className="text-xs px-1.5 py-0.5 rounded bg-amber-100 text-amber-700">CA</span>
                        )}
                        {c.is_skillbridge && (
                          <span className="text-xs px-1.5 py-0.5 rounded bg-teal-100 text-teal-700">SB</span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-2 text-xs text-gray-400 max-w-[200px] truncate">
                      {c.notes ?? "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {!showRoster && crew.length === 0 && crewLoaded && (
          <div className="px-4 py-6 text-center text-sm text-gray-400">
            No crew roster loaded. Upload an Excel file to get started.
          </div>
        )}
      </div>

      {/* Swap Optimizer */}
      <div className="rounded-lg border bg-white shadow-sm overflow-hidden">
        <div className="px-4 py-3 bg-gray-50 border-b flex items-center justify-between">
          <h3 className="text-sm font-semibold text-gray-700 uppercase tracking-wider">
            Swap Optimizer
          </h3>
          <div className="flex items-center gap-2">
            <button
              onClick={() => runOptimizer(false)}
              disabled={optimizing}
              className={`px-3 py-1.5 text-xs font-medium border rounded-lg ${
                optimizing ? "bg-gray-100 text-gray-400" : "bg-green-50 text-green-700 hover:bg-green-100 border-green-200"
              }`}
            >
              {optimizing ? "Optimizing..." : "Optimize (Drive Only)"}
            </button>
            <button
              onClick={() => runOptimizer(true)}
              disabled={optimizing}
              className={`px-3 py-1.5 text-xs font-medium border rounded-lg ${
                optimizing ? "bg-gray-100 text-gray-400" : "bg-blue-50 text-blue-700 hover:bg-blue-100 border-blue-200"
              }`}
            >
              {optimizing ? "Searching..." : "Optimize + Flights (Amadeus)"}
            </button>
          </div>
        </div>

        {optimizeError && (
          <div className="px-4 py-3 bg-red-50 border-b border-red-200 text-sm text-red-700">
            {optimizeError}
          </div>
        )}

        {swapPlan && (
          <div className="divide-y">
            {/* Summary bar */}
            <div className="px-4 py-2 bg-green-50 text-sm text-green-700 flex items-center gap-4">
              <span className="font-medium">
                {swapPlan.plans.length} tails planned for {swapPlan.swap_date}
              </span>
              {swapPlan.commercial_flights_searched > 0 && (
                <span className="text-green-500 text-xs">
                  ({swapPlan.commercial_flights_searched} flight routes searched)
                </span>
              )}
              {swapPlan.unassigned_crew.length > 0 && (
                <span className="text-amber-600 text-xs">
                  {swapPlan.unassigned_crew.length} crew unassigned
                </span>
              )}
            </div>

            {/* Per-tail plans */}
            {swapPlan.plans.map((plan) => (
              <div key={plan.tail_number} className="px-4 py-3">
                {/* Tail header */}
                <div className="flex items-center gap-3 mb-2">
                  <span className="font-mono font-bold text-gray-900">{plan.tail_number}</span>
                  {plan.aircraft_type && (
                    <span className={`text-xs px-1.5 py-0.5 rounded ${
                      plan.aircraft_type === "citation_x" ? "bg-green-100 text-green-700"
                        : plan.aircraft_type === "challenger" ? "bg-yellow-100 text-yellow-700"
                        : "bg-purple-100 text-purple-700"
                    }`}>
                      {plan.aircraft_type === "citation_x" ? "Cit X" : plan.aircraft_type === "challenger" ? "CL" : plan.aircraft_type}
                    </span>
                  )}
                  <span className="text-xs text-gray-400">{plan.wednesday_legs.length} legs on Wed</span>
                </div>

                {/* Crew changeover */}
                <div className="grid grid-cols-2 gap-4 mb-3">
                  <div className="text-sm">
                    <span className="text-red-600 font-medium text-xs uppercase">Offgoing</span>
                    <div className="mt-0.5">
                      <span className="text-gray-700">{plan.offgoing_pic?.name ?? "—"}</span>
                      <span className="text-gray-400 text-xs ml-1">(PIC)</span>
                      {plan.offgoing_pic?.home_airports && (
                        <span className="text-gray-400 text-xs ml-1">
                          [{plan.offgoing_pic.home_airports.join("/")}]
                        </span>
                      )}
                      {plan.offgoing_sic && (
                        <>
                          <span className="text-gray-300 mx-1">/</span>
                          <span className="text-gray-700">{plan.offgoing_sic.name}</span>
                          <span className="text-gray-400 text-xs ml-1">(SIC)</span>
                          {plan.offgoing_sic.home_airports && (
                            <span className="text-gray-400 text-xs ml-1">
                              [{plan.offgoing_sic.home_airports.join("/")}]
                            </span>
                          )}
                        </>
                      )}
                    </div>
                  </div>
                  <div className="text-sm">
                    <span className="text-green-600 font-medium text-xs uppercase">Oncoming</span>
                    <div className="mt-0.5">
                      <span className="text-gray-700 font-medium">{plan.oncoming_pic?.name ?? "—"}</span>
                      <span className="text-gray-400 text-xs ml-1">(PIC)</span>
                      {plan.oncoming_pic?.home_airports && (
                        <span className="text-gray-400 text-xs ml-1">
                          [{plan.oncoming_pic.home_airports.join("/")}]
                        </span>
                      )}
                      {plan.oncoming_sic && (
                        <>
                          <span className="text-gray-300 mx-1">/</span>
                          <span className="text-gray-700 font-medium">{plan.oncoming_sic.name}</span>
                          <span className="text-gray-400 text-xs ml-1">(SIC)</span>
                          {plan.oncoming_sic.home_airports && (
                            <span className="text-gray-400 text-xs ml-1">
                              [{plan.oncoming_sic.home_airports.join("/")}]
                            </span>
                          )}
                        </>
                      )}
                    </div>
                  </div>
                </div>

                {/* Swap options (top 3) */}
                {plan.options.length > 0 && (
                  <div className="space-y-2">
                    <div className="text-xs font-medium text-gray-500 uppercase">Swap Options (ranked)</div>
                    {plan.options.slice(0, 3).map((opt, i) => (
                      <div
                        key={i}
                        className={`rounded-lg border p-3 text-sm ${
                          i === 0 ? "border-green-200 bg-green-50" : "border-gray-200 bg-gray-50"
                        }`}
                      >
                        <div className="flex items-center justify-between mb-1">
                          <div className="flex items-center gap-2">
                            <span className="font-mono font-bold">{opt.swap_airport}</span>
                            {opt.swap_airport !== opt.commercial_airport && (
                              <span className="text-xs text-gray-400">
                                (commercial: {opt.commercial_airport})
                              </span>
                            )}
                            {opt.is_live_leg_adjacent && (
                              <span className="text-xs px-1.5 py-0.5 rounded bg-green-100 text-green-700">
                                Live Leg
                              </span>
                            )}
                            {opt.gap_minutes > 0 && (
                              <span className="text-xs text-gray-400">{opt.gap_minutes}m gap</span>
                            )}
                          </div>
                          <div className="flex items-center gap-2">
                            <span className={`text-xs font-bold px-2 py-0.5 rounded ${
                              opt.score >= 70 ? "bg-green-100 text-green-700"
                                : opt.score >= 50 ? "bg-yellow-100 text-yellow-700"
                                : "bg-red-100 text-red-700"
                            }`}>
                              Score: {opt.score}
                            </span>
                          </div>
                        </div>

                        {/* Score breakdown */}
                        <div className="flex gap-3 text-[10px] text-gray-400 mb-2">
                          <span>Cost: {opt.score_breakdown.cost}</span>
                          <span>Reliability: {opt.score_breakdown.reliability}</span>
                          <span>Convenience: {opt.score_breakdown.convenience}</span>
                          <span>Compliance: {opt.score_breakdown.compliance}</span>
                        </div>

                        {/* Transport options */}
                        <div className="grid grid-cols-2 gap-3">
                          <div>
                            <div className="text-[10px] font-medium text-green-600 uppercase mb-1">Oncoming Transport</div>
                            {opt.oncoming_transport.length === 0 ? (
                              <div className="text-xs text-gray-400 italic">No options found</div>
                            ) : (
                              opt.oncoming_transport.map((t, j) => (
                                <div key={j} className="text-xs text-gray-600 flex items-center gap-1.5 mb-0.5">
                                  <span className={`px-1 py-0.5 rounded text-[10px] font-medium ${
                                    t.type === "commercial_flight" ? "bg-blue-100 text-blue-600"
                                      : t.type === "drive" ? "bg-amber-100 text-amber-600"
                                      : "bg-purple-100 text-purple-600"
                                  }`}>
                                    {t.type === "commercial_flight" ? "FLT" : t.type === "drive" ? "DRV" : "POS"}
                                  </span>
                                  <span>{t.details}</span>
                                  <span className="text-gray-400">${Math.round(t.cost_estimate)}</span>
                                </div>
                              ))
                            )}
                          </div>
                          <div>
                            <div className="text-[10px] font-medium text-red-600 uppercase mb-1">Offgoing Transport</div>
                            {opt.offgoing_transport.length === 0 ? (
                              <div className="text-xs text-gray-400 italic">No options found</div>
                            ) : (
                              opt.offgoing_transport.map((t, j) => (
                                <div key={j} className="text-xs text-gray-600 flex items-center gap-1.5 mb-0.5">
                                  <span className={`px-1 py-0.5 rounded text-[10px] font-medium ${
                                    t.type === "commercial_flight" ? "bg-blue-100 text-blue-600"
                                      : t.type === "drive" ? "bg-amber-100 text-amber-600"
                                      : "bg-purple-100 text-purple-600"
                                  }`}>
                                    {t.type === "commercial_flight" ? "FLT" : t.type === "drive" ? "DRV" : "POS"}
                                  </span>
                                  <span>{t.details}</span>
                                  <span className="text-gray-400">${Math.round(t.cost_estimate)}</span>
                                </div>
                              ))
                            )}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {/* Warnings */}
                {plan.warnings.length > 0 && (
                  <div className="mt-2 space-y-1">
                    {plan.warnings.map((w, i) => (
                      <div key={i} className="text-xs text-amber-600 bg-amber-50 px-2 py-1 rounded">
                        {w}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}

            {/* Unassigned crew */}
            {swapPlan.unassigned_crew.length > 0 && (
              <div className="px-4 py-3">
                <div className="text-xs font-medium text-gray-500 uppercase mb-2">
                  Unassigned Crew ({swapPlan.unassigned_crew.length})
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {swapPlan.unassigned_crew.map((c) => (
                    <span key={c.id} className="text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-600">
                      {c.name} ({c.role})
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {!swapPlan && !optimizeError && (
          <div className="px-4 py-6 text-center text-sm text-gray-400">
            Click optimize to generate swap recommendations for {selectedWed.toLocaleDateString(undefined, { month: "short", day: "numeric" })}
          </div>
        )}
      </div>
    </div>
  );
}
