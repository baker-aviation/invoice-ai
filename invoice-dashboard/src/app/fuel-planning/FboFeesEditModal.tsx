"use client";

import React, { useState } from "react";
import type { LegFeeQuery } from "./FboFeesBlock";

export default function FboFeesEditModal({
  target,
  onClose,
  onSaved,
}: {
  target: LegFeeQuery;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [facility, setFacility] = useState("");
  const [waive, setWaive] = useState("");
  const [landing, setLanding] = useState("");
  const [security, setSecurity] = useState("");
  const [overnight, setOvernight] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const parseNum = (s: string): number | null => {
    if (!s.trim()) return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/fuel-planning/fbo-fees-upsert", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          airport: target.airport,
          fbo_name: target.fbo_name,
          aircraft_type: target.aircraft_type,
          facility_fee: parseNum(facility),
          gallons_to_waive: parseNum(waive),
          landing_fee: parseNum(landing),
          security_fee: parseNum(security),
          overnight_fee: parseNum(overnight),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Failed to save");
        return;
      }
      onSaved();
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-md rounded-lg bg-white shadow-xl">
        <div className="px-5 py-4 border-b border-slate-200">
          <h3 className="text-base font-semibold text-slate-900">Add FBO Fees</h3>
          <p className="mt-1 text-xs text-slate-500">
            {target.fbo_name} · {target.airport} · {target.aircraft_type}
          </p>
        </div>
        <div className="px-5 py-4 space-y-3">
          {[
            { label: "Handling / Facility", value: facility, set: setFacility, placeholder: "$" },
            { label: "Gallons to Waive", value: waive, set: setWaive, placeholder: "gal" },
            { label: "Landing Fee", value: landing, set: setLanding, placeholder: "$" },
            { label: "Security / Ramp Fee", value: security, set: setSecurity, placeholder: "$" },
            { label: "Overnight Fee", value: overnight, set: setOvernight, placeholder: "$" },
          ].map((field) => (
            <div key={field.label} className="flex items-center gap-3">
              <label className="text-xs text-slate-600 w-40">{field.label}</label>
              <input
                type="number"
                step="0.01"
                value={field.value}
                onChange={(e) => field.set(e.target.value)}
                placeholder={field.placeholder}
                className="flex-1 text-sm border border-slate-300 rounded px-2 py-1.5"
              />
            </div>
          ))}
          {error && <p className="text-xs text-red-600">{error}</p>}
        </div>
        <div className="px-5 py-3 border-t border-slate-200 flex justify-end gap-2">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-sm text-slate-600 hover:text-slate-800"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="px-4 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-500 disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
