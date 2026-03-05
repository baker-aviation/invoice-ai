"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

const COMMON_RATINGS = [
  "CE-750",
  "CL-300",
  "CE-500",
  "CE-525",
  "CE-550",
  "CE-560",
  "CE-680",
  "HS-125",
  "DA-50",
  "RA-390",
  "LR-JET",
  "BE-400",
  "GV",
  "G-IV",
];

export default function TypeRatingsEditor({
  applicationId,
  initialRatings,
  initialHasCitationX,
  initialHasChallenger300,
}: {
  applicationId: number;
  initialRatings: string[];
  initialHasCitationX: boolean | null;
  initialHasChallenger300: boolean | null;
}) {
  const [editing, setEditing] = useState(false);
  const [ratings, setRatings] = useState<string[]>(initialRatings);
  const [newRating, setNewRating] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  function addRating(code: string) {
    const trimmed = code.trim().toUpperCase();
    if (!trimmed || ratings.includes(trimmed)) return;
    setRatings([...ratings, trimmed]);
    setNewRating("");
  }

  function removeRating(code: string) {
    setRatings(ratings.filter((r) => r !== code));
  }

  // Derive booleans from the ratings list
  function hasCitationX(list: string[]): boolean {
    return list.some((r) => {
      const u = r.toUpperCase();
      return u.includes("CE-750") || u.includes("CE750") || u.includes("C750") || u.includes("CITATION X");
    });
  }

  function hasChallenger(list: string[]): boolean {
    return list.some((r) => {
      const u = r.toUpperCase();
      return u.includes("CL-300") || u.includes("CL300") || u.includes("CL-350") || u.includes("CL350") || u.includes("CHALLENGER 300") || u.includes("CHALLENGER 350");
    });
  }

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/jobs/${applicationId}/ratings`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type_ratings: ratings,
          has_citation_x: hasCitationX(ratings),
          has_challenger_300_type_rating: hasChallenger(ratings),
        }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Save failed");
      }
      setEditing(false);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  if (!editing) {
    return (
      <button
        onClick={() => setEditing(true)}
        className="text-xs text-blue-600 hover:text-blue-800 font-medium ml-2"
      >
        Edit
      </button>
    );
  }

  return (
    <div className="mt-2 border border-gray-200 rounded-lg p-3 space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-gray-600">Edit Type Ratings</span>
        <button
          onClick={() => { setEditing(false); setRatings(initialRatings); setError(null); }}
          className="text-gray-400 hover:text-gray-600 text-lg leading-none"
        >
          &times;
        </button>
      </div>

      {/* Current ratings as removable chips */}
      <div className="flex flex-wrap gap-1.5">
        {ratings.map((r) => (
          <span
            key={r}
            className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium bg-gray-50"
          >
            {r}
            <button
              onClick={() => removeRating(r)}
              className="text-gray-400 hover:text-red-500 text-sm leading-none"
            >
              &times;
            </button>
          </span>
        ))}
        {ratings.length === 0 && (
          <span className="text-xs text-gray-400">No ratings</span>
        )}
      </div>

      {/* Add rating */}
      <div className="flex gap-2">
        <input
          value={newRating}
          onChange={(e) => setNewRating(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addRating(newRating); } }}
          placeholder="Add rating code..."
          className="flex-1 rounded border border-gray-300 px-2 py-1 text-xs outline-none focus:border-blue-400"
        />
        <button
          onClick={() => addRating(newRating)}
          disabled={!newRating.trim()}
          className="text-xs px-2 py-1 rounded border border-gray-300 hover:bg-gray-50 font-medium disabled:opacity-40"
        >
          Add
        </button>
      </div>

      {/* Quick-add common ratings */}
      <div className="flex flex-wrap gap-1">
        {COMMON_RATINGS.filter((r) => !ratings.includes(r)).slice(0, 8).map((r) => (
          <button
            key={r}
            onClick={() => addRating(r)}
            className="text-[10px] px-1.5 py-0.5 rounded border border-dashed border-gray-300 text-gray-500 hover:bg-gray-50 hover:text-gray-700"
          >
            + {r}
          </button>
        ))}
      </div>

      {/* Preview derived booleans */}
      <div className="text-[11px] text-gray-500 space-x-3">
        <span>Citation X (CE-750): {hasCitationX(ratings) ? "Yes" : "No"}</span>
        <span>Challenger 300 (CL-300): {hasChallenger(ratings) ? "Yes" : "No"}</span>
      </div>

      {error && (
        <div className="text-xs text-red-600 bg-red-50 rounded p-1.5">{error}</div>
      )}

      <button
        onClick={handleSave}
        disabled={saving}
        className="text-xs px-3 py-1.5 rounded bg-slate-800 text-white hover:bg-slate-700 font-medium disabled:opacity-40"
      >
        {saving ? "Saving..." : "Save Ratings"}
      </button>
    </div>
  );
}
