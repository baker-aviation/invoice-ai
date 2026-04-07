"use client";

import { ALL_SWAP_DAYS, DAY_LABELS, getEligibleDays, sortDays, type SwapDay, type VolunteerPreference } from "@/lib/swapDays";

interface DaySelectorProps {
  selectedDays: SwapDay[];
  onDaysChange: (days: SwapDay[]) => void;
  /** Volunteer pool stats per day — how many E/L/SB are available */
  volunteerCounts?: Record<SwapDay, { early: number; late: number; standby: number }>;
}

export default function DaySelector({ selectedDays, onDaysChange, volunteerCounts }: DaySelectorProps) {
  const toggleDay = (day: SwapDay) => {
    if (selectedDays.includes(day)) {
      // Don't allow deselecting the last day
      if (selectedDays.length === 1) return;
      onDaysChange(sortDays(selectedDays.filter((d) => d !== day)));
    } else {
      onDaysChange(sortDays([...selectedDays, day]));
    }
  };

  return (
    <div className="flex items-center gap-1">
      <span className="text-[10px] text-gray-400 mr-1">Swap day:</span>
      {ALL_SWAP_DAYS.map((day) => {
        const selected = selectedDays.includes(day);
        const isWednesday = day === "wednesday";
        const counts = volunteerCounts?.[day];

        return (
          <button
            key={day}
            onClick={() => toggleDay(day)}
            className={`relative px-2 py-1 text-[10px] font-medium rounded border transition-colors ${
              selected
                ? isWednesday
                  ? "bg-blue-600 text-white border-blue-600"
                  : "bg-blue-100 text-blue-800 border-blue-300"
                : "bg-white text-gray-500 border-gray-200 hover:bg-gray-50"
            }`}
          >
            {DAY_LABELS[day]}
            {/* Volunteer counts badge for non-Wednesday days */}
            {!isWednesday && counts && selected && (
              <div className="absolute -top-3 left-1/2 -translate-x-1/2 flex gap-0.5">
                {counts.early > 0 && (
                  <span className="inline-block px-1 py-0 text-[7px] rounded bg-blue-100 text-blue-700">
                    E:{counts.early}
                  </span>
                )}
                {counts.late > 0 && (
                  <span className="inline-block px-1 py-0 text-[7px] rounded bg-purple-100 text-purple-700">
                    L:{counts.late}
                  </span>
                )}
                {counts.standby > 0 && (
                  <span className="inline-block px-1 py-0 text-[7px] rounded bg-amber-100 text-amber-700">
                    SB:{counts.standby}
                  </span>
                )}
              </div>
            )}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Small badge component for volunteer preference, used inline with crew names.
 */
export function VolunteerBadge({ preference }: { preference: VolunteerPreference }) {
  if (!preference) return null;
  const config: Record<string, { label: string; className: string }> = {
    early: { label: "E", className: "bg-blue-100 text-blue-700" },
    late: { label: "L", className: "bg-purple-100 text-purple-700" },
    standby: { label: "SB", className: "bg-amber-100 text-amber-700" },
  };
  const c = config[preference];
  if (!c) return null;
  return (
    <span className={`inline-block px-1 py-0 text-[8px] font-semibold rounded ${c.className}`}>
      {c.label}
    </span>
  );
}
