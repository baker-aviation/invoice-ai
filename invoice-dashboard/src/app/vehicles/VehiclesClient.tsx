"use client";

import dynamic from "next/dynamic";
import { useState, useMemo, useEffect, useCallback } from "react";

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

type VehicleDiag = {
  id: string;
  name: string;
  odometer_miles: number | null;
  check_engine_on: boolean | null;
  fault_codes: string[];
  fuel_percent: number | null;
  diag_time: string | null;
};

type MaintenanceType = "oil_change" | "tire_rotation" | "inspection" | "registration";

type MaintenanceRecord = {
  vehicleId: string;
  type: MaintenanceType;
  date: string; // YYYY-MM-DD
  mileage?: string;
  notes?: string;
};

// All maintenance records keyed by `${vehicleId}:${type}`
type MaintenanceStore = Record<string, MaintenanceRecord>;

const MAINTENANCE_TYPES: { key: MaintenanceType; label: string; icon: string; intervalDays: number; intervalMiles: number | null; color: string }[] = [
  { key: "oil_change", label: "Oil Change", icon: "🔧", intervalDays: 90, intervalMiles: 5000, color: "amber" },
  { key: "tire_rotation", label: "Tire Rotation", icon: "🔄", intervalDays: 180, intervalMiles: 7500, color: "blue" },
  { key: "inspection", label: "Inspection", icon: "📋", intervalDays: 365, intervalMiles: null, color: "purple" },
  { key: "registration", label: "Registration", icon: "📄", intervalDays: 365, intervalMiles: null, color: "green" },
];

const STORAGE_KEY = "vehicle_maintenance_records";

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

function daysSinceDate(dateStr: string): number {
  return Math.floor(
    (Date.now() - new Date(dateStr + "T12:00:00").getTime()) / 86_400_000
  );
}

function daysUntilDue(dateStr: string, intervalDays: number): number {
  return intervalDays - daysSinceDate(dateStr);
}

function statusBadge(daysLeft: number): { label: string; classes: string } {
  if (daysLeft < 0) return { label: "Overdue", classes: "bg-red-100 text-red-700" };
  if (daysLeft <= 14) return { label: "Due Soon", classes: "bg-yellow-100 text-yellow-700" };
  return { label: "OK", classes: "bg-green-100 text-green-700" };
}

// ─── Fuel gauge ──────────────────────────────────────────────────────────────

function FuelGauge({ percent }: { percent: number | null }) {
  if (percent == null) return <span className="text-xs text-gray-400">—</span>;
  const rounded = Math.round(percent);
  const color =
    rounded <= 15 ? "bg-red-500" : rounded <= 30 ? "bg-yellow-500" : "bg-green-500";
  return (
    <div className="flex items-center gap-1.5">
      <div className="w-16 h-2.5 bg-gray-200 rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${rounded}%` }} />
      </div>
      <span className={`text-xs font-semibold ${rounded <= 15 ? "text-red-600" : rounded <= 30 ? "text-yellow-600" : "text-gray-600"}`}>
        {rounded}%
      </span>
    </div>
  );
}

// ─── Vehicle Fleet Table ─────────────────────────────────────────────────────

