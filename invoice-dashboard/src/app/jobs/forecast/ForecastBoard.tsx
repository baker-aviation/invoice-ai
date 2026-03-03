"use client";

import { useState, useMemo, useCallback, useEffect } from "react";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Baker fleet aircraft types */
const AIRCRAFT_TYPES = [
  "Citation X",
  "Challenger 300/350",
  "Global Express",
  "Gulfstream G280",
  "Gulfstream G450/500",
  "Other",
] as const;

type AircraftType = (typeof AIRCRAFT_TYPES)[number];

/** Hiring pipeline durations (business days) */
const PIPELINE_DAYS = {
  screening: 10,      // Apply → Screening / Info Sessions
  interview: 10,      // Screening → Interview / Hired
  indoc: 7,           // Hired → INDOC
  typeRatingRecurrent: 7,   // INDOC → Type Rating (recurrent)
  typeRatingInitial: 14,    // INDOC → Type Rating (initial)
  onRotation: 7,      // Type Rating → Flying on rotation
} as const;

/** Total days from application to flying */
const TOTAL_DAYS_RECURRENT =
  PIPELINE_DAYS.screening +
  PIPELINE_DAYS.interview +
  PIPELINE_DAYS.indoc +
  PIPELINE_DAYS.typeRatingRecurrent +
  PIPELINE_DAYS.onRotation; // 41 days

const TOTAL_DAYS_INITIAL =
  PIPELINE_DAYS.screening +
  PIPELINE_DAYS.interview +
  PIPELINE_DAYS.indoc +
  PIPELINE_DAYS.typeRatingInitial +
  PIPELINE_DAYS.onRotation; // 48 days

/** Crew per aircraft: 2 PICs, 2 SICs (two full crews for rotation) */
const CREW_PER_AIRCRAFT = { pic: 2, sic: 2 };

/** localStorage key for persisting settings */
const STORAGE_KEY = "baker-hiring-forecast";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type FleetRow = {
  type: AircraftType;
  currentAircraft: number;
  currentPic: number;
  currentSic: number;
};

type FutureAircraft = {
  type: AircraftType;
  month: number; // 0-based offset from current month
  count: number;
};

type SavedState = {
  fleet: FleetRow[];
  futureAircraft: FutureAircraft[];
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getMonthLabel(offset: number): string {
  const d = new Date();
  d.setMonth(d.getMonth() + offset);
  return d.toLocaleDateString("en-US", { month: "short", year: "numeric" });
}

function getMonthLabels(count: number): string[] {
  return Array.from({ length: count }, (_, i) => getMonthLabel(i));
}

function loadState(): SavedState | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function saveState(state: SavedState): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch { /* ignore */ }
}

const defaultFleet: FleetRow[] = AIRCRAFT_TYPES.map((type) => ({
  type,
  currentAircraft: 0,
  currentPic: 0,
  currentSic: 0,
}));

// ---------------------------------------------------------------------------
// Pipeline timeline visual
// ---------------------------------------------------------------------------

