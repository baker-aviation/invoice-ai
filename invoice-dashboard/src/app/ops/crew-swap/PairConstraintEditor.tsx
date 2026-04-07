"use client";

import { useState } from "react";
import { DAY_LABELS, type SwapDay } from "@/lib/swapDays";

type SwapConstraint =
  | { type: "force_tail"; crew_name: string; tail: string; day?: string; reason?: string }
  | { type: "force_pair"; crew_a: string; crew_b: string; day?: string; reason?: string }
  | { type: "force_fleet"; crew_name: string; aircraft_type: string; day?: string; reason?: string };

type CrewOption = {
  id: string;
  name: string;
  role: "PIC" | "SIC";
  active: boolean;
};

interface PairConstraintEditorProps {
  constraints: SwapConstraint[];
  onConstraintsChange: (constraints: SwapConstraint[]) => void;
  selectedSwapDays: SwapDay[];
  crew: CrewOption[];
  tails: string[];
  /** Slack scan handler */
  onScanSlack?: () => void;
  slackScanLoading?: boolean;
  /** Slack suggestions to accept/dismiss */
  slackSuggestions?: (SwapConstraint & { _reason?: string })[];
  onAcceptSuggestion?: (index: number) => void;
  onDismissSuggestion?: (index: number) => void;
}

type ConstraintType = "force_pair" | "force_tail" | "force_fleet";

const TYPE_LABELS: Record<ConstraintType, string> = {
  force_pair: "Pair Crew",
  force_tail: "Lock to Tail",
  force_fleet: "Lock to Fleet",
};

const TYPE_COLORS: Record<ConstraintType, { bg: string; border: string; text: string; badge: string }> = {
  force_pair: { bg: "bg-purple-50", border: "border-purple-200", text: "text-purple-800", badge: "PAIR" },
  force_tail: { bg: "bg-blue-50", border: "border-blue-200", text: "text-blue-800", badge: "TAIL" },
  force_fleet: { bg: "bg-amber-50", border: "border-amber-200", text: "text-amber-800", badge: "FLEET" },
};