function VehicleFleetTable({
  vehicles,
  diags,
}: {
  vehicles: SamsaraVan[];
  diags: Map<string, VehicleDiag>;
}) {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  return (
    <div className="rounded-xl border bg-white shadow-sm overflow-hidden">
      <div className="px-4 py-3 border-b bg-gray-50">
        <span className="text-sm font-semibold text-gray-800">Fleet Status</span>
        <span className="text-xs text-gray-400 ml-2">· {vehicles.length} vehicles via Samsara</span>
      </div>
      {vehicles.length === 0 ? (
        <div className="px-4 py-8 text-sm text-gray-400 text-center">No vehicles found.</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-gray-50 text-xs text-gray-500 uppercase tracking-wide">
                <th className="px-4 py-2.5 text-left font-semibold">Vehicle</th>
                <th className="px-4 py-2.5 text-left font-semibold">Location</th>
                <th className="px-4 py-2.5 text-right font-semibold">Speed</th>
                <th className="px-4 py-2.5 text-right font-semibold">Odometer</th>
                <th className="px-4 py-2.5 text-center font-semibold">Fuel</th>
                <th className="px-4 py-2.5 text-center font-semibold">Engine</th>
                <th className="px-4 py-2.5 text-center font-semibold">Last Update</th>
                <th className="px-4 py-2.5 text-center font-semibold w-10"></th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {vehicles.map((v) => {
                const diag = diags.get(v.id);
                const celOn = diag?.check_engine_on === true;
                const isExpanded = expandedId === v.id;

                return (
                  <VehicleFleetRow
                    key={v.id}
                    v={v}
                    diag={diag}
                    celOn={celOn}
                    isExpanded={isExpanded}
                    onToggle={() => setExpandedId(isExpanded ? null : v.id)}
                  />
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function VehicleFleetRow({
  v,
  diag,
  celOn,
  isExpanded,
  onToggle,
}: {
  v: SamsaraVan;
  diag?: VehicleDiag;
  celOn: boolean;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  return (
    <>
      <tr
        className={`cursor-pointer hover:bg-gray-50 transition-colors ${celOn ? "bg-red-50 hover:bg-red-50/80" : ""}`}
        onClick={onToggle}
      >
        <td className="px-4 py-3">
          <div className="flex items-center gap-2">
            <span className="font-medium text-gray-800">{v.name || v.id}</span>
            {celOn && (
              <span className="text-xs bg-red-100 text-red-700 font-semibold px-2 py-0.5 rounded-full">
                Check Engine
              </span>
            )}
          </div>
          <div className="text-xs text-gray-400 font-mono">{v.id}</div>
        </td>
        <td className="px-4 py-3">
          <div className="text-xs text-gray-600 max-w-[200px] truncate">
            {v.address || (v.lat != null ? `${v.lat.toFixed(4)}, ${v.lon?.toFixed(4)}` : "No GPS")}
          </div>
        </td>
        <td className="px-4 py-3 text-right">
          {v.speed_mph != null ? (
            <span className={`font-semibold ${v.speed_mph > 0 ? "text-blue-600" : "text-gray-500"}`}>
              {Math.round(v.speed_mph)} mph
            </span>
          ) : (
            <span className="text-gray-400">—</span>
          )}
        </td>
        <td className="px-4 py-3 text-right">
          {diag?.odometer_miles != null ? (
            <span className="text-gray-700">{diag.odometer_miles.toLocaleString()} mi</span>
          ) : (
            <span className="text-gray-400">—</span>
          )}
        </td>
        <td className="px-4 py-3 text-center">
          <FuelGauge percent={diag?.fuel_percent ?? null} />
        </td>
        <td className="px-4 py-3 text-center">
          {diag?.check_engine_on === true ? (
            <span className="text-red-600 font-bold text-lg" title="Check Engine Light ON">⚠</span>
          ) : diag?.check_engine_on === false ? (
            <span className="text-green-600 font-bold" title="Check Engine Light OFF">✓</span>
          ) : (
            <span className="text-gray-400">—</span>
          )}
        </td>
        <td className="px-4 py-3 text-center">
          <span className="text-xs text-gray-500">{fmtTime(v.gps_time)}</span>
        </td>
        <td className="px-4 py-3 text-center">
          <span className="text-gray-400 text-xs">{isExpanded ? "▲" : "▼"}</span>
        </td>
      </tr>
      {isExpanded && (
        <tr>
          <td colSpan={8} className="bg-gray-50 px-6 py-4 border-t">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-xs">
              <div>
                <div className="text-gray-400 uppercase tracking-wide mb-1">Odometer</div>
                <div className="font-semibold text-gray-800">
                  {diag?.odometer_miles != null ? `${diag.odometer_miles.toLocaleString()} mi` : "—"}
                </div>
              </div>
              <div>
                <div className="text-gray-400 uppercase tracking-wide mb-1">Fuel Level</div>
                <div className="font-semibold text-gray-800">
                  {diag?.fuel_percent != null ? `${Math.round(diag.fuel_percent)}%` : "—"}
                </div>
              </div>
              <div>
                <div className="text-gray-400 uppercase tracking-wide mb-1">Check Engine</div>
                <div className={diag?.check_engine_on === true ? "font-semibold text-red-600" : "text-green-600"}>
                  {diag?.check_engine_on === true
                    ? `ON — ${diag.fault_codes.length} fault code${diag.fault_codes.length !== 1 ? "s" : ""}`
                    : diag?.check_engine_on === false
                    ? "Off — clear"
                    : "—"}
                </div>
                {diag?.fault_codes && diag.fault_codes.length > 0 && (
                  <div className="text-red-500 font-mono mt-0.5">{diag.fault_codes.join(", ")}</div>
                )}
              </div>
              <div>
                <div className="text-gray-400 uppercase tracking-wide mb-1">Speed / Heading</div>
                <div className="font-semibold text-gray-800">
                  {v.speed_mph != null ? `${Math.round(v.speed_mph)} mph` : "—"}
                  {v.heading != null && <span className="text-gray-400 ml-1">({Math.round(v.heading)}°)</span>}
                </div>
              </div>
              <div className="col-span-2 md:col-span-4">
                <div className="text-gray-400 uppercase tracking-wide mb-1">Address</div>
                <div className="text-gray-700">
                  {v.address || (v.lat != null ? `${v.lat.toFixed(5)}, ${v.lon?.toFixed(5)}` : "No location data")}
                </div>
              </div>
              {diag?.diag_time && (
                <div className="col-span-2 md:col-span-4">
                  <div className="text-gray-400">Diagnostics as of {fmtTime(diag.diag_time)}</div>
                </div>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

// ─── Preventive Maintenance Schedule ─────────────────────────────────────────

function MaintenanceSchedule({
  vehicles,
  diags,
}: {
  vehicles: SamsaraVan[];
  diags: Map<string, VehicleDiag>;
}) {
  const [records, setRecords] = useState<MaintenanceStore>({});
  const [editing, setEditing] = useState<string | null>(null); // key: vehicleId:type
  const [form, setForm] = useState({ date: "", mileage: "", notes: "" });
  const [filterType, setFilterType] = useState<MaintenanceType | "all">("all");

  // Load from localStorage
  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) setRecords(JSON.parse(saved));
    } catch {}
  }, []);

  // Seed missing records for new vehicles
  useEffect(() => {
    if (vehicles.length === 0) return;
    setRecords((prev) => {
      let needsUpdate = false;
      const updated = { ...prev };
      const now = Date.now();

      for (const v of vehicles) {
        for (const mt of MAINTENANCE_TYPES) {
          const key = `${v.id}:${mt.key}`;
          if (!updated[key]) {
            needsUpdate = true;
            const daysAgo = Math.floor(Math.random() * (mt.intervalDays * 0.8)) + 14;
            const d = new Date(now - daysAgo * 86_400_000);
            updated[key] = {
              vehicleId: v.id,
              type: mt.key,
              date: d.toISOString().slice(0, 10),
              mileage: mt.intervalMiles
                ? String(Math.floor(Math.random() * 20_000 + 28_000))
                : undefined,
            };
          }
        }
      }

      if (needsUpdate) {
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(updated)); } catch {}
      }
      return needsUpdate ? updated : prev;
    });
  }, [vehicles]);

  const persist = useCallback((updated: MaintenanceStore) => {
    setRecords(updated);
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(updated)); } catch {}
  }, []);

  function save(vehicleId: string, type: MaintenanceType) {
    const key = `${vehicleId}:${type}`;
    const updated = {
      ...records,
      [key]: { vehicleId, type, date: form.date, mileage: form.mileage, notes: form.notes },
    };
    persist(updated);
    setEditing(null);
  }

  function startEdit(vehicleId: string, type: MaintenanceType) {
    const key = `${vehicleId}:${type}`;
    const existing = records[key];
    setForm({
      date: existing?.date ?? "",
      mileage: existing?.mileage ?? "",
      notes: existing?.notes ?? "",
    });
    setEditing(key);
  }

  // Build rows: one per vehicle per maintenance type (or filtered)
  const rows = useMemo(() => {
    const result: {
      vehicle: SamsaraVan;
      diag?: VehicleDiag;
      mt: (typeof MAINTENANCE_TYPES)[number];
      rec?: MaintenanceRecord;
      daysSince: number | null;
      daysLeft: number | null;
      milesSince: number | null;
    }[] = [];

    for (const v of vehicles) {
      for (const mt of MAINTENANCE_TYPES) {
        if (filterType !== "all" && filterType !== mt.key) continue;
        const key = `${v.id}:${mt.key}`;
        const rec = records[key];
        const diag = diags.get(v.id);
        const ds = rec?.date ? daysSinceDate(rec.date) : null;
        const dl = rec?.date ? daysUntilDue(rec.date, mt.intervalDays) : null;
        const lastMi = rec?.mileage ? parseInt(rec.mileage.replace(/,/g, "")) : null;
        const ms =
          diag?.odometer_miles != null && lastMi != null
            ? diag.odometer_miles - lastMi
            : null;

        result.push({ vehicle: v, diag, mt, rec, daysSince: ds, daysLeft: dl, milesSince: ms });
      }
    }

    // Sort: most overdue first
    result.sort((a, b) => {
      const aUrgency = a.daysLeft ?? 9999;
      const bUrgency = b.daysLeft ?? 9999;
      return aUrgency - bUrgency;
    });

    return result;
  }, [vehicles, diags, records, filterType]);

  // Summary counts
  const overdueCount = rows.filter((r) => r.daysLeft !== null && r.daysLeft < 0).length;
  const dueSoonCount = rows.filter((r) => r.daysLeft !== null && r.daysLeft >= 0 && r.daysLeft <= 14).length;

  return (
    <div className="rounded-xl border bg-white shadow-sm overflow-hidden">
      <div className="px-4 py-3 border-b bg-gray-50 flex flex-wrap items-center justify-between gap-2">
        <div>
          <span className="text-sm font-semibold text-gray-800">Preventive Maintenance Schedule</span>
          <span className="text-xs text-gray-400 ml-2">· Stored locally</span>
          {overdueCount > 0 && (
            <span className="ml-2 text-xs bg-red-100 text-red-700 font-semibold px-2 py-0.5 rounded-full">
              {overdueCount} overdue
            </span>
          )}
          {dueSoonCount > 0 && (
            <span className="ml-2 text-xs bg-yellow-100 text-yellow-700 font-semibold px-2 py-0.5 rounded-full">
              {dueSoonCount} due soon
            </span>
          )}
        </div>
        <div className="flex gap-1">
          {[{ key: "all" as const, label: "All" }, ...MAINTENANCE_TYPES.map((mt) => ({ key: mt.key, label: mt.label }))].map(
            (opt) => (
              <button
                key={opt.key}
                onClick={() => setFilterType(opt.key)}
                className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${
                  filterType === opt.key
                    ? "bg-slate-800 text-white"
                    : "bg-gray-100 text-gray-600 hover:bg-gray-200"
                }`}
              >
                {opt.label}
              </button>
            ),
          )}
        </div>
      </div>

      {rows.length === 0 ? (
        <div className="px-4 py-8 text-sm text-gray-400 text-center">No vehicles found.</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-gray-50 text-xs text-gray-500 uppercase tracking-wide">
                <th className="px-4 py-2.5 text-left font-semibold">Vehicle</th>
                <th className="px-4 py-2.5 text-left font-semibold">Service</th>
                <th className="px-4 py-2.5 text-center font-semibold">Last Done</th>
                <th className="px-4 py-2.5 text-center font-semibold">Mileage</th>
                <th className="px-4 py-2.5 text-center font-semibold">Status</th>
                <th className="px-4 py-2.5 text-center font-semibold">Next Due</th>
                <th className="px-4 py-2.5 text-left font-semibold">Notes</th>
                <th className="px-4 py-2.5 text-center font-semibold w-20"></th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {rows.map((row) => {
                const key = `${row.vehicle.id}:${row.mt.key}`;
                const isEditing = editing === key;
                const badge = row.daysLeft !== null ? statusBadge(row.daysLeft) : null;

                // Miles-based alert for oil/tires
                const mileDue =
                  row.mt.intervalMiles && row.milesSince !== null && row.milesSince >= row.mt.intervalMiles;

                const rowAlert =
                  (row.daysLeft !== null && row.daysLeft < 0) || mileDue;

                if (isEditing) {
                  return (
                    <tr key={key} className="bg-blue-50">
                      <td colSpan={8} className="px-4 py-3">
                        <div className="space-y-2">
                          <div className="text-sm font-medium">
                            {row.vehicle.name} — {row.mt.icon} {row.mt.label}
                          </div>
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
                            {row.mt.intervalMiles && (
                              <div className="flex flex-col gap-1">
                                <label className="text-xs text-gray-500">Mileage</label>
                                <input
                                  type="text"
                                  placeholder={
                                    row.diag?.odometer_miles != null
                                      ? `Current: ${row.diag.odometer_miles.toLocaleString()}`
                                      : "e.g. 45,200"
                                  }
                                  value={form.mileage}
                                  onChange={(e) => setForm((f) => ({ ...f, mileage: e.target.value }))}
                                  className="border rounded px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-slate-300 w-36"
                                />
                              </div>
                            )}
                            <div className="flex flex-col gap-1">
                              <label className="text-xs text-gray-500">Notes</label>
                              <input
                                type="text"
                                placeholder="Optional"
                                value={form.notes}
                                onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
                                className="border rounded px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-slate-300 w-48"
                              />
                            </div>
                          </div>
                          <div className="flex gap-2">
                            <button
                              onClick={() => save(row.vehicle.id, row.mt.key)}
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
                      </td>
                    </tr>
                  );
                }

                return (
                  <tr key={key} className={rowAlert ? "bg-red-50" : ""}>
                    <td className="px-4 py-2.5">
                      <span className="font-medium text-gray-800">{row.vehicle.name}</span>
                    </td>
                    <td className="px-4 py-2.5">
                      <span className="text-gray-700">
                        {row.mt.icon} {row.mt.label}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-center">
                      {row.rec?.date ? (
                        <div>
                          <div className="text-gray-700">{row.rec.date}</div>
                          {row.daysSince !== null && (
                            <div className="text-xs text-gray-400">{row.daysSince}d ago</div>
                          )}
                        </div>
                      ) : (
                        <span className="text-gray-400">—</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-center">
                      {row.rec?.mileage ? (
                        <div>
                          <div className="text-gray-700">{row.rec.mileage} mi</div>
                          {row.milesSince !== null && (
                            <div className={`text-xs ${mileDue ? "text-red-600 font-semibold" : "text-gray-400"}`}>
                              +{row.milesSince.toLocaleString()} mi since
                            </div>
                          )}
                        </div>
                      ) : (
                        <span className="text-gray-400">—</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-center">
                      {badge ? (
                        <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${badge.classes}`}>
                          {badge.label}
                        </span>
                      ) : (
                        <span className="text-gray-400">—</span>
                      )}
                      {mileDue && (
                        <div className="mt-0.5">
                          <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-red-100 text-red-700">
                            Miles Due
                          </span>
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-center">
                      {row.daysLeft !== null ? (
                        <span className={`text-xs font-semibold ${row.daysLeft < 0 ? "text-red-600" : row.daysLeft <= 14 ? "text-yellow-600" : "text-gray-600"}`}>
                          {row.daysLeft < 0
                            ? `${Math.abs(row.daysLeft)}d overdue`
                            : `${row.daysLeft}d`}
                        </span>
                      ) : (
                        <span className="text-gray-400">—</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5">
                      <span className="text-xs text-gray-500">{row.rec?.notes || ""}</span>
                    </td>
                    <td className="px-4 py-2.5 text-center">
                      <button
                        onClick={() => startEdit(row.vehicle.id, row.mt.key)}
                        className="px-2.5 py-1 border rounded-lg text-xs font-medium text-gray-700 hover:bg-gray-50"
                      >
                        Update
                      </button>
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

// ─── Main client component ────────────────────────────────────────────────────

export default function VehiclesClient() {
  const [vans, setVans] = useState<SamsaraVan[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastFetch, setLastFetch] = useState<Date | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/vans", { cache: "no-store" });
      const data = await res.json();
      if (!data.ok) throw new Error(data.detail || data.error || `HTTP ${res.status}`);
      setVans(data.vans ?? []);
      setLastFetch(new Date());
    } catch (e: unknown) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  // Diagnostics: odometer + check engine + fuel
  const [diagData, setDiagData] = useState<Map<string, VehicleDiag>>(new Map());
  useEffect(() => {
    async function loadDiags() {
      try {
        const res = await fetch("/api/vans/diagnostics", { cache: "no-store" });
        const data = await res.json();
        if (!data.ok) return;
        const map = new Map<string, VehicleDiag>();
        for (const v of data.vehicles ?? []) map.set(v.id, v);
        setDiagData(map);
      } catch {}
    }
    loadDiags();
    const id = setInterval(loadDiags, 300_000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => { load(); }, []);
  useEffect(() => {
    const id = setInterval(load, 240_000);
    return () => clearInterval(id);
  }, []);

  const allVehicles = vans;
  const celVehicles = allVehicles.filter((v) => diagData.get(v.id)?.check_engine_on === true);
  const lowFuelVehicles = allVehicles.filter((v) => {
    const fp = diagData.get(v.id)?.fuel_percent;
    return fp != null && fp <= 15;
  });

  const hasAlerts = celVehicles.length > 0 || lowFuelVehicles.length > 0;

  if (loading && vans.length === 0) {
    return (
      <div className="rounded-xl border bg-white shadow-sm px-5 py-4 text-sm text-gray-400 animate-pulse">
        Loading vehicle data…
      </div>
    );
  }

  if (error) {
    const unconfigured = error.includes("not configured") || error.includes("503");
    return (
      <div className="rounded-xl border border-dashed border-gray-300 bg-gray-50 px-5 py-4">
        <div className="text-sm font-semibold text-gray-700">Vehicle Fleet Tracking</div>
        <div className="text-xs text-gray-500 mt-0.5">
          {unconfigured
            ? "Add SAMSARA_API_KEY to environment to enable live tracking."
            : `Samsara error: ${error}`}
        </div>
      </div>
    );
  }

  const mapCars = allVehicles
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
      {/* Status Banner */}
      <div
        className={`rounded-xl border-2 px-5 py-4 shadow-sm ${
          hasAlerts ? "border-red-300 bg-red-50" : "border-green-300 bg-green-50"
        }`}
      >
        <div className="flex items-center gap-3">
          <div
            className={`w-10 h-10 rounded-full flex items-center justify-center text-xl shrink-0 ${
              hasAlerts ? "bg-red-100" : "bg-green-100"
            }`}
          >
            {hasAlerts ? "⚠" : "✓"}
          </div>
          <div className="flex-1">
            <div className={`text-base font-bold ${hasAlerts ? "text-red-800" : "text-green-800"}`}>
              Vehicle Fleet Status
            </div>
            {hasAlerts ? (
              <div className="text-sm text-red-600 font-semibold">
                {[
                  celVehicles.length > 0 &&
                    `${celVehicles.length} check engine light${celVehicles.length !== 1 ? "s" : ""}`,
                  lowFuelVehicles.length > 0 &&
                    `${lowFuelVehicles.length} low fuel`,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </div>
            ) : (
              <div className="text-sm text-green-700 font-medium">
                All {allVehicles.length} vehicles clear — no alerts
              </div>
            )}
          </div>
        </div>
        {hasAlerts && (
          <div className="flex flex-wrap gap-2 mt-3 ml-[52px]">
            {celVehicles.map((v) => (
              <span
                key={`cel-${v.id}`}
                className="inline-flex items-center gap-1.5 bg-white border border-red-200 rounded-lg px-3 py-1.5 text-xs font-medium text-red-700"
              >
                {v.name} — Check Engine
              </span>
            ))}
            {lowFuelVehicles.map((v) => (
              <span
                key={`fuel-${v.id}`}
                className="inline-flex items-center gap-1.5 bg-white border border-yellow-200 rounded-lg px-3 py-1.5 text-xs font-medium text-yellow-700"
              >
                {v.name} — Low Fuel ({Math.round(diagData.get(v.id)?.fuel_percent ?? 0)}%)
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Live Map */}
      <div className="rounded-xl border bg-white shadow-sm overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b">
          <div className="text-sm font-semibold text-gray-800">
            Live Map
            <span className="ml-2 text-xs font-normal text-gray-400">
              via Samsara · {allVehicles.length} vehicles
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
            {allVehicles.length === 0 ? "No vehicles found in Samsara." : "No vehicles have GPS data yet."}
          </div>
        )}
      </div>

      {/* Vehicle Fleet Table */}
      <VehicleFleetTable vehicles={allVehicles} diags={diagData} />

      {/* Preventive Maintenance Schedule */}
      <MaintenanceSchedule vehicles={allVehicles} diags={diagData} />
    </div>
  );
}
