"use client";

import { useState, useEffect, useCallback } from "react";

type Suggestion = { id: string; name: string; confidence: number };
type UnmatchedEntry = {
  sheet_name: string;
  direction: string;
  role: string;
  suggestions: Suggestion[];
};

interface NameResolutionPanelProps {
  selectedWeek: string;
  /** Trigger re-check after sync */
  syncCounter: number;
  onResolved?: () => void;
}

export default function NameResolutionPanel({ selectedWeek, syncCounter, onResolved }: NameResolutionPanelProps) {
  const [loading, setLoading] = useState(false);
  const [unmatched, setUnmatched] = useState<UnmatchedEntry[]>([]);
  const [matchedCount, setMatchedCount] = useState(0);
  const [totalNames, setTotalNames] = useState(0);
  const [linking, setLinking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const checkMismatches = useCallback(async () => {
    if (!selectedWeek) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/crew/name-mismatches?sheet_name=${encodeURIComponent(selectedWeek)}`);
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      setUnmatched(data.unmatched ?? []);
      setMatchedCount(data.matched_count ?? 0);
      setTotalNames(data.total_names ?? 0);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to check names");
    } finally {
      setLoading(false);
    }
  }, [selectedWeek]);

  useEffect(() => {
    checkMismatches();
  }, [checkMismatches, syncCounter]);

  const linkName = async (sheetName: string, crewMemberId: string) => {
    setLinking(sheetName);
    try {
      const res = await fetch("/api/crew/name-aliases", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          crew_member_id: crewMemberId,
          source: "sheet",
          alias_name: sheetName,
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      // Remove from unmatched list
      setUnmatched((prev) => prev.filter((u) => u.sheet_name !== sheetName));
      setMatchedCount((prev) => prev + 1);
      onResolved?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to link name");
    } finally {
      setLinking(null);
    }
  };

  const createCrewMember = async (entry: UnmatchedEntry) => {
    setLinking(entry.sheet_name);
    try {
      // Create via roster sync endpoint which handles auto-creation
      const res = await fetch("/api/crew/roster", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "create_crew_member",
          name: entry.sheet_name,
          role: entry.role,
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      // Re-check mismatches
      await checkMismatches();
      onResolved?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create crew member");
    } finally {
      setLinking(null);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 px-3 py-2 text-xs text-gray-500 bg-gray-50 rounded-lg border">
        <svg className="animate-spin h-3.5 w-3.5" viewBox="0 0 24 24">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
        Checking name matches...
      </div>
    );
  }

  if (error) {
    return (
      <div className="px-3 py-2 text-xs text-red-700 bg-red-50 rounded-lg border border-red-200">
        {error}
      </div>
    );
  }

  if (unmatched.length === 0) {
    if (totalNames === 0) return null;
    return (
      <div className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-emerald-700 bg-emerald-50 rounded-lg border border-emerald-200">
        <span>✓</span>
        <span>All {matchedCount} crew names matched successfully</span>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50 text-xs">
      <div className="flex items-center justify-between px-3 py-2 text-amber-800">
        <span className="font-semibold">
          {unmatched.length} unmatched name{unmatched.length !== 1 ? "s" : ""} — link to existing crew or create new
        </span>
        <span className="text-gray-500">{matchedCount}/{totalNames} matched</span>
      </div>
      <div className="border-t border-amber-200 divide-y divide-amber-100">
        {unmatched.map((entry) => (
          <div key={entry.sheet_name} className="px-3 py-2 flex items-center gap-3">
            <div className="flex-1 min-w-0">
              <div className="font-medium text-gray-900">{entry.sheet_name}</div>
              <div className="text-gray-500">
                {entry.direction} {entry.role}
              </div>
            </div>
            {entry.suggestions.length > 0 ? (
              <select
                className="text-xs border rounded px-2 py-1 bg-white max-w-[200px]"
                defaultValue=""
                disabled={linking === entry.sheet_name}
                onChange={(e) => {
                  if (e.target.value) linkName(entry.sheet_name, e.target.value);
                }}
              >
                <option value="">Link to...</option>
                {entry.suggestions.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} ({s.confidence}%)
                  </option>
                ))}
              </select>
            ) : (
              <span className="text-gray-400 italic">No close matches</span>
            )}
            <button
              onClick={() => createCrewMember(entry)}
              disabled={linking === entry.sheet_name}
              className="px-2 py-1 text-xs font-medium bg-blue-50 text-blue-700 border border-blue-200 rounded hover:bg-blue-100 whitespace-nowrap"
            >
              {linking === entry.sheet_name ? "..." : "Create New"}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
