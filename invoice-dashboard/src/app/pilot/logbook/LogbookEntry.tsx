"use client";

import { useState, useCallback } from "react";

const AIRCRAFT_TYPES = [
  "Helicopter",
  "Other",
  "76 Duchess / BE76 - dual engine",
  "182 / untyped aircraft",
  "single-engine non-turbine / untyped aircraft",
  "multi-engine non-turbine / untyped aircraft",
  "single-engine turbine / untyped aircraft",
  "multi-engine turbine / untyped aircraft",
] as const;

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

export default function LogbookEntry() {
  const months = getLast12Months();
  const monthKeys = months.map((m) => m.key);

  const [selectedType, setSelectedType] = useState<string>(AIRCRAFT_TYPES[0]);
  const [allData, setAllData] = useState<Record<string, AircraftData>>(() =>
    Object.fromEntries(
      AIRCRAFT_TYPES.map((t) => [t, emptyAircraftData(monthKeys)])
    )
  );

  const data = allData[selectedType];

  const updateCell = useCallback(
    (rowKey: string, colKey: ColumnKey, value: string) => {
      setAllData((prev) => {
        const aircraft = { ...prev[selectedType] };
        if (rowKey === "baseline") {
          aircraft.baseline = { ...aircraft.baseline, [colKey]: value };
        } else {
          aircraft.months = {
            ...aircraft.months,
            [rowKey]: { ...aircraft.months[rowKey], [colKey]: value },
          };
        }
        return { ...prev, [selectedType]: aircraft };
      });
    },
    [selectedType]
  );

  // Compute totals
  const priorTotals: Record<ColumnKey, number> = {} as Record<ColumnKey, number>;
  const newTotals: Record<ColumnKey, number> = {} as Record<ColumnKey, number>;
  for (const col of COLUMNS) {
    priorTotals[col.key] = parseNum(data.baseline[col.key]);
    newTotals[col.key] = monthKeys.reduce(
      (sum, mk) => sum + parseNum(data.months[mk][col.key]),
      0
    );
  }

  function formatVal(val: number, decimal: boolean): string {
    return decimal ? val.toFixed(1) : String(Math.round(val));
  }

  function exportCSV() {
    // Build CSV for ALL aircraft types that have data
    const lines: string[] = [];
    const header = ["Aircraft Type", "Date", ...COLUMNS.map((c) => c.label)];
    lines.push(header.join(","));

    for (const type of AIRCRAFT_TYPES) {
      const ad = allData[type];
      const hasData = [ad.baseline, ...monthKeys.map((mk) => ad.months[mk])].some(
        (row) => COLUMNS.some((c) => parseNum(row[c.key]) !== 0)
      );
      if (!hasData) continue;

      // Baseline row
      const firstMonth = months[0];
      const baselineLabel = `Hours before ${firstMonth.label}`;
      lines.push(
        [
          `"${type}"`,
          `"${baselineLabel}"`,
          ...COLUMNS.map((c) => parseNum(ad.baseline[c.key])),
        ].join(",")
      );

      // Monthly rows
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

  return (
    <div>
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-5">
        <h1 className="text-xl font-bold text-gray-900">Logbook Entry</h1>
        <button
          onClick={exportCSV}
          className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-white bg-blue-900 rounded-lg hover:bg-blue-800 transition-colors"
        >
          Export CSV
        </button>
      </div>

      {/* Aircraft type selector */}
      <div className="mb-4 flex items-center gap-3">
        <label className="text-sm font-medium text-gray-700">For type:</label>
        <select
          value={selectedType}
          onChange={(e) => setSelectedType(e.target.value)}
          className="rounded-lg border border-gray-200 px-3 py-1.5 text-sm outline-none focus:border-gray-400 bg-white"
        >
          {AIRCRAFT_TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </div>

      {/* Data grid */}
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
                    value={data.baseline[col.key]}
                    onChange={(e) =>
                      updateCell("baseline", col.key, e.target.value)
                    }
                    className="w-full text-right rounded border border-gray-200 px-2 py-1 text-sm outline-none focus:border-blue-400 bg-white [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                    placeholder="0"
                  />
                </td>
              ))}
            </tr>

            {/* Spacer */}
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
                      value={data.months[key][col.key]}
                      onChange={(e) =>
                        updateCell(key, col.key, e.target.value)
                      }
                      className="w-full text-right rounded border border-gray-200 px-2 py-1 text-sm outline-none focus:border-blue-400 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                      placeholder="0"
                    />
                  </td>
                ))}
              </tr>
            ))}

            {/* Spacer before totals */}
            <tr>
              <td colSpan={COLUMNS.length + 1} className="h-1" />
            </tr>

            {/* Prior total */}
            <tr className="bg-gray-50">
              <td className="px-3 py-1.5 text-right text-xs font-medium text-gray-500 sticky left-0 bg-gray-50 z-10">
                Prior total
              </td>
              {COLUMNS.map((col) => (
                <td
                  key={col.key}
                  className="px-2 py-1.5 text-right text-xs text-gray-600 font-medium"
                >
                  {formatVal(priorTotals[col.key], col.decimal)}
                </td>
              ))}
            </tr>

            {/* New entry total */}
            <tr className="bg-gray-50">
              <td className="px-3 py-1.5 text-right text-xs font-medium text-gray-500 sticky left-0 bg-gray-50 z-10">
                New entry total
              </td>
              {COLUMNS.map((col) => (
                <td
                  key={col.key}
                  className="px-2 py-1.5 text-right text-xs text-gray-600 font-medium"
                >
                  {formatVal(newTotals[col.key], col.decimal)}
                </td>
              ))}
            </tr>

            {/* Grand total */}
            <tr className="bg-gray-100 font-semibold">
              <td className="px-3 py-2 text-right text-xs font-bold text-gray-700 sticky left-0 bg-gray-100 z-10">
                Total
              </td>
              {COLUMNS.map((col) => (
                <td
                  key={col.key}
                  className="px-2 py-2 text-right text-xs text-gray-800"
                >
                  {formatVal(
                    priorTotals[col.key] + newTotals[col.key],
                    col.decimal
                  )}
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>

      <p className="text-xs text-gray-400 mt-3">
        Data is kept in your browser. Use &ldquo;Export CSV&rdquo; to download
        all aircraft types with entered data.
      </p>
    </div>
  );
}