function PipelineTimeline() {
  const stages = [
    { label: "Apply", days: 0, color: "bg-slate-200" },
    { label: "Screening / Info Session", days: PIPELINE_DAYS.screening, color: "bg-blue-200" },
    { label: "Interview / Hired", days: PIPELINE_DAYS.interview, color: "bg-violet-200" },
    { label: "INDOC", days: PIPELINE_DAYS.indoc, color: "bg-amber-200" },
    { label: "Type Rating", days: `${PIPELINE_DAYS.typeRatingRecurrent}d rec / ${PIPELINE_DAYS.typeRatingInitial}d init`, color: "bg-orange-200" },
    { label: "On Rotation", days: PIPELINE_DAYS.onRotation, color: "bg-green-200" },
  ];

  return (
    <div className="rounded-xl border bg-white shadow-sm p-4">
      <div className="text-sm font-semibold text-gray-700 mb-3">Hiring Pipeline Timeline</div>
      <div className="flex items-center gap-1 overflow-x-auto">
        {stages.map((s, i) => (
          <div key={s.label} className="flex items-center gap-1">
            {i > 0 && (
              <svg className="w-4 h-4 text-gray-300 shrink-0" fill="none" viewBox="0 0 16 16" stroke="currentColor" strokeWidth={2}>
                <path d="M6 4l4 4-4 4" />
              </svg>
            )}
            <div className={`${s.color} rounded-lg px-3 py-2 text-xs font-medium text-gray-700 whitespace-nowrap`}>
              <div>{s.label}</div>
              {s.days !== 0 && (
                <div className="text-[10px] text-gray-500 mt-0.5">
                  {typeof s.days === "number" ? `${s.days} days` : s.days}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
      <div className="mt-2 text-xs text-gray-400">
        Total: ~{TOTAL_DAYS_RECURRENT} days (recurrent) / ~{TOTAL_DAYS_INITIAL} days (initial) from application to flying
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Fleet input table
// ---------------------------------------------------------------------------

function FleetInput({
  fleet,
  onChange,
}: {
  fleet: FleetRow[];
  onChange: (fleet: FleetRow[]) => void;
}) {
  const update = (idx: number, field: keyof FleetRow, value: number) => {
    const next = [...fleet];
    next[idx] = { ...next[idx], [field]: Math.max(0, value) };
    onChange(next);
  };

  return (
    <div className="rounded-xl border bg-white shadow-sm overflow-hidden">
      <div className="px-4 py-3 border-b bg-gray-50">
        <div className="text-sm font-semibold text-gray-700">Current Fleet & Crew</div>
        <div className="text-xs text-gray-400 mt-0.5">Enter your current aircraft count and crew numbers per type</div>
      </div>
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b bg-gray-50 text-xs text-gray-500 uppercase tracking-wide">
            <th className="px-4 py-2.5 text-left">Aircraft Type</th>
            <th className="px-4 py-2.5 text-center w-28">Aircraft</th>
            <th className="px-4 py-2.5 text-center w-28">PICs</th>
            <th className="px-4 py-2.5 text-center w-28">SICs</th>
            <th className="px-4 py-2.5 text-center w-28">PIC Need</th>
            <th className="px-4 py-2.5 text-center w-28">SIC Need</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {fleet.map((row, i) => {
            const neededPic = Math.max(0, row.currentAircraft * CREW_PER_AIRCRAFT.pic - row.currentPic);
            const neededSic = Math.max(0, row.currentAircraft * CREW_PER_AIRCRAFT.sic - row.currentSic);
            return (
              <tr key={row.type} className="hover:bg-gray-50">
                <td className="px-4 py-2.5 font-medium text-gray-800">{row.type}</td>
                <td className="px-4 py-2.5 text-center">
                  <input
                    type="number"
                    min={0}
                    value={row.currentAircraft}
                    onChange={(e) => update(i, "currentAircraft", parseInt(e.target.value) || 0)}
                    className="w-16 text-center border rounded px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-blue-300"
                  />
                </td>
                <td className="px-4 py-2.5 text-center">
                  <input
                    type="number"
                    min={0}
                    value={row.currentPic}
                    onChange={(e) => update(i, "currentPic", parseInt(e.target.value) || 0)}
                    className="w-16 text-center border rounded px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-blue-300"
                  />
                </td>
                <td className="px-4 py-2.5 text-center">
                  <input
                    type="number"
                    min={0}
                    value={row.currentSic}
                    onChange={(e) => update(i, "currentSic", parseInt(e.target.value) || 0)}
                    className="w-16 text-center border rounded px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-blue-300"
                  />
                </td>
                <td className="px-4 py-2.5 text-center">
                  {neededPic > 0 ? (
                    <span className="text-red-600 font-semibold">{neededPic}</span>
                  ) : (
                    <span className="text-green-600 font-medium">0</span>
                  )}
                </td>
                <td className="px-4 py-2.5 text-center">
                  {neededSic > 0 ? (
                    <span className="text-red-600 font-semibold">{neededSic}</span>
                  ) : (
                    <span className="text-green-600 font-medium">0</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="px-4 py-2 border-t bg-gray-50 text-xs text-gray-400">
        Assumes {CREW_PER_AIRCRAFT.pic} PICs + {CREW_PER_AIRCRAFT.sic} SICs per aircraft (two full rotation crews)
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Future aircraft input
// ---------------------------------------------------------------------------

function FutureAircraftInput({
  futureAircraft,
  onChange,
}: {
  futureAircraft: FutureAircraft[];
  onChange: (fa: FutureAircraft[]) => void;
}) {
  const months = getMonthLabels(7).slice(1); // next 6 months

  const addRow = () => {
    onChange([...futureAircraft, { type: AIRCRAFT_TYPES[0], month: 1, count: 1 }]);
  };

  const removeRow = (idx: number) => {
    onChange(futureAircraft.filter((_, i) => i !== idx));
  };

  const update = (idx: number, field: keyof FutureAircraft, value: string | number) => {
    const next = [...futureAircraft];
    if (field === "type") {
      next[idx] = { ...next[idx], type: value as AircraftType };
    } else {
      next[idx] = { ...next[idx], [field]: Math.max(field === "month" ? 1 : 1, Number(value) || 0) };
    }
    onChange(next);
  };

  return (
    <div className="rounded-xl border bg-white shadow-sm overflow-hidden">
      <div className="px-4 py-3 border-b bg-gray-50 flex items-center justify-between">
        <div>
          <div className="text-sm font-semibold text-gray-700">Expected New Aircraft</div>
          <div className="text-xs text-gray-400 mt-0.5">Aircraft expected to join the fleet over the next 6 months</div>
        </div>
        <button
          onClick={addRow}
          className="text-xs font-medium text-blue-600 bg-blue-50 border border-blue-200 rounded-lg px-3 py-1.5 hover:bg-blue-100 transition-colors"
        >
          + Add Aircraft
        </button>
      </div>
      {futureAircraft.length === 0 ? (
        <div className="px-4 py-6 text-sm text-gray-400 text-center">
          No future aircraft added. Click &quot;+ Add Aircraft&quot; to plan fleet growth.
        </div>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-gray-50 text-xs text-gray-500 uppercase tracking-wide">
              <th className="px-4 py-2.5 text-left">Type</th>
              <th className="px-4 py-2.5 text-left">Expected Month</th>
              <th className="px-4 py-2.5 text-center w-28">Count</th>
              <th className="px-4 py-2.5 w-16"></th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {futureAircraft.map((row, i) => (
              <tr key={i} className="hover:bg-gray-50">
                <td className="px-4 py-2.5">
                  <select
                    value={row.type}
                    onChange={(e) => update(i, "type", e.target.value)}
                    className="border rounded px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-blue-300"
                  >
                    {AIRCRAFT_TYPES.map((t) => (
                      <option key={t} value={t}>{t}</option>
                    ))}
                  </select>
                </td>
                <td className="px-4 py-2.5">
                  <select
                    value={row.month}
                    onChange={(e) => update(i, "month", parseInt(e.target.value))}
                    className="border rounded px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-blue-300"
                  >
                    {months.map((label, mi) => (
                      <option key={mi + 1} value={mi + 1}>{label}</option>
                    ))}
                  </select>
                </td>
                <td className="px-4 py-2.5 text-center">
                  <input
                    type="number"
                    min={1}
                    value={row.count}
                    onChange={(e) => update(i, "count", parseInt(e.target.value) || 1)}
                    className="w-16 text-center border rounded px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-blue-300"
                  />
                </td>
                <td className="px-4 py-2.5 text-center">
                  <button
                    onClick={() => removeRow(i)}
                    className="text-gray-300 hover:text-red-500 transition-colors"
                    title="Remove"
                  >
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 16 16" stroke="currentColor" strokeWidth={2}>
                      <path d="M4 4l8 8M12 4l-8 8" />
                    </svg>
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Forecast results
// ---------------------------------------------------------------------------

type MonthForecast = {
  month: string;
  offset: number;
  byType: {
    type: AircraftType;
    totalAircraft: number;
    neededPic: number;
    neededSic: number;
    /** Hire-by date to have crew ready by this month */
    hireByPic: string | null;
    hireBySic: string | null;
  }[];
  totalHirePic: number;
  totalHireSic: number;
};

function computeForecast(
  fleet: FleetRow[],
  futureAircraft: FutureAircraft[],
): MonthForecast[] {
  const months = getMonthLabels(7);
  const results: MonthForecast[] = [];

  for (let offset = 0; offset < 7; offset++) {
    const byType = fleet.map((row) => {
      // Current aircraft + future aircraft arriving by this month
      const futureCount = futureAircraft
        .filter((fa) => fa.type === row.type && fa.month <= offset)
        .reduce((sum, fa) => sum + fa.count, 0);

      const totalAircraft = row.currentAircraft + futureCount;
      const neededPic = Math.max(0, totalAircraft * CREW_PER_AIRCRAFT.pic - row.currentPic);
      const neededSic = Math.max(0, totalAircraft * CREW_PER_AIRCRAFT.sic - row.currentSic);

      // Calculate hire-by date: need crew ready by start of this month
      // Work backwards from month start by TOTAL_DAYS_INITIAL
      let hireByPic: string | null = null;
      let hireBySic: string | null = null;

      if (neededPic > 0 && offset > 0) {
        const monthStart = new Date();
        monthStart.setMonth(monthStart.getMonth() + offset, 1);
        const hireDate = new Date(monthStart.getTime() - TOTAL_DAYS_INITIAL * 24 * 3600000);
        hireByPic = hireDate.toLocaleDateString("en-US", { month: "short", day: "numeric" });
      }
      if (neededSic > 0 && offset > 0) {
        const monthStart = new Date();
        monthStart.setMonth(monthStart.getMonth() + offset, 1);
        const hireDate = new Date(monthStart.getTime() - TOTAL_DAYS_INITIAL * 24 * 3600000);
        hireBySic = hireDate.toLocaleDateString("en-US", { month: "short", day: "numeric" });
      }

      return { type: row.type, totalAircraft, neededPic, neededSic, hireByPic, hireBySic };
    });

    results.push({
      month: months[offset],
      offset,
      byType,
      totalHirePic: byType.reduce((s, r) => s + r.neededPic, 0),
      totalHireSic: byType.reduce((s, r) => s + r.neededSic, 0),
    });
  }

  return results;
}

function ForecastResults({
  fleet,
  futureAircraft,
}: {
  fleet: FleetRow[];
  futureAircraft: FutureAircraft[];
}) {
  const forecast = useMemo(
    () => computeForecast(fleet, futureAircraft),
    [fleet, futureAircraft],
  );

  const hasAnyNeed = forecast.some((m) => m.totalHirePic > 0 || m.totalHireSic > 0);

  return (
    <div className="space-y-4">
      {/* Summary cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          {
            label: "Total Aircraft (Now)",
            value: fleet.reduce((s, r) => s + r.currentAircraft, 0),
          },
          {
            label: "Total Aircraft (6 Mo)",
            value: fleet.reduce((s, r) => s + r.currentAircraft, 0) +
              futureAircraft.reduce((s, fa) => s + fa.count, 0),
          },
          {
            label: "PICs Needed (Now)",
            value: fleet.reduce(
              (s, r) => s + Math.max(0, r.currentAircraft * CREW_PER_AIRCRAFT.pic - r.currentPic),
              0,
            ),
            alert: true,
          },
          {
            label: "SICs Needed (Now)",
            value: fleet.reduce(
              (s, r) => s + Math.max(0, r.currentAircraft * CREW_PER_AIRCRAFT.sic - r.currentSic),
              0,
            ),
            alert: true,
          },
        ].map(({ label, value, alert }) => (
          <div key={label} className="bg-white border rounded-xl px-4 py-3 shadow-sm">
            <div className={`text-2xl font-bold ${alert && value > 0 ? "text-red-600" : "text-slate-800"}`}>
              {value}
            </div>
            <div className="text-xs text-gray-500 mt-0.5">{label}</div>
          </div>
        ))}
      </div>

      {/* Monthly forecast table */}
      <div className="rounded-xl border bg-white shadow-sm overflow-hidden">
        <div className="px-4 py-3 border-b bg-gray-50">
          <div className="text-sm font-semibold text-gray-700">6-Month Hiring Forecast</div>
          <div className="text-xs text-gray-400 mt-0.5">
            When to start recruiting to have crew ready on time
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-gray-50 text-xs text-gray-500 uppercase tracking-wide">
                <th className="px-4 py-2.5 text-left sticky left-0 bg-gray-50">Month</th>
                {fleet.filter((r) => r.currentAircraft > 0 || futureAircraft.some((fa) => fa.type === r.type)).map((r) => (
                  <th key={r.type} className="px-4 py-2.5 text-center min-w-[120px]" colSpan={2}>
                    {r.type}
                  </th>
                ))}
                <th className="px-4 py-2.5 text-center" colSpan={2}>Total</th>
              </tr>
              <tr className="border-b text-xs text-gray-400">
                <th className="px-4 py-1 sticky left-0 bg-white"></th>
                {fleet.filter((r) => r.currentAircraft > 0 || futureAircraft.some((fa) => fa.type === r.type)).map((r) => (
                  <th key={r.type + "-sub"} className="px-2 py-1 text-center" colSpan={1}>
                    <span className="inline-flex gap-3">
                      <span>PIC</span>
                    </span>
                  </th>
                ))}
                {fleet.filter((r) => r.currentAircraft > 0 || futureAircraft.some((fa) => fa.type === r.type)).map((r) => (
                  <th key={r.type + "-sub2"} className="px-2 py-1 text-center" colSpan={1}>
                    <span>SIC</span>
                  </th>
                ))}
                <th className="px-2 py-1 text-center">PIC</th>
                <th className="px-2 py-1 text-center">SIC</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {forecast.map((month) => {
                const activeTypes = month.byType.filter((r) =>
                  r.totalAircraft > 0 ||
                  fleet.find((f) => f.type === r.type)?.currentAircraft! > 0 ||
                  futureAircraft.some((fa) => fa.type === r.type)
                );
                return (
                  <tr
                    key={month.offset}
                    className={`hover:bg-gray-50 ${month.offset === 0 ? "bg-blue-50/30" : ""}`}
                  >
                    <td className="px-4 py-2.5 font-medium text-gray-800 sticky left-0 bg-inherit whitespace-nowrap">
                      {month.month}
                      {month.offset === 0 && (
                        <span className="ml-1.5 text-xs bg-blue-100 text-blue-700 rounded px-1.5 py-0.5">Now</span>
                      )}
                    </td>
                    {activeTypes.map((r) => (
                      <td key={r.type + "-pic"} className="px-2 py-2.5 text-center">
                        {r.neededPic > 0 ? (
                          <div>
                            <span className="text-red-600 font-semibold">{r.neededPic}</span>
                            {r.hireByPic && (
                              <div className="text-[10px] text-orange-600 mt-0.5">by {r.hireByPic}</div>
                            )}
                          </div>
                        ) : (
                          <span className="text-green-600">-</span>
                        )}
                      </td>
                    ))}
                    {activeTypes.map((r) => (
                      <td key={r.type + "-sic"} className="px-2 py-2.5 text-center">
                        {r.neededSic > 0 ? (
                          <div>
                            <span className="text-red-600 font-semibold">{r.neededSic}</span>
                            {r.hireBySic && (
                              <div className="text-[10px] text-orange-600 mt-0.5">by {r.hireBySic}</div>
                            )}
                          </div>
                        ) : (
                          <span className="text-green-600">-</span>
                        )}
                      </td>
                    ))}
                    <td className="px-2 py-2.5 text-center font-semibold">
                      <span className={month.totalHirePic > 0 ? "text-red-600" : "text-green-600"}>
                        {month.totalHirePic || "-"}
                      </span>
                    </td>
                    <td className="px-2 py-2.5 text-center font-semibold">
                      <span className={month.totalHireSic > 0 ? "text-red-600" : "text-green-600"}>
                        {month.totalHireSic || "-"}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Action items / alerts */}
      {hasAnyNeed && (
        <div className="rounded-xl border-2 border-orange-200 bg-orange-50 shadow-sm overflow-hidden">
          <div className="px-4 py-3 border-b border-orange-200 bg-orange-100/50">
            <div className="text-sm font-bold text-orange-800">Hiring Action Items</div>
            <div className="text-xs text-orange-600 mt-0.5">
              Start recruiting now to have crew ready in time
            </div>
          </div>
          <div className="divide-y divide-orange-100">
            {forecast.flatMap((month) =>
              month.byType
                .filter((r) => (r.neededPic > 0 || r.neededSic > 0) && month.offset > 0)
                .map((r) => ({
                  key: `${month.offset}-${r.type}`,
                  month: month.month,
                  type: r.type,
                  totalAircraft: r.totalAircraft,
                  neededPic: r.neededPic,
                  neededSic: r.neededSic,
                  hireByPic: r.hireByPic,
                  hireBySic: r.hireBySic,
                }))
            )
            // Deduplicate: only show the first month each type appears
            .filter((item, idx, arr) => {
              return arr.findIndex((a) => a.type === item.type) === idx;
            })
            .map((item) => (
              <div key={item.key} className="px-4 py-3 flex items-start gap-3">
                <div className="w-6 h-6 rounded-full bg-orange-200 flex items-center justify-center text-xs font-bold text-orange-700 shrink-0 mt-0.5">
                  !
                </div>
                <div>
                  <div className="text-sm font-medium text-gray-800">
                    {item.type} — {item.totalAircraft} aircraft by {item.month}
                  </div>
                  <div className="text-xs text-gray-600 mt-0.5 space-y-0.5">
                    {item.neededPic > 0 && (
                      <div>
                        Need <span className="font-semibold text-red-600">{item.neededPic} PIC{item.neededPic > 1 ? "s" : ""}</span>
                        {item.hireByPic && <span className="text-orange-600"> — start recruiting by {item.hireByPic}</span>}
                      </div>
                    )}
                    {item.neededSic > 0 && (
                      <div>
                        Need <span className="font-semibold text-red-600">{item.neededSic} SIC{item.neededSic > 1 ? "s" : ""}</span>
                        {item.hireBySic && <span className="text-orange-600"> — start recruiting by {item.hireBySic}</span>}
                      </div>
                    )}
                  </div>
                  <div className="text-[10px] text-gray-400 mt-1">
                    Pipeline: Apply → Screen (10d) → Interview (10d) → INDOC (7d) → Type Rating (7-14d) → Flying (7d)
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main board
// ---------------------------------------------------------------------------

export default function ForecastBoard() {
  const [fleet, setFleet] = useState<FleetRow[]>(defaultFleet);
  const [futureAircraft, setFutureAircraft] = useState<FutureAircraft[]>([]);
  const [loaded, setLoaded] = useState(false);

  // Load saved state
  useEffect(() => {
    const saved = loadState();
    if (saved) {
      setFleet(saved.fleet);
      setFutureAircraft(saved.futureAircraft);
    }
    setLoaded(true);
  }, []);

  // Auto-save on change
  const handleFleetChange = useCallback((f: FleetRow[]) => {
    setFleet(f);
    saveState({ fleet: f, futureAircraft });
  }, [futureAircraft]);

  const handleFutureChange = useCallback((fa: FutureAircraft[]) => {
    setFutureAircraft(fa);
    saveState({ fleet, futureAircraft: fa });
  }, [fleet]);

  if (!loaded) {
    return (
      <div className="p-6 text-sm text-gray-400 animate-pulse">Loading forecast...</div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      <div>
        <h2 className="text-lg font-bold text-gray-800">Hiring Forecast</h2>
        <p className="text-sm text-gray-500 mt-1">
          Plan crew hiring based on current fleet, expected growth, and Baker&apos;s hiring pipeline timeline.
        </p>
      </div>

      <PipelineTimeline />
      <FleetInput fleet={fleet} onChange={handleFleetChange} />
      <FutureAircraftInput futureAircraft={futureAircraft} onChange={handleFutureChange} />
      <ForecastResults fleet={fleet} futureAircraft={futureAircraft} />
    </div>
  );
}
