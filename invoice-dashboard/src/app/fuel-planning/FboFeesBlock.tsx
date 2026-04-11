"use client";

import React, { useEffect, useMemo, useState } from "react";

export type LegFeeQuery = {
  airport: string;
  fbo_name: string;
  aircraft_type: string;
};

type FeeResult = LegFeeQuery & {
  handling_fee: number | null;
  gallons_to_waive: number | null;
  landing_fee: number | null;
  security_fee: number | null;
  overnight_fee: number | null;
  source: "direct" | "website" | "jetinsight" | "mixed" | null;
};

function fmtDollars(n: number | null | undefined): string {
  if (n == null) return "—";
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

function fmtGal(n: number | null | undefined): string {
  if (n == null) return "—";
  return `${n.toLocaleString("en-US")} gal`;
}

export default function FboFeesBlock({
  legs,
  onEditMissing,
}: {
  legs: LegFeeQuery[];
  onEditMissing?: (q: LegFeeQuery) => void;
}) {
  const [results, setResults] = useState<FeeResult[] | null>(null);
  const [loading, setLoading] = useState(false);

  const key = useMemo(
    () => legs.map((l) => `${l.airport}|${l.fbo_name}|${l.aircraft_type}`).join("__"),
    [legs],
  );

  useEffect(() => {
    if (!legs.length) return;
    setLoading(true);
    fetch("/api/fuel-planning/fbo-fees-lookup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items: legs }),
    })
      .then((r) => r.json())
      .then((data) => setResults(data.results ?? []))
      .catch(() => setResults([]))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  if (!legs.length) return null;

  return (
    <div className="rounded-lg border border-slate-200 bg-white overflow-hidden">
      <div className="px-4 py-2 bg-slate-50 border-b border-slate-100">
        <span className="text-sm font-semibold text-slate-900">FBO Fees</span>
        <span className="text-xs text-slate-500 ml-2">Per leg at departure FBO</span>
      </div>
      <div className="divide-y divide-slate-100">
        {legs.map((leg, i) => {
          const r = results?.[i];
          const hasData = r && r.source != null;
          return (
            <div key={i} className="px-4 py-2 flex items-center justify-between flex-wrap gap-2 text-xs">
              <div className="flex items-center gap-2 min-w-[180px]">
                <span className="font-semibold text-slate-800">{leg.airport}</span>
                <span className="text-slate-500 truncate max-w-[200px]">{leg.fbo_name || "—"}</span>
              </div>
              {loading ? (
                <span className="text-slate-400">Loading…</span>
              ) : hasData ? (
                <div className="flex items-center gap-3 flex-wrap">
                  <span className="text-slate-700">
                    <span className="text-slate-400">Handling</span> {fmtDollars(r.handling_fee)}
                  </span>
                  <span className="text-slate-700">
                    <span className="text-slate-400">Waive @</span> {fmtGal(r.gallons_to_waive)}
                  </span>
                  {r.landing_fee != null && (
                    <span className="text-slate-700">
                      <span className="text-slate-400">Landing</span> {fmtDollars(r.landing_fee)}
                    </span>
                  )}
                  {r.security_fee != null && (
                    <span className="text-slate-700">
                      <span className="text-slate-400">Ramp</span> {fmtDollars(r.security_fee)}
                    </span>
                  )}
                  {r.overnight_fee != null && (
                    <span className="text-slate-700">
                      <span className="text-slate-400">Overnight</span> {fmtDollars(r.overnight_fee)}
                    </span>
                  )}
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <span className="text-amber-600">No fee data</span>
                  {onEditMissing && (
                    <button
                      onClick={() => onEditMissing(leg)}
                      className="text-blue-600 hover:text-blue-700 underline"
                    >
                      Add
                    </button>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
