"use client";

import { useMemo } from "react";
import { DAY_LABELS, sortDays, type SwapDay } from "@/lib/swapDays";

type SwapPlanResult = {
  ok: boolean;
  swap_date: string;
  rows: { name: string; tail_number: string; role: string; direction: string; travel_type: string; cost_estimate?: number | null; score?: number }[];
  total_cost: number;
  plan_score: number;
  solved_count?: number;
  unsolved_count?: number;
};

interface DayResultsTabsProps {
  dayPlans: Record<string, SwapPlanResult>;
  activePlanDay: SwapDay;
  onSelectDay: (day: SwapDay) => void;
  /** Called when user clicks "Combined" to merge all plans */
  onSelectCombined: () => void;
}

export default function DayResultsTabs({ dayPlans, activePlanDay, onSelectDay, onSelectCombined }: DayResultsTabsProps) {
  const days = useMemo(() => {
    return sortDays(Object.keys(dayPlans) as SwapDay[]);
  }, [dayPlans]);

  if (days.length <= 1) return null;

  return (
    <div className="px-4 py-2 border-b bg-gradient-to-r from-blue-50 to-green-50">
      <div className="flex items-center gap-3">
        <span className="text-xs font-semibold text-gray-600">View:</span>
        <div className="inline-flex rounded-lg border overflow-hidden">
          {days.map((day) => {
            const plan = dayPlans[day];
            if (!plan) return null;
            const isActive = activePlanDay === day;
            return (
              <button
                key={day}
                onClick={() => onSelectDay(day)}
                className={`px-3 py-1 text-xs font-medium border-l first:border-l-0 ${
                  isActive ? "bg-blue-500 text-white" : "bg-white text-gray-600 hover:bg-blue-50"
                }`}
              >
                {DAY_LABELS[day]} ({plan.rows?.length ?? 0} crew, ${plan.total_cost?.toLocaleString()})
              </button>
            );
          })}
          <button
            onClick={onSelectCombined}
            className="px-3 py-1 text-xs font-medium bg-white text-gray-600 hover:bg-gray-50 border-l"
          >
            Combined
          </button>
          {days.length >= 2 && (
            <button
              onClick={() => {/* handled by parent rendering CompareView */}}
              className="px-3 py-1 text-xs font-medium bg-white text-purple-600 hover:bg-purple-50 border-l"
              data-compare-tab
            >
              Compare
            </button>
          )}
        </div>
      </div>

      {/* Compare view inline */}
      {days.length >= 2 && (
        <CompareTable dayPlans={dayPlans} days={days} />
      )}
    </div>
  );
}

function CompareTable({ dayPlans, days }: { dayPlans: Record<string, SwapPlanResult>; days: SwapDay[] }) {
  // Build a table: one row per tail, columns per day
  const allTails = useMemo(() => {
    const tails = new Set<string>();
    for (const plan of Object.values(dayPlans)) {
      for (const row of plan.rows ?? []) {
        if (row.tail_number) tails.add(row.tail_number);
      }
    }
    return [...tails].sort();
  }, [dayPlans]);

  if (allTails.length === 0) return null;

  return (
    <details className="mt-2">
      <summary className="text-[10px] text-purple-600 cursor-pointer hover:text-purple-800 font-medium">
        Compare plans side-by-side ({allTails.length} tails)
      </summary>
      <div className="mt-2 overflow-x-auto">
        <table className="w-full text-[10px] border-collapse">
          <thead>
            <tr className="border-b">
              <th className="text-left py-1 pr-2 font-semibold text-gray-600">Tail</th>
              {days.map((day) => (
                <th key={day} className="text-left py-1 px-2 font-semibold text-gray-600 min-w-[150px]">
                  {DAY_LABELS[day]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {allTails.map((tail) => {
              const cells = days.map((day) => {
                const plan = dayPlans[day];
                const rows = (plan?.rows ?? []).filter((r) => r.tail_number === tail);
                const oncoming = rows.filter((r) => r.direction === "oncoming");
                const cost = rows.reduce((sum, r) => sum + (r.cost_estimate ?? 0), 0);
                const solved = rows.some((r) => r.travel_type && r.travel_type !== "none");
                return { rows, oncoming, cost, solved };
              });

              // Highlight cells where plans differ
              const crewSets = cells.map((c) => c.oncoming.map((r) => r.name).sort().join(", "));
              const allSame = crewSets.every((s) => s === crewSets[0]);

              return (
                <tr key={tail}>
                  <td className="py-1 pr-2 font-mono font-semibold text-gray-700">{tail}</td>
                  {cells.map((cell, i) => (
                    <td
                      key={days[i]}
                      className={`py-1 px-2 ${
                        cell.rows.length === 0
                          ? "text-gray-300"
                          : !cell.solved
                          ? "bg-red-50 text-red-700"
                          : !allSame
                          ? "bg-yellow-50"
                          : "bg-green-50 text-green-800"
                      }`}
                    >
                      {cell.rows.length === 0 ? (
                        <span className="italic">—</span>
                      ) : (
                        <div>
                          <div>{cell.oncoming.map((r) => r.name).join(", ") || "—"}</div>
                          <div className="text-gray-400">${cell.cost.toLocaleString()}</div>
                        </div>
                      )}
                    </td>
                  ))}
                </tr>
              );
            })}
            {/* Summary row */}
            <tr className="border-t-2 font-semibold">
              <td className="py-1.5 pr-2 text-gray-700">Total</td>
              {days.map((day) => {
                const plan = dayPlans[day];
                return (
                  <td key={day} className="py-1.5 px-2 text-gray-700">
                    {plan ? (
                      <div>
                        <span className="text-green-700">{plan.solved_count ?? 0} solved</span>
                        {(plan.unsolved_count ?? 0) > 0 && (
                          <span className="text-red-600 ml-1">/ {plan.unsolved_count} unsolved</span>
                        )}
                        <div className="text-gray-500">${plan.total_cost?.toLocaleString()}</div>
                      </div>
                    ) : "—"}
                  </td>
                );
              })}
            </tr>
          </tbody>
        </table>
      </div>
    </details>
  );
}
