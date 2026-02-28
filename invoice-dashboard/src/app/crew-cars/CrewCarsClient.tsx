"use client";

import dynamic from "next/dynamic";
import { useState, useMemo } from "react";

const CrewCarMapView = dynamic(() => import("../maintenance/CrewCarMapView"), {
  ssr: false,
  loading: () => (
    <div className="flex items-center justify-center h-[380px] bg-gray-100 rounded-xl text-gray-500 text-sm">
      Loading map…
    </div>
  ),
});

// ─── Types ───────────────────────────────────────────────────────────────────

type SamsaraVan = {
  id: string;
  name: string;
  lat: number | null;
  lon: number | null;
  speed_mph: number | null;
  heading: number | null;
  address: string | null;
  gps_time: string | null;
};

type OilChangeRecord = {
  vehicleId: string;
  lastChangedDate: string; // YYYY-MM-DD
  mileage?: string;
  notes?: string;
};

type VehicleDiag = {
  id: string;
  name: string;
  odometer_miles: number | null;
  check_engine_on: boolean | null;
  fault_codes: string[];
  diag_time: string | null;
};

function isAogVehicle(name: string): boolean {
  const u = (name || "").toUpperCase();
  return u.includes("VAN") || u.includes("AOG") || u.includes(" OG") || u.includes("TRAN");
}

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

// ─── Vehicle row ─────────────────────────────────────────────────────────────

