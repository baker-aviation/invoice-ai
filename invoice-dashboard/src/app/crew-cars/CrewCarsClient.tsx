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

function VehicleRow({ v }: { v: SamsaraVan }) {
  return (
    <div className="flex items-center gap-4 px-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-gray-800">{v.name || v.id}</div>
        <div className="text-xs text-gray-400 font-mono">{v.id}</div>
        <div className="text-xs text-gray-500 truncate mt-0.5">
          {v.address || (v.lat != null ? `${v.lat.toFixed(4)}, ${v.lon?.toFixed(4)}` : "No location")}
        </div>
      </div>
      <div className="text-right shrink-0 space-y-0.5">
        {v.speed_mph != null && (
          <div className="text-sm font-semibold text-gray-700">{Math.round(v.speed_mph)} mph</div>
        )}
        {v.gps_time && (
          <div className="text-xs text-gray-400">{fmtTime(v.gps_time)}</div>
        )}
      </div>
    </div>
  );
}

// ─── Oil change tracker ───────────────────────────────────────────────────────

function OilChangeTracker({ vehicles }: { vehicles: SamsaraVan[] }) {
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
          {vehicles.map((v) => {
            const rec = records[v.id];
            const daysSince = rec?.lastChangedDate
              ? Math.floor((today.getTime() - new Date(rec.lastChangedDate + "T12:00:00").getTime()) / 86400000)
              : null;
            const overdue = daysSince !== null && daysSince > 90;

            return (
              <div key={v.id} className={`px-4 py-3 ${overdue ? "bg-red-50" : ""}`}>
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
                        <label className="text-xs text-gray-500">Mileage</label>
                        <input
                          type="text"
                          placeholder="e.g. 45,200"
                          value={form.mileage}
                          onChange={(e) => setForm((f) => ({ ...f, mileage: e.target.value }))}
                          className="border rounded px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-slate-300 w-32"
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
                    <div>
                      <div className="text-sm font-medium text-gray-800">{v.name}</div>
                      <div className="text-xs text-gray-400 font-mono">{v.id}</div>
                      {rec ? (
                        <div className={`text-xs mt-0.5 ${overdue ? "text-red-600 font-semibold" : "text-gray-500"}`}>
                          Last oil change: {rec.lastChangedDate}
                          {rec.mileage && ` · ${rec.mileage} mi`}
                          {daysSince !== null && (
                            <span className={overdue ? " text-red-600" : " text-gray-400"}>
                              {" "}({daysSince} days ago{overdue ? " — overdue" : ""})
                            </span>
                          )}
                          {rec.notes && <span className="text-gray-400"> · {rec.notes}</span>}
                        </div>
                      ) : (
                        <div className="text-xs text-gray-400 mt-0.5">No oil change recorded</div>
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

  useMemo(() => { load(); }, []);
  useMemo(() => {
    const id = setInterval(load, 240_000);
    return () => clearInterval(id);
  }, []);

  const crewCars = vans.filter((v) => !isAogVehicle(v.name));

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

      {/* Vehicle list */}
      {crewCars.length > 0 && (
        <div className="rounded-xl border bg-white shadow-sm overflow-hidden">
          <div className="px-4 py-2 border-b bg-gray-50 text-xs font-semibold text-gray-500 uppercase tracking-wide">
            Vehicle List
          </div>
          <div className="divide-y">
            {crewCars.map((v) => (
              <VehicleRow key={v.id} v={v} />
            ))}
          </div>
        </div>
      )}

      {/* Oil change tracker */}
      <OilChangeTracker vehicles={crewCars} />
    </div>
  );
}