export default function PairConstraintEditor({
  constraints,
  onConstraintsChange,
  selectedSwapDays,
  crew,
  tails,
  onScanSlack,
  slackScanLoading,
  slackSuggestions,
  onAcceptSuggestion,
  onDismissSuggestion,
}: PairConstraintEditorProps) {
  const [newType, setNewType] = useState<ConstraintType>("force_pair");
  const [newDay, setNewDay] = useState<string>("all");
  const [newCrewA, setNewCrewA] = useState("");
  const [newTarget, setNewTarget] = useState("");
  const [newReason, setNewReason] = useState("");

  const activeCrew = crew.filter((c) => c.active).sort((a, b) => a.name.localeCompare(b.name));

  const addConstraint = () => {
    if (!newCrewA || !newTarget) return;
    const day = newDay === "all" ? undefined : newDay;
    const reason = newReason.trim() || undefined;

    let constraint: SwapConstraint;
    if (newType === "force_pair") {
      constraint = { type: "force_pair", crew_a: newCrewA, crew_b: newTarget, day, reason };
    } else if (newType === "force_tail") {
      constraint = { type: "force_tail", crew_name: newCrewA, tail: newTarget, day, reason };
    } else {
      constraint = { type: "force_fleet", crew_name: newCrewA, aircraft_type: newTarget, day, reason };
    }

    onConstraintsChange([...constraints, constraint]);
    setNewCrewA("");
    setNewTarget("");
    setNewReason("");
  };

  const removeConstraint = (index: number) => {
    onConstraintsChange(constraints.filter((_, i) => i !== index));
  };

  const getLabel = (c: SwapConstraint): string => {
    if (c.type === "force_pair") return `${c.crew_a} + ${c.crew_b}`;
    if (c.type === "force_tail") return `${c.crew_name} → ${c.tail}`;
    return `${c.crew_name} → ${c.aircraft_type}`;
  };

  const getDay = (c: SwapConstraint): string | undefined => {
    return c.day ?? undefined;
  };

  return (
    <div className="rounded-lg border bg-white shadow-sm overflow-hidden">
      <div className="px-4 py-3 bg-gray-50 border-b flex items-center justify-between">
        <h3 className="text-sm font-semibold text-gray-700 uppercase tracking-wider">6. Constraints & Pairings</h3>
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-gray-400">Pair crew, lock to tail/fleet, day-specific</span>
          {onScanSlack && (
            <button
              onClick={onScanSlack}
              disabled={slackScanLoading}
              className={`px-2.5 py-1 text-[10px] font-medium rounded border ${
                slackScanLoading
                  ? "bg-gray-100 text-gray-400 border-gray-200 cursor-wait"
                  : "bg-indigo-50 text-indigo-700 border-indigo-200 hover:bg-indigo-100"
              }`}
            >
              {slackScanLoading ? "Scanning..." : "Scan Slack"}
            </button>
          )}
        </div>
      </div>
      <div className="p-4 text-xs space-y-3">
        {/* Slack suggestions */}
        {slackSuggestions && slackSuggestions.length > 0 && (
          <div className="space-y-2">
            <p className="text-[10px] text-indigo-600 font-semibold uppercase tracking-wider">Suggested from Slack</p>
            <div className="flex flex-wrap gap-2">
              {slackSuggestions.map((s, i) => {
                const colors = TYPE_COLORS[s.type];
                return (
                  <div key={`sug-${i}`} className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-medium border border-dashed ${colors.bg} ${colors.border} ${colors.text}`}>
                    <span className="font-bold">{colors.badge}</span>
                    {getLabel(s)}
                    {s.reason && <span className="text-gray-500 italic">({s.reason.length > 40 ? s.reason.slice(0, 40) + "..." : s.reason})</span>}
                    <button onClick={() => onAcceptSuggestion?.(i)} className="ml-0.5 text-green-600 hover:text-green-800 font-bold">&#x2713;</button>
                    <button onClick={() => onDismissSuggestion?.(i)} className="text-red-400 hover:text-red-600">&times;</button>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Active constraints */}
        {constraints.length === 0 && (!slackSuggestions || slackSuggestions.length === 0) && (
          <p className="text-gray-400 italic text-[11px]">No constraints set. Add below to pair crew, lock to a tail, or restrict to a fleet type.</p>
        )}
        {constraints.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {constraints.map((c, i) => {
              const colors = TYPE_COLORS[c.type];
              const day = getDay(c);
              return (
                <div key={i} className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-medium border ${colors.bg} ${colors.border} ${colors.text}`}>
                  <span className="font-bold">{colors.badge}</span>
                  {day && <span className={`px-1 py-0 rounded text-[8px] ${day === "wednesday" ? "bg-green-100 text-green-700" : "bg-blue-100 text-blue-700"}`}>{DAY_LABELS[day as SwapDay] ?? day}</span>}
                  {getLabel(c)}
                  {c.reason && <span className="text-gray-500">({c.reason})</span>}
                  <button onClick={() => removeConstraint(i)} className="ml-1 text-red-400 hover:text-red-600">&times;</button>
                </div>
              );
            })}
          </div>
        )}

        {/* Add form */}
        <div className="border rounded p-3 bg-gray-50 space-y-2">
          <div className="grid grid-cols-6 gap-2 items-end">
            <div>
              <label className="text-[10px] text-gray-500">Type</label>
              <select
                value={newType}
                onChange={(e) => { setNewType(e.target.value as ConstraintType); setNewTarget(""); }}
                className="text-xs border rounded px-2 py-1.5 w-full bg-white"
              >
                {Object.entries(TYPE_LABELS).map(([k, v]) => (
                  <option key={k} value={k}>{v}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-[10px] text-gray-500">Day</label>
              <select
                value={newDay}
                onChange={(e) => setNewDay(e.target.value)}
                className="text-xs border rounded px-2 py-1.5 w-full bg-white"
              >
                <option value="all">All days</option>
                {selectedSwapDays.map((d) => (
                  <option key={d} value={d}>{DAY_LABELS[d]}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-[10px] text-gray-500">{newType === "force_pair" ? "Crew A" : "Crew"}</label>
              <select
                value={newCrewA}
                onChange={(e) => setNewCrewA(e.target.value)}
                className="text-xs border rounded px-2 py-1.5 w-full bg-white"
              >
                <option value="">Select crew...</option>
                {activeCrew.map((c) => (
                  <option key={c.id} value={c.name}>{c.name} ({c.role})</option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-[10px] text-gray-500">
                {newType === "force_pair" ? "Crew B" : newType === "force_tail" ? "Tail" : "Fleet"}
              </label>
              {newType === "force_pair" ? (
                <select
                  value={newTarget}
                  onChange={(e) => setNewTarget(e.target.value)}
                  className="text-xs border rounded px-2 py-1.5 w-full bg-white"
                >
                  <option value="">Select crew...</option>
                  {activeCrew.filter((c) => c.name !== newCrewA).map((c) => (
                    <option key={c.id} value={c.name}>{c.name} ({c.role})</option>
                  ))}
                </select>
              ) : newType === "force_tail" ? (
                <select
                  value={newTarget}
                  onChange={(e) => setNewTarget(e.target.value)}
                  className="text-xs border rounded px-2 py-1.5 w-full bg-white"
                >
                  <option value="">Select tail...</option>
                  {tails.map((t) => (
                    <option key={t} value={t}>{t}</option>
                  ))}
                </select>
              ) : (
                <select
                  value={newTarget}
                  onChange={(e) => setNewTarget(e.target.value)}
                  className="text-xs border rounded px-2 py-1.5 w-full bg-white"
                >
                  <option value="">Select fleet...</option>
                  <option value="citation_x">Citation X</option>
                  <option value="challenger">Challenger</option>
                </select>
              )}
            </div>
            <div>
              <label className="text-[10px] text-gray-500">Reason</label>
              <input
                type="text"
                value={newReason}
                onChange={(e) => setNewReason(e.target.value)}
                placeholder="Check ride, training..."
                className="text-xs border rounded px-2 py-1.5 w-full bg-white"
                onKeyDown={(e) => { if (e.key === "Enter") addConstraint(); }}
              />
            </div>
            <button
              onClick={addConstraint}
              disabled={!newCrewA || !newTarget}
              className="px-3 py-1.5 text-xs font-medium bg-blue-600 text-white rounded hover:bg-blue-700 disabled:bg-gray-300"
            >
              Add
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