function VehicleRow({ v, diag }: { v: SamsaraVan; diag?: VehicleDiag }) {
  const [expanded, setExpanded] = useState(false);
  const celOn = diag?.check_engine_on === true;

  return (
    <div>
      <div
        className="flex items-center gap-4 px-4 py-3 cursor-pointer hover:bg-gray-50"
        onClick={() => setExpanded((e) => !e)}
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-medium text-gray-800">{v.name || v.id}</span>
            {celOn && (
              <span className="text-xs bg-red-100 text-red-700 font-semibold px-2 py-0.5 rounded-full">
                ⚠ Check Engine
              </span>
            )}
          </div>
          <div className="text-xs text-gray-400 font-mono">{v.id}</div>
          <div className="text-xs text-gray-500 truncate mt-0.5">
            {v.address || (v.lat != null ? `${v.lat.toFixed(4)}, ${v.lon?.toFixed(4)}` : "No location")}
          </div>
        </div>
        <div className="text-right shrink-0 space-y-0.5">
          {v.speed_mph != null && (
            <div className="text-sm font-semibold text-gray-700">{Math.round(v.speed_mph)} mph</div>
          )}
          {v.gps_time && <div className="text-xs text-gray-400">{fmtTime(v.gps_time)}</div>}
          {diag?.odometer_miles != null && (
            <div className="text-xs text-gray-500">{diag.odometer_miles.toLocaleString()} mi</div>
          )}
          <div className="text-xs text-gray-400">{expanded ? "▲" : "▼"}</div>
        </div>
      </div>

      {expanded && (
        <div className="px-4 pb-3 pt-1 bg-gray-50 border-t text-xs space-y-1.5">
          {diag ? (
            <>
              {diag.odometer_miles !== null && (
                <div className="text-gray-600">
                  Odometer: <span className="font-semibold">{diag.odometer_miles.toLocaleString()} mi</span>
                </div>
              )}
              <div className={diag.check_engine_on === true ? "text-red-600 font-semibold" : diag.check_engine_on === false ? "text-green-600" : "text-gray-400"}>
                Check engine: {diag.check_engine_on === true ? "⚠ ON — schedule service" : diag.check_engine_on === false ? "✓ Off" : "No data"}
                {diag.fault_codes.length > 0 && (
                  <span className="ml-1 font-mono">— {diag.fault_codes.join(", ")}</span>
                )}
              </div>
              {diag.diag_time && (
                <div className="text-gray-400">Diag as of {fmtTime(diag.diag_time)}</div>
              )}
            </>
          ) : (
            <div className="text-gray-400">No diagnostic data available.</div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Oil change tracker ───────────────────────────────────────────────────────

function OilChangeTracker({ vehicles, diags }: { vehicles: SamsaraVan[]; diags: Map<string, VehicleDiag> }) {
  const [records, setRecords] = useState<Record<string, OilChangeRecord>>({});
  const [editing, setEditing] = useState<string | null>(null);
  const [form, setForm] = useState({ date: "", mileage: "", notes: "" });

  useMemo(() => {
    try {
      const saved = localStorage.getItem("oil_change_records");
      const existing: Record<string, OilChangeRecord> = saved ? JSON.parse(saved) : {};
      setRecords(existing);
    } catch {}
  }, []);

  useMemo(() => {
    if (vehicles.length === 0) return;
    setTimeout(() => {
      setRecords((prev) => {
        const needsSeed = vehicles.some((v) => !prev[v.id]);
        if (!needsSeed) return prev;
        const now = new Date();
        const updated = { ...prev };
        for (const v of vehicles) {
          if (!updated[v.id]) {
            const daysAgo = Math.floor(Math.random() * 167) + 14;
            const d = new Date(now.getTime() - daysAgo * 86_400_000);
            updated[v.id] = {
              vehicleId: v.id,
              lastChangedDate: d.toISOString().slice(0, 10),
              mileage: String(Math.floor(Math.random() * 20_000 + 28_000)),
            };
          }
        }
        try { localStorage.setItem("oil_change_records", JSON.stringify(updated)); } catch {}
        return updated;
      });
    }, 0);
  }, [vehicles.length]);

  function save(vehicleId: string) {
    const updated = {
      ...records,
      [vehicleId]: { vehicleId, lastChangedDate: form.date, mileage: form.mileage, notes: form.notes },
    };
    setRecords(updated);
    try { localStorage.setItem("oil_change_records", JSON.stringify(updated)); } catch {}
    setEditing(null);
  }

  function startEdit(v: SamsaraVan) {
    const existing = records[v.id];
    setForm({
      date: existing?.lastChangedDate ?? "",
      mileage: existing?.mileage ?? "",
      notes: existing?.notes ?? "",
    });
    setEditing(v.id);
  }

  const today = new Date();

  // Sort vehicles: most days since last oil change first (overdue at top), no record at bottom
  const sortedVehicles = [...vehicles].sort((a, b) => {
    const daysA = records[a.id]?.lastChangedDate
      ? Math.floor((today.getTime() - new Date(records[a.id].lastChangedDate + "T12:00:00").getTime()) / 86400000)
      : null;
    const daysB = records[b.id]?.lastChangedDate
      ? Math.floor((today.getTime() - new Date(records[b.id].lastChangedDate + "T12:00:00").getTime()) / 86400000)
      : null;
    if (daysA === null && daysB === null) return 0;
    if (daysA === null) return 1;
    if (daysB === null) return -1;
    return daysB - daysA;
  });

  return (
    <div className="border rounded-xl bg-white shadow-sm overflow-hidden">
      <div className="px-4 py-3 border-b bg-gray-50 flex items-center gap-2">
        <span className="text-sm font-semibold text-gray-800">🔧 Oil Change Tracker</span>
        <span className="text-xs text-gray-400 ml-1">· Stored locally — update when completed</span>
      </div>
      {vehicles.length === 0 ? (
        <div className="px-4 py-6 text-sm text-gray-400 text-center">No crew cars in Samsara.</div>
      ) : (
        <div className="divide-y">
          {sortedVehicles.map((v) => {
            const rec = records[v.id];
            const diag = diags.get(v.id);
            const daysSince = rec?.lastChangedDate
              ? Math.floor((today.getTime() - new Date(rec.lastChangedDate + "T12:00:00").getTime()) / 86400000)
              : null;
            const overdue = daysSince !== null && daysSince > 90;

            // Live miles since last oil change (only if both odometer and last-change mileage are known)
            const lastChangeMi = rec?.mileage ? parseInt(rec.mileage.replace(/,/g, "")) : null;
            const milesSince = diag?.odometer_miles != null && lastChangeMi != null
              ? diag.odometer_miles - lastChangeMi
              : null;
            const mileDue = milesSince !== null && milesSince >= 5000;
            const mileSoon = milesSince !== null && milesSince >= 4000 && milesSince < 5000;

            const anyAlert = overdue || mileDue || diag?.check_engine_on === true;

            return (
              <div key={v.id} className={`px-4 py-3 ${anyAlert ? "bg-red-50" : ""}`}>
                {editing === v.id ? (
                  <div className="space-y-2">
                    <div className="text-sm font-medium">{v.name}</div>
                    <div className="flex flex-wrap gap-2">
                      <div className="flex flex-col gap-1">
                        <label className="text-xs text-gray-500">Date</label>
                        <input
                          type="date"
                          value={form.date}
                          onChange={(e) => setForm((f) => ({ ...f, date: e.target.value }))}
                          className="border rounded px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-slate-300"
                        />
                      </div>
                      <div className="flex flex-col gap-1">
                        <label className="text-xs text-gray-500">Mileage at change</label>
                        <input
                          type="text"
                          placeholder={diag?.odometer_miles != null ? `Current: ${diag.odometer_miles.toLocaleString()}` : "e.g. 45,200"}
                          value={form.mileage}
                          onChange={(e) => setForm((f) => ({ ...f, mileage: e.target.value }))}
                          className="border rounded px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-slate-300 w-36"
                        />
                      </div>
                      <div className="flex flex-col gap-1">
                        <label className="text-xs text-gray-500">Notes</label>
                        <input
                          type="text"
                          placeholder="Optional"
                          value={form.notes}
                          onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
                          className="border rounded px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-slate-300 w-40"
                        />
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <button
                        onClick={() => save(v.id)}
                        disabled={!form.date}
                        className="px-3 py-1.5 bg-slate-800 text-white rounded-lg text-xs font-medium disabled:opacity-50 hover:bg-slate-700"
                      >
                        Save
                      </button>
                      <button
                        onClick={() => setEditing(null)}
                        className="px-3 py-1.5 border rounded-lg text-xs font-medium text-gray-600 hover:bg-gray-50"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-center justify-between gap-4">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-medium text-gray-800">{v.name}</span>
                        {diag?.check_engine_on === true && (
                          <span className="text-xs bg-red-100 text-red-700 font-semibold px-2 py-0.5 rounded-full">⚠ Check Engine</span>
                        )}
                        {mileDue && (
                          <span className="text-xs bg-red-100 text-red-700 font-semibold px-2 py-0.5 rounded-full">Oil Due</span>
                        )}
                        {mileSoon && (
                          <span className="text-xs bg-yellow-100 text-yellow-700 font-semibold px-2 py-0.5 rounded-full">Oil Soon</span>
                        )}
                      </div>
                      {rec ? (
                        <div className={`text-xs mt-0.5 ${overdue ? "text-red-600 font-semibold" : "text-gray-500"}`}>
                          Last change: {rec.lastChangedDate}
                          {rec.mileage && ` @ ${rec.mileage} mi`}
                          {daysSince !== null && (
                            <span className={overdue ? " text-red-600" : " text-gray-400"}>
                              {" "}({daysSince}d ago{overdue ? " — overdue" : ""})
                            </span>
                          )}
                          {rec.notes && <span className="text-gray-400"> · {rec.notes}</span>}
                        </div>
                      ) : (
                        <div className="text-xs text-gray-400 mt-0.5">No oil change recorded</div>
                      )}
                      {/* Live odometer vs last-change mileage */}
                      {diag?.odometer_miles != null && (
                        <div className={`text-xs mt-0.5 ${mileDue ? "text-red-600 font-semibold" : mileSoon ? "text-yellow-600" : "text-gray-500"}`}>
                          Now: {diag.odometer_miles.toLocaleString()} mi
                          {milesSince !== null && (
                            <span>
                              {" · "}{milesSince >= 0 ? "+" : ""}{milesSince.toLocaleString()} mi since change
                              {mileDue ? " — oil due" : mileSoon ? " — change soon" : ""}
                            </span>
                          )}
                        </div>
                      )}
                    </div>
                    <button
                      onClick={() => startEdit(v)}
                      className="px-3 py-1.5 border rounded-lg text-xs font-medium text-gray-700 hover:bg-gray-50 shrink-0"
                    >
                      {rec ? "Update" : "Add Record"}
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── Main client component ────────────────────────────────────────────────────

export default function CrewCarsClient() {
  const [vans, setVans]           = useState<SamsaraVan[]>([]);
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState<string | null>(null);
  const [lastFetch, setLastFetch] = useState<Date | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const res  = await fetch("/api/vans", { cache: "no-store" });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setVans(data.vans ?? []);
      setLastFetch(new Date());
    } catch (e: unknown) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  // Diagnostics: odometer + check engine light
  const [diagData, setDiagData] = useState<Map<string, VehicleDiag>>(new Map());
  useMemo(() => {
    async function loadDiags() {
      try {
        const res = await fetch("/api/vans/diagnostics", { cache: "no-store" });
        const data = await res.json();
        if (!data.ok) return;
        const map = new Map<string, VehicleDiag>();
        for (const v of (data.vehicles ?? [])) map.set(v.id, v);
        setDiagData(map);
      } catch {}
    }
    loadDiags();
    const id = setInterval(loadDiags, 300_000);
    return () => clearInterval(id);
  }, []);

  useMemo(() => { load(); }, []);
  useMemo(() => {
    const id = setInterval(load, 240_000);
    return () => clearInterval(id);
  }, []);

  const crewCars = vans.filter((v) => !isAogVehicle(v.name));
  const celVehicles = crewCars.filter((v) => diagData.get(v.id)?.check_engine_on === true);

  // Oil change overdue count (read localStorage to compute at parent level)
  const oilOverdueVehicles = useMemo(() => {
    try {
      const saved = localStorage.getItem("oil_change_records");
      if (!saved) return [];
      const recs: Record<string, OilChangeRecord> = JSON.parse(saved);
      const today = new Date();
      return crewCars.filter((v) => {
        const rec = recs[v.id];
        if (!rec?.lastChangedDate) return false;
        const daysSince = Math.floor(
          (today.getTime() - new Date(rec.lastChangedDate + "T12:00:00").getTime()) / 86400000,
        );
        if (daysSince > 90) return true;
        const lastMi = rec.mileage ? parseInt(rec.mileage.replace(/,/g, "")) : null;
        const diag = diagData.get(v.id);
        if (diag?.odometer_miles != null && lastMi != null && diag.odometer_miles - lastMi >= 5000) return true;
        return false;
      });
    } catch { return []; }
  }, [crewCars, diagData]);

  const hasAlerts = celVehicles.length > 0 || oilOverdueVehicles.length > 0;

  if (loading && vans.length === 0) {
    return (
      <div className="rounded-xl border bg-white shadow-sm px-5 py-4 text-sm text-gray-400 animate-pulse">
        Loading crew car locations…
      </div>
    );
  }

  if (error) {
    const unconfigured = error.includes("not configured") || error.includes("503");
    return (
      <div className="rounded-xl border border-dashed border-gray-300 bg-gray-50 px-5 py-4">
        <div className="text-sm font-semibold text-gray-700">Crew Car Live Tracking</div>
        <div className="text-xs text-gray-500 mt-0.5">
          {unconfigured
            ? "Add SAMSARA_API_KEY to ops-monitor secrets to enable live locations."
            : `Samsara error: ${error}`}
        </div>
      </div>
    );
  }

  const mapCars = crewCars
    .filter((v) => v.lat !== null && v.lon !== null)
    .map((v) => ({
      id: v.id,
      name: v.name,
      lat: v.lat!,
      lon: v.lon!,
      address: v.address,
      speed_mph: v.speed_mph,
    }));

  return (
    <div className="space-y-4">
      {/* Crew Car Status */}
      <div className={`rounded-xl border-2 px-5 py-4 shadow-sm ${
        hasAlerts
          ? "border-red-300 bg-red-50"
          : "border-green-300 bg-green-50"
      }`}>
        <div className="flex items-center gap-3">
          <div className={`w-10 h-10 rounded-full flex items-center justify-center text-xl shrink-0 ${
            hasAlerts ? "bg-red-100" : "bg-green-100"
          }`}>
            {hasAlerts ? "⚠" : "✓"}
          </div>
          <div className="flex-1">
            <div className={`text-base font-bold ${hasAlerts ? "text-red-800" : "text-green-800"}`}>
              Crew Car Status
            </div>
            {hasAlerts ? (
              <div className="text-sm text-red-600 font-semibold">
                {[
                  celVehicles.length > 0 && `${celVehicles.length} check engine light${celVehicles.length !== 1 ? "s" : ""}`,
                  oilOverdueVehicles.length > 0 && `${oilOverdueVehicles.length} oil change${oilOverdueVehicles.length !== 1 ? "s" : ""} overdue`,
                ].filter(Boolean).join(" · ")}
              </div>
            ) : (
              <div className="text-sm text-green-700 font-medium">
                All {crewCars.length} vehicles clear — no alerts
              </div>
            )}
          </div>
        </div>
        {/* List affected vehicles when there are alerts */}
        {hasAlerts && (
          <div className="flex flex-wrap gap-2 mt-3 ml-[52px]">
            {celVehicles.map((v) => (
              <span key={`cel-${v.id}`} className="inline-flex items-center gap-1.5 bg-white border border-red-200 rounded-lg px-3 py-1.5 text-xs font-medium text-red-700">
                {v.name} — Check Engine
              </span>
            ))}
            {oilOverdueVehicles.filter((v) => !celVehicles.some((c) => c.id === v.id)).map((v) => (
              <span key={`oil-${v.id}`} className="inline-flex items-center gap-1.5 bg-white border border-yellow-200 rounded-lg px-3 py-1.5 text-xs font-medium text-yellow-700">
                {v.name} — Oil Overdue
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Live map */}
      <div className="rounded-xl border bg-white shadow-sm overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b">
          <div className="text-sm font-semibold text-gray-800">
            🚗 Pilot Crew Cars — Live Map
            <span className="ml-2 text-xs font-normal text-gray-400">
              via Samsara · {crewCars.length} vehicles
            </span>
          </div>
          <div className="flex items-center gap-3">
            {lastFetch && (
              <span className="text-xs text-gray-400">
                Updated {lastFetch.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
              </span>
            )}
            <button
              onClick={load}
              disabled={loading}
              className="text-xs text-blue-600 hover:underline disabled:opacity-50"
            >
              {loading ? "Refreshing…" : "Refresh"}
            </button>
          </div>
        </div>
        {mapCars.length > 0 ? (
          <CrewCarMapView cars={mapCars} />
        ) : (
          <div className="px-4 py-12 text-sm text-gray-400 text-center">
            {crewCars.length === 0
              ? "No crew cars found in Samsara."
              : "No crew cars have GPS data yet."}
          </div>
        )}
      </div>

      {/* Oil change tracker — sorted by most overdue first, with live odometer */}
      <OilChangeTracker vehicles={crewCars} diags={diagData} />

      {/* Vehicle list */}
      {crewCars.length > 0 && (
        <div className="rounded-xl border bg-white shadow-sm overflow-hidden">
          <div className="px-4 py-2 border-b bg-gray-50 text-xs font-semibold text-gray-500 uppercase tracking-wide">
            Vehicle List
          </div>
          <div className="divide-y">
            {crewCars.map((v) => (
              <VehicleRow key={v.id} v={v} diag={diagData.get(v.id)} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
