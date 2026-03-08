"use client";

import { useState, useCallback, useMemo } from "react";

const COLUMNS = [
  { key: "pic", label: "PIC hours", decimal: true },
  { key: "sic", label: "SIC hours", decimal: true },
  { key: "inst", label: "Inst hours", decimal: true },
  { key: "night", label: "Night hours", decimal: true },
  { key: "takeoffs_day", label: "Takeoffs day", decimal: false },
  { key: "takeoffs_night", label: "Takeoffs night", decimal: false },
  { key: "landings_day", label: "Landings day", decimal: false },
  { key: "landings_night", label: "Landings night", decimal: false },
  { key: "holds", label: "Holds", decimal: false },
  { key: "inst_approach", label: "Inst approach", decimal: false },
] as const;

type ColumnKey = (typeof COLUMNS)[number]["key"];
type RowData = Record<ColumnKey, string>;

function emptyRow(): RowData {
  return Object.fromEntries(COLUMNS.map((c) => [c.key, ""])) as RowData;
}

function getLast12Months(): { label: string; key: string }[] {
  const months: { label: string; key: string }[] = [];
  const now = new Date();
  for (let i = 11; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const label = d.toLocaleDateString("en-US", {
      month: "long",
      year: "numeric",
    });
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    months.push({ label, key });
  }
  return months;
}

type AircraftData = {
  baseline: RowData;
  months: Record<string, RowData>;
};

function emptyAircraftData(monthKeys: string[]): AircraftData {
  return {
    baseline: emptyRow(),
    months: Object.fromEntries(monthKeys.map((k) => [k, emptyRow()])),
  };
}

function parseNum(val: string): number {
  const n = parseFloat(val);
  return isNaN(n) ? 0 : n;
}

function formatVal(val: number, decimal: boolean): string {
  return decimal ? val.toFixed(1) : String(Math.round(val));
}

function getTotalHours(ad: AircraftData, monthKeys: string[]): number {
  let total = 0;
  // Sum PIC across baseline + all months as the "total hours" for the tag
  total += parseNum(ad.baseline.pic);
  for (const mk of monthKeys) {
    total += parseNum(ad.months[mk].pic);
  }
  return total;
}

function hasAnyData(ad: AircraftData, monthKeys: string[]): boolean {
  const allRows = [ad.baseline, ...monthKeys.map((mk) => ad.months[mk])];
  return allRows.some((row) => COLUMNS.some((c) => parseNum(row[c.key]) !== 0));
}

// Compute column totals for a single aircraft type
function computeTotals(ad: AircraftData, monthKeys: string[]) {
  const prior = {} as Record<ColumnKey, number>;
  const newEntry = {} as Record<ColumnKey, number>;
  for (const col of COLUMNS) {
    prior[col.key] = parseNum(ad.baseline[col.key]);
    newEntry[col.key] = monthKeys.reduce(
      (sum, mk) => sum + parseNum(ad.months[mk][col.key]),
      0
    );
  }
  return { prior, newEntry };
}

// Tag colors to cycle through
const TAG_COLORS = [
  { bg: "bg-blue-100", text: "text-blue-800", ring: "ring-blue-300", activeBg: "bg-blue-200" },
  { bg: "bg-emerald-100", text: "text-emerald-800", ring: "ring-emerald-300", activeBg: "bg-emerald-200" },
  { bg: "bg-purple-100", text: "text-purple-800", ring: "ring-purple-300", activeBg: "bg-purple-200" },
  { bg: "bg-amber-100", text: "text-amber-800", ring: "ring-amber-300", activeBg: "bg-amber-200" },
  { bg: "bg-rose-100", text: "text-rose-800", ring: "ring-rose-300", activeBg: "bg-rose-200" },
  { bg: "bg-cyan-100", text: "text-cyan-800", ring: "ring-cyan-300", activeBg: "bg-cyan-200" },
  { bg: "bg-orange-100", text: "text-orange-800", ring: "ring-orange-300", activeBg: "bg-orange-200" },
  { bg: "bg-indigo-100", text: "text-indigo-800", ring: "ring-indigo-300", activeBg: "bg-indigo-200" },
];

