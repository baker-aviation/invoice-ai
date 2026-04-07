"use client";

import { useState } from "react";
import { DAY_LABELS, type SwapDay } from "@/lib/swapDays";

type DailyPair = {
  crew_a: string;
  crew_b: string;
  day: SwapDay;
  reason: string;
};

type CrewOption = {
  id: string;
  name: string;
  role: "PIC" | "SIC";
  active: boolean;
};

interface PairConstraintEditorProps {
  pairs: DailyPair[];
  onPairsChange: (pairs: DailyPair[]) => void;
  selectedSwapDays: SwapDay[];
  crew: CrewOption[];
}

export default function PairConstraintEditor({
  pairs,
  onPairsChange,
  selectedSwapDays,
  crew,
}: PairConstraintEditorProps) {
  const [newDay, setNewDay] = useState<SwapDay>(selectedSwapDays[0] ?? "wednesday");
  const [newCrewA, setNewCrewA] = useState("");
  const [newCrewB, setNewCrewB] = useState("");
  const [newReason, setNewReason] = useState("");

  const addPair = () => {
    if (!newCrewA || !newCrewB || newCrewA === newCrewB) return;
    onPairsChange([
      ...pairs,
      { crew_a: newCrewA, crew_b: newCrewB, day: newDay, reason: newReason },
    ]);
    setNewCrewA("");
    setNewCrewB("");
    setNewReason("");
  };

  const removePair = (index: number) => {
    onPairsChange(pairs.filter((_, i) => i !== index));
  };

  const activeCrew = crew.filter((c) => c.active).sort((a, b) => a.name.localeCompare(b.name));

  // Group pairs by day
  const pairsByDay = new Map<SwapDay, DailyPair[]>();
  for (const pair of pairs) {
    const existing = pairsByDay.get(pair.day) ?? [];
    existing.push(pair);
    pairsByDay.set(pair.day, existing);
  }

  return (
    <div className="rounded-lg border p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-gray-700 uppercase tracking-wider">Daily Crew Pairs</h3>
        <span className="text-xs text-gray-400">Pair crew members on specific days (check rides, training)</span>
      </div>
      <p className="text-xs text-gray-500">
        Define who flies with whom on each day. Pairs are day-specific — &quot;A with B on Tuesday&quot; won&apos;t apply on Wednesday.
      </p>

      {/* Existing pairs grouped by day */}
      {pairs.length > 0 && (
        <div className="space-y-2">
          {[...pairsByDay.entries()].map(([day, dayPairs]) => (
            <div key={day}>
              <div className="text-[10px] font-semibold text-gray-500 uppercase mb-1">{DAY_LABELS[day]}</div>
              <div className="space-y-1">
                {dayPairs.map((pair) => {
                  const idx = pairs.indexOf(pair);
                  return (
                    <div key={idx} className="flex items-center justify-between bg-gray-50 rounded px-3 py-1.5">
                      <div className="flex items-center gap-2">
                        <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${
                          day === "wednesday" ? "bg-green-100 text-green-700" : "bg-blue-100 text-blue-700"
                        }`}>{DAY_LABELS[day]}</span>
                        <span className="text-xs font-medium">{pair.crew_a}</span>
                        <span className="text-[10px] text-gray-400">+</span>
                        <span className="text-xs font-medium">{pair.crew_b}</span>
                        {pair.reason && <span className="text-[10px] text-gray-400">({pair.reason})</span>}
                      </div>
                      <button onClick={() => removePair(idx)} className="text-xs text-red-500 hover:text-red-700">
                        Remove
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Add new pair form */}
      <div className="grid grid-cols-5 gap-2 items-end">
        <div>
          <label className="text-[10px] text-gray-500">Day</label>
          <select
            value={newDay}
            onChange={(e) => setNewDay(e.target.value as SwapDay)}
            className="text-xs border rounded px-2 py-1.5 w-full"
          >
            {selectedSwapDays.map((d) => (
              <option key={d} value={d}>{DAY_LABELS[d]}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="text-[10px] text-gray-500">Crew A</label>
          <select
            value={newCrewA}
            onChange={(e) => setNewCrewA(e.target.value)}
            className="text-xs border rounded px-2 py-1.5 w-full"
          >
            <option value="">Select...</option>
            {activeCrew.map((c) => (
              <option key={c.id} value={c.name}>{c.name} ({c.role})</option>
            ))}
          </select>
        </div>
        <div>
          <label className="text-[10px] text-gray-500">Crew B</label>
          <select
            value={newCrewB}
            onChange={(e) => setNewCrewB(e.target.value)}
            className="text-xs border rounded px-2 py-1.5 w-full"
          >
            <option value="">Select...</option>
            {activeCrew
              .filter((c) => c.name !== newCrewA)
              .map((c) => (
                <option key={c.id} value={c.name}>{c.name} ({c.role})</option>
              ))}
          </select>
        </div>
        <div>
          <label className="text-[10px] text-gray-500">Reason</label>
          <input
            type="text"
            value={newReason}
            onChange={(e) => setNewReason(e.target.value)}
            placeholder="Check ride, training..."
            className="text-xs border rounded px-2 py-1.5 w-full"
            onKeyDown={(e) => { if (e.key === "Enter") addPair(); }}
          />
        </div>
        <button
          onClick={addPair}
          disabled={!newCrewA || !newCrewB || newCrewA === newCrewB}
          className="px-3 py-1.5 text-xs font-medium bg-blue-50 text-blue-700 border border-blue-200 rounded hover:bg-blue-100 disabled:bg-gray-100 disabled:text-gray-400"
        >
          Add Pair
        </button>
      </div>
    </div>
  );
}
