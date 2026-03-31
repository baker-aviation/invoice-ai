"use client";

import { useState } from "react";

type PinState = {
  pinned: boolean;
  pin_note: string | null;
  pinned_by: string | null;
  pinned_at: string | null;
  pin_resolved: boolean;
  resolved_by: string | null;
  resolved_at: string | null;
  resolve_note: string | null;
};

export default function PinButton({
  documentId,
  initial,
}: {
  documentId: string;
  initial: PinState;
}) {
  const [state, setState] = useState<PinState>(initial);
  const [showForm, setShowForm] = useState(false);
  const [showResolveForm, setShowResolveForm] = useState(false);
  const [note, setNote] = useState(state.pin_note ?? "");
  const [resolveNote, setResolveNote] = useState("");
  const [loading, setLoading] = useState(false);

  const isActive = state.pinned && !state.pin_resolved;

  async function handlePin() {
    setLoading(true);
    try {
      const res = await fetch(`/api/invoices/${documentId}/pin`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ note }),
      });
      if (res.ok) {
        setState((s) => ({
          ...s,
          pinned: true,
          pin_note: note || null,
          pinned_at: new Date().toISOString(),
          pin_resolved: false,
          resolved_by: null,
          resolved_at: null,
        }));
        setShowForm(false);
      } else {
        const data = await res.json().catch(() => ({}));
        alert(`Pin failed: ${data.error ?? res.status}`);
      }
    } finally {
      setLoading(false);
    }
  }

  async function handleUpdateNote() {
    setLoading(true);
    try {
      const res = await fetch(`/api/invoices/${documentId}/pin`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ note }),
      });
      if (res.ok) {
        setState((s) => ({ ...s, pin_note: note || null }));
        setShowForm(false);
      }
    } finally {
      setLoading(false);
    }
  }

  async function handleResolve() {
    setLoading(true);
    try {
      const res = await fetch(`/api/invoices/${documentId}/pin`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ note: resolveNote }),
      });
      if (res.ok) {
        setState((s) => ({
          ...s,
          pin_resolved: true,
          resolve_note: resolveNote || null,
          resolved_at: new Date().toISOString(),
        }));
        setShowResolveForm(false);
        setResolveNote("");
      }
    } finally {
      setLoading(false);
    }
  }

  // Not pinned — show pin button
  if (!state.pinned || state.pin_resolved) {
    return (
      <div className="relative">
        {showForm ? (
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Why does this need review?"
              className="border rounded px-2 py-1.5 text-sm w-64"
              autoFocus
              onKeyDown={(e) => e.key === "Enter" && handlePin()}
            />
            <button
              onClick={handlePin}
              disabled={loading}
              className="rounded-md bg-red-600 px-3 py-1.5 text-sm text-white hover:bg-red-700 disabled:opacity-50"
            >
              {loading ? "…" : "Pin"}
            </button>
            <button
              onClick={() => setShowForm(false)}
              className="text-sm text-gray-500 hover:text-gray-700"
            >
              Cancel
            </button>
          </div>
        ) : (
          <button
            onClick={() => { setNote(""); setShowForm(true); }}
            className="rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-50 flex items-center gap-1.5"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z" />
            </svg>
            {state.pin_resolved ? "Re-pin" : "Pin for Review"}
          </button>
        )}
      </div>
    );
  }

  // Actively pinned — show pin info + actions
  return (
    <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <svg className="w-4 h-4 text-red-600" fill="currentColor" viewBox="0 0 24 24">
              <path d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z" />
            </svg>
            <span className="text-sm font-semibold text-red-800">Pinned for Review</span>
            {state.pinned_by && (
              <span className="text-xs text-red-600">by {state.pinned_by}</span>
            )}
            {state.pinned_at && (
              <span className="text-xs text-red-400">
                {new Date(state.pinned_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
              </span>
            )}
          </div>
          {showForm ? (
            <div className="flex items-center gap-2 mt-2">
              <input
                type="text"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Update note…"
                className="border rounded px-2 py-1 text-sm w-64"
                autoFocus
                onKeyDown={(e) => e.key === "Enter" && handleUpdateNote()}
              />
              <button onClick={handleUpdateNote} disabled={loading} className="text-sm text-blue-600 hover:text-blue-800">
                {loading ? "…" : "Save"}
              </button>
              <button onClick={() => setShowForm(false)} className="text-sm text-gray-500">Cancel</button>
            </div>
          ) : (
            <p className="text-sm text-red-700 mt-1">
              {state.pin_note || "No note"}
              <button
                onClick={() => { setNote(state.pin_note ?? ""); setShowForm(true); }}
                className="ml-2 text-xs text-red-500 hover:text-red-700 underline"
              >
                edit
              </button>
            </p>
          )}
        </div>
        {showResolveForm ? (
          <div className="flex flex-col gap-2 items-end">
            <input
              type="text"
              value={resolveNote}
              onChange={(e) => setResolveNote(e.target.value)}
              placeholder="Review notes…"
              className="border rounded px-2 py-1 text-sm w-56"
              autoFocus
              onKeyDown={(e) => e.key === "Enter" && handleResolve()}
            />
            <div className="flex gap-2">
              <button onClick={() => setShowResolveForm(false)} className="text-xs text-gray-500">Cancel</button>
              <button
                onClick={handleResolve}
                disabled={loading}
                className="rounded-md bg-green-600 px-3 py-1 text-xs text-white hover:bg-green-700 disabled:opacity-50"
              >
                {loading ? "…" : "Mark Reviewed"}
              </button>
            </div>
          </div>
        ) : (
          <button
            onClick={() => setShowResolveForm(true)}
            className="rounded-md border border-green-300 px-3 py-1.5 text-sm text-green-700 hover:bg-green-100 disabled:opacity-50 whitespace-nowrap"
          >
            Mark Reviewed
          </button>
        )}
      </div>
    </div>
  );
}