export default function LogbookEntry() {
  const months = getLast12Months();
  const monthKeys = months.map((m) => m.key);

  const [types, setTypes] = useState<string[]>([]);
  const [allData, setAllData] = useState<Record<string, AircraftData>>({});
  const [selectedType, setSelectedType] = useState<string | null>(null);
  const [showOverall, setShowOverall] = useState(false);
  const [newTypeName, setNewTypeName] = useState("");

  function addType() {
    const name = newTypeName.trim();
    if (!name || types.includes(name)) return;
    setTypes((prev) => [...prev, name]);
    setAllData((prev) => ({ ...prev, [name]: emptyAircraftData(monthKeys) }));
    setSelectedType(name);
    setShowOverall(false);
    setNewTypeName("");
  }

  function removeType(name: string) {
    if (!confirm(`Remove "${name}" and all its data?`)) return;
    setTypes((prev) => prev.filter((t) => t !== name));
    setAllData((prev) => {
      const next = { ...prev };
      delete next[name];
      return next;
    });
    if (selectedType === name) {
      setSelectedType(types.length > 1 ? types.find((t) => t !== name) ?? null : null);
    }
  }

  const updateCell = useCallback(
    (type: string, rowKey: string, colKey: ColumnKey, value: string) => {
      setAllData((prev) => {
        const aircraft = { ...prev[type] };
        if (rowKey === "baseline") {
          aircraft.baseline = { ...aircraft.baseline, [colKey]: value };
        } else {
          aircraft.months = {
            ...aircraft.months,
            [rowKey]: { ...aircraft.months[rowKey], [colKey]: value },
          };
        }
        return { ...prev, [type]: aircraft };
      });
    },
    []
  );

  // Overall totals across all types
  const overallTotals = useMemo(() => {
    const prior = {} as Record<ColumnKey, number>;
    const newEntry = {} as Record<ColumnKey, number>;
    for (const col of COLUMNS) {
      prior[col.key] = 0;
      newEntry[col.key] = 0;
    }
    for (const type of types) {
      const ad = allData[type];
      if (!ad) continue;
      const t = computeTotals(ad, monthKeys);
      for (const col of COLUMNS) {
        prior[col.key] += t.prior[col.key];
        newEntry[col.key] += t.newEntry[col.key];
      }
    }
    return { prior, newEntry };
  }, [allData, types, monthKeys]);

  // Per-month overall totals for the overall view
  const overallMonthTotals = useMemo(() => {
    const result: Record<string, Record<ColumnKey, number>> = {};
    for (const mk of monthKeys) {
      result[mk] = {} as Record<ColumnKey, number>;
      for (const col of COLUMNS) {
        result[mk][col.key] = 0;
        for (const type of types) {
          const ad = allData[type];
          if (!ad) continue;
          result[mk][col.key] += parseNum(ad.months[mk][col.key]);
        }
      }
    }
    return result;
  }, [allData, types, monthKeys]);

  const overallBaselineTotals = useMemo(() => {
    const result = {} as Record<ColumnKey, number>;
    for (const col of COLUMNS) {
      result[col.key] = 0;
      for (const type of types) {
        const ad = allData[type];
        if (!ad) continue;
        result[col.key] += parseNum(ad.baseline[col.key]);
      }
    }
    return result;
  }, [allData, types, monthKeys]);

  function exportCSV() {
    const lines: string[] = [];
    const header = ["Aircraft Type", "Date", ...COLUMNS.map((c) => c.label)];
    lines.push(header.join(","));

    for (const type of types) {
      const ad = allData[type];
      if (!ad || !hasAnyData(ad, monthKeys)) continue;

      const firstMonth = months[0];
      const baselineLabel = `Hours before ${firstMonth.label}`;
      lines.push(
        [
          `"${type}"`,
          `"${baselineLabel}"`,
          ...COLUMNS.map((c) => parseNum(ad.baseline[c.key])),
        ].join(",")
      );

      for (let i = 0; i < months.length; i++) {
        lines.push(
          [
            `"${type}"`,
            `"${months[i].label}"`,
            ...COLUMNS.map((c) => parseNum(ad.months[monthKeys[i]][c.key])),
          ].join(",")
        );
      }
    }

    const blob = new Blob([lines.join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "logbook_data.csv";
    a.click();
    URL.revokeObjectURL(url);
  }

  const firstMonthLabel = months[0].label;
  const currentData = selectedType && allData[selectedType] ? allData[selectedType] : null;
  const currentTotals = currentData ? computeTotals(currentData, monthKeys) : null;

  return (
    <div>
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-5">
        <h1 className="text-xl font-bold text-gray-900">Logbook Entry</h1>
        <button
          onClick={exportCSV}
          disabled={types.length === 0}
          className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-white bg-blue-900 rounded-lg hover:bg-blue-800 transition-colors disabled:opacity-50"
        >
          Export CSV
        </button>
      </div>

      {/* Add type rating */}
      <div className="mb-4 flex items-center gap-2">
        <input
          value={newTypeName}
          onChange={(e) => setNewTypeName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") addType();
          }}
          placeholder="Add type rating (e.g. Helicopter, CL30, C680...)"
          className="rounded-lg border border-gray-200 px-3 py-1.5 text-sm outline-none focus:border-gray-400 bg-white w-80"
        />
        <button
          onClick={addType}
          disabled={!newTypeName.trim() || types.includes(newTypeName.trim())}
          className="px-3 py-1.5 text-sm font-medium text-white bg-blue-900 rounded-lg hover:bg-blue-800 transition-colors disabled:opacity-50"
        >
          + Add
        </button>
      </div>

      {/* Type tags */}
      {types.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 mb-5">
          {types.map((type, idx) => {
            const color = TAG_COLORS[idx % TAG_COLORS.length];
            const ad = allData[type];
            const totalPic = ad ? getTotalHours(ad, monthKeys) : 0;
            const isActive = selectedType === type && !showOverall;

            return (
              <button
                key={type}
                onClick={() => {
                  setSelectedType(type);
                  setShowOverall(false);
                }}
                className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium transition-all ${
                  isActive
                    ? `${color.activeBg} ${color.text} ring-2 ${color.ring}`
                    : `${color.bg} ${color.text} hover:${color.activeBg}`
                }`}
              >
                <span>{type}</span>
                {totalPic > 0 && (
                  <span className="text-[10px] font-semibold opacity-70">
                    {totalPic.toFixed(1)} PIC
                  </span>
                )}
                <span
                  onClick={(e) => {
                    e.stopPropagation();
                    removeType(type);
                  }}
                  className="ml-0.5 text-xs opacity-40 hover:opacity-100 cursor-pointer"
                  title="Remove"
                >
                  x
                </span>
              </button>
            );
          })}

          {/* Overall tag */}
          <button
            onClick={() => setShowOverall(true)}
            className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium transition-all ${
              showOverall
                ? "bg-gray-800 text-white ring-2 ring-gray-400"
                : "bg-gray-200 text-gray-700 hover:bg-gray-300"
            }`}
          >
            Overall
            {types.length > 0 && (
              <span className="text-[10px] font-semibold opacity-70">
                {(overallTotals.prior.pic + overallTotals.newEntry.pic).toFixed(1)} PIC
              </span>
            )}
          </button>
        </div>
      )}

      {/* Empty state */}
      {types.length === 0 && (
        <div className="text-center py-16 text-gray-400 text-sm">
          Add a type rating above to start entering logbook data.
        </div>
      )}

      {/* Data grid for selected type */}
      {!showOverall && currentData && currentTotals && selectedType && (
        <div className="bg-white border border-gray-200 rounded-xl overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200 bg-gray-50">
                <th className="px-3 py-2.5 text-left font-medium text-gray-600 whitespace-nowrap sticky left-0 bg-gray-50 z-10 min-w-[160px]">
                  Date
                </th>
                {COLUMNS.map((col) => (
                  <th
                    key={col.key}
                    className="px-2 py-2.5 text-right font-medium text-gray-600 whitespace-nowrap min-w-[100px]"
                  >
                    {col.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {/* Baseline row */}
              <tr className="border-b-2 border-gray-300 bg-blue-50/50">
                <td className="px-3 py-2 font-medium text-gray-700 whitespace-nowrap sticky left-0 bg-blue-50/50 z-10">
                  Hours before {firstMonthLabel}
                </td>
                {COLUMNS.map((col) => (
                  <td key={col.key} className="px-2 py-1.5">
                    <input
                      type="number"
                      step={col.decimal ? "0.1" : "1"}
                      min="0"
                      value={currentData.baseline[col.key]}
                      onChange={(e) =>
                        updateCell(selectedType, "baseline", col.key, e.target.value)
                      }
                      className="w-full text-right rounded border border-gray-200 px-2 py-1 text-sm outline-none focus:border-blue-400 bg-white [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                      placeholder="0"
                    />
                  </td>
                ))}
              </tr>

              <tr>
                <td colSpan={COLUMNS.length + 1} className="h-2" />
              </tr>

              {/* Monthly rows */}
              {months.map(({ label, key }) => (
                <tr key={key} className="border-b border-gray-100 hover:bg-gray-50/50">
                  <td className="px-3 py-2 font-medium text-gray-700 whitespace-nowrap sticky left-0 bg-white z-10">
                    {label}
                  </td>
                  {COLUMNS.map((col) => (
                    <td key={col.key} className="px-2 py-1.5">
                      <input
                        type="number"
                        step={col.decimal ? "0.1" : "1"}
                        min="0"
                        value={currentData.months[key][col.key]}
                        onChange={(e) =>
                          updateCell(selectedType, key, col.key, e.target.value)
                        }
                        className="w-full text-right rounded border border-gray-200 px-2 py-1 text-sm outline-none focus:border-blue-400 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                        placeholder="0"
                      />
                    </td>
                  ))}
                </tr>
              ))}

              <tr>
                <td colSpan={COLUMNS.length + 1} className="h-1" />
              </tr>

              {/* Prior total */}
              <tr className="bg-gray-50">
                <td className="px-3 py-1.5 text-right text-xs font-medium text-gray-500 sticky left-0 bg-gray-50 z-10">
                  Prior total
                </td>
                {COLUMNS.map((col) => (
                  <td key={col.key} className="px-2 py-1.5 text-right text-xs text-gray-600 font-medium">
                    {formatVal(currentTotals.prior[col.key], col.decimal)}
                  </td>
                ))}
              </tr>

              {/* New entry total */}
              <tr className="bg-gray-50">
                <td className="px-3 py-1.5 text-right text-xs font-medium text-gray-500 sticky left-0 bg-gray-50 z-10">
                  New entry total
                </td>
                {COLUMNS.map((col) => (
                  <td key={col.key} className="px-2 py-1.5 text-right text-xs text-gray-600 font-medium">
                    {formatVal(currentTotals.newEntry[col.key], col.decimal)}
                  </td>
                ))}
              </tr>

              {/* Grand total */}
              <tr className="bg-gray-100 font-semibold">
                <td className="px-3 py-2 text-right text-xs font-bold text-gray-700 sticky left-0 bg-gray-100 z-10">
                  Total
                </td>
                {COLUMNS.map((col) => (
                  <td key={col.key} className="px-2 py-2 text-right text-xs text-gray-800">
                    {formatVal(currentTotals.prior[col.key] + currentTotals.newEntry[col.key], col.decimal)}
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
        </div>
      )}

      {/* Overall view */}
      {showOverall && types.length > 0 && (
        <div className="bg-white border border-gray-200 rounded-xl overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200 bg-gray-50">
                <th className="px-3 py-2.5 text-left font-medium text-gray-600 whitespace-nowrap sticky left-0 bg-gray-50 z-10 min-w-[160px]">
                  Date
                </th>
                {COLUMNS.map((col) => (
                  <th
                    key={col.key}
                    className="px-2 py-2.5 text-right font-medium text-gray-600 whitespace-nowrap min-w-[100px]"
                  >
                    {col.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {/* Baseline row */}
              <tr className="border-b-2 border-gray-300 bg-blue-50/50">
                <td className="px-3 py-2 font-medium text-gray-700 whitespace-nowrap sticky left-0 bg-blue-50/50 z-10">
                  Hours before {firstMonthLabel}
                </td>
                {COLUMNS.map((col) => (
                  <td key={col.key} className="px-2 py-2 text-right text-sm text-gray-800">
                    {formatVal(overallBaselineTotals[col.key], col.decimal)}
                  </td>
                ))}
              </tr>

              <tr>
                <td colSpan={COLUMNS.length + 1} className="h-2" />
              </tr>

              {/* Monthly rows */}
              {months.map(({ label, key }) => (
                <tr key={key} className="border-b border-gray-100">
                  <td className="px-3 py-2 font-medium text-gray-700 whitespace-nowrap sticky left-0 bg-white z-10">
                    {label}
                  </td>
                  {COLUMNS.map((col) => (
                    <td key={col.key} className="px-2 py-2 text-right text-sm text-gray-800">
                      {formatVal(overallMonthTotals[key][col.key], col.decimal)}
                    </td>
                  ))}
                </tr>
              ))}

              <tr>
                <td colSpan={COLUMNS.length + 1} className="h-1" />
              </tr>

              {/* Prior total */}
              <tr className="bg-gray-50">
                <td className="px-3 py-1.5 text-right text-xs font-medium text-gray-500 sticky left-0 bg-gray-50 z-10">
                  Prior total
                </td>
                {COLUMNS.map((col) => (
                  <td key={col.key} className="px-2 py-1.5 text-right text-xs text-gray-600 font-medium">
                    {formatVal(overallTotals.prior[col.key], col.decimal)}
                  </td>
                ))}
              </tr>

              {/* New entry total */}
              <tr className="bg-gray-50">
                <td className="px-3 py-1.5 text-right text-xs font-medium text-gray-500 sticky left-0 bg-gray-50 z-10">
                  New entry total
                </td>
                {COLUMNS.map((col) => (
                  <td key={col.key} className="px-2 py-1.5 text-right text-xs text-gray-600 font-medium">
                    {formatVal(overallTotals.newEntry[col.key], col.decimal)}
                  </td>
                ))}
              </tr>

              {/* Grand total */}
              <tr className="bg-gray-100 font-semibold">
                <td className="px-3 py-2 text-right text-xs font-bold text-gray-700 sticky left-0 bg-gray-100 z-10">
                  Total
                </td>
                {COLUMNS.map((col) => (
                  <td key={col.key} className="px-2 py-2 text-right text-xs text-gray-800">
                    {formatVal(overallTotals.prior[col.key] + overallTotals.newEntry[col.key], col.decimal)}
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
        </div>
      )}

      <p className="text-xs text-gray-400 mt-3">
        Data is kept in your browser. Use &ldquo;Export CSV&rdquo; to download
        all type ratings with entered data.
      </p>
    </div>
  );
}
