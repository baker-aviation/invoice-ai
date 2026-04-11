"use client";

import React, { useState, useEffect, useCallback, useRef } from "react";
import Link from "next/link";

type LegData = {
  from: string;
  to: string;
  departureDate?: string;
  fuelToDestLbs: number;
  flightTimeHours: number;
  departurePricePerGal: number;
  departureFboVendor: string | null;
  departureFbo: string | null;
  ffSource: string;
  waiver: {
    fboName: string;
    minGallons: number;
    feeWaived: number;
  };
};

type MultiLegPlan = {
  fuelOrderLbsByStop: number[];
  fuelOrderGalByStop: number[];
  feePaidByStop: number[];
  tankerOutByStop: number[];
  totalFuelCost: number;
  totalFees: number;
  totalTripCost: number;
};

type TailPlan = {
  tail: string;
  aircraftType: string;
  shutdownFuel: number;
  shutdownAirport: string;
  legs: LegData[];
  plan: MultiLegPlan | null;
  naiveCost: number;
  tankerSavings: number;
};

type FuelRelease = {
  id: string;
  tail_number: string;
  airport_code: string;
  fbo_name: string | null;
  vendor_name: string;
  gallons_requested: number;
  quoted_price: number | null;
  status: string;
  departure_date: string;
  plan_link_token: string | null;
  plan_leg_index: number | null;
  created_at: string;
};

type PreviewData = {
  releaseType: string;
  vendor: string;
  to: string | null;
  subject: string | null;
  html: string | null;
  message: string | null;
  editable?: {
    notes: string;
    gallons: number;
    fbo: string;
    destination: string;
    requiresDestination: boolean;
  };
};

type PendingRelease = {
  tailPlan: TailPlan;
  legIndex: number;
  leg: LegData;
  orderGal: number;
};

function fmtNum(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

function fmtDollars(n: number): string {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 });
}

function strip(c: string): string {
  return c.length === 4 && c.startsWith("K") ? c.slice(1) : c;
}

const STATUS_COLORS: Record<string, string> = {
  pending: "bg-gray-100 text-gray-700",
  confirmed: "bg-green-100 text-green-700",
  completed: "bg-green-200 text-green-800",
  rejected: "bg-red-100 text-red-700",
  failed: "bg-red-100 text-red-700",
  cancelled: "bg-yellow-100 text-yellow-700",
};

// ─── Preview Modal ──────────────────────────────────────────────────────────

function ReleasePreviewModal({
  pending,
  dateStr,
  onClose,
  onSent,
}: {
  pending: PendingRelease;
  dateStr: string;
  onClose: () => void;
  onSent: () => void;
}) {
  const [preview, setPreview] = useState<PreviewData | null>(null);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [editNotes, setEditNotes] = useState("");
  const [editDestination, setEditDestination] = useState("");
  const iframeRef = useRef<HTMLIFrameElement>(null);

  const { tailPlan, legIndex, leg, orderGal } = pending;

  // Fetch preview on mount
  useEffect(() => {
    (async () => {
      setLoading(true);
      setError("");
      try {
        const res = await fetch("/api/fuel-releases/preview", {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            airport: leg.from,
            fbo: leg.departureFbo || leg.waiver?.fboName || "",
            tailNumber: tailPlan.tail,
            vendorName: leg.departureFboVendor || "",
            gallons: Math.round(orderGal),
            quotedPrice: leg.departurePricePerGal > 0 ? leg.departurePricePerGal : undefined,
            date: leg.departureDate || dateStr,
          }),
        });
        if (!res.ok) throw new Error("Failed to generate preview");
        const data: PreviewData = await res.json();
        setPreview(data);
        setEditNotes(data.editable?.notes ?? "");
        setEditDestination(data.editable?.destination ?? "");
      } catch (err) {
        setError(err instanceof Error ? err.message : "Preview failed");
      } finally {
        setLoading(false);
      }
    })();
  }, [leg, tailPlan, orderGal, dateStr, legIndex]);

  // Write HTML to iframe when preview loads
  useEffect(() => {
    if (preview?.html && iframeRef.current) {
      const doc = iframeRef.current.contentDocument;
      if (doc) {
        doc.open();
        doc.write(preview.html);
        doc.close();
      }
    }
  }, [preview?.html]);

  const handleSend = async () => {
    setSending(true);
    setError("");
    try {
      const res = await fetch("/api/fuel-releases/submit", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          airport: leg.from,
          fbo: leg.departureFbo || leg.waiver?.fboName || "",
          tailNumber: tailPlan.tail,
          vendorName: leg.departureFboVendor || "",
          gallons: Math.round(orderGal),
          quotedPrice: leg.departurePricePerGal > 0 ? leg.departurePricePerGal : undefined,
          date: leg.departureDate || dateStr,
          notes: editNotes || editDestination || undefined,
          planLegIndex: legIndex,
        }),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json.error || "Submit failed");
      }
      onSent();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Send failed");
      setSending(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div
        className="bg-white rounded-xl shadow-2xl w-full max-w-2xl max-h-[90vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between">
          <div>
            <h3 className="text-lg font-bold text-gray-900">
              Fuel Release Preview
            </h3>
            <p className="text-sm text-gray-500">
              {tailPlan.tail} &mdash; {strip(leg.from)} &rarr; {strip(leg.to)} &mdash; {fmtNum(orderGal)} gal
            </p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none">&times;</button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
          {loading && (
            <div className="text-center py-8 text-gray-500 animate-pulse">Generating email preview...</div>
          )}

          {error && (
            <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">{error}</div>
          )}

          {preview && !loading && (
            <>
              {/* Email metadata */}
              {preview.to ? (
                <div className="space-y-2">
                  <div className="flex gap-2 text-sm">
                    <span className="font-medium text-gray-500 w-16">To:</span>
                    <span className="text-gray-900 font-mono">{preview.to}</span>
                  </div>
                  <div className="flex gap-2 text-sm">
                    <span className="font-medium text-gray-500 w-16">From:</span>
                    <span className="text-gray-900 font-mono">operations@baker-aviation.com</span>
                  </div>
                  <div className="flex gap-2 text-sm">
                    <span className="font-medium text-gray-500 w-16">Subject:</span>
                    <span className="text-gray-900">{preview.subject}</span>
                  </div>
                  <div className="flex gap-2 text-sm">
                    <span className="font-medium text-gray-500 w-16">Vendor:</span>
                    <span className="inline-block px-2 py-0.5 text-xs font-medium rounded-full bg-blue-100 text-blue-700">
                      {preview.vendor}
                    </span>
                  </div>
                </div>
              ) : (
                <div className="p-4 bg-amber-50 border border-amber-200 rounded-lg text-amber-800 text-sm">
                  {preview.message}
                </div>
              )}

              {/* Email body preview */}
              {preview.html && (
                <div className="border border-gray-200 rounded-lg overflow-hidden">
                  <div className="px-3 py-1.5 bg-gray-50 border-b border-gray-200 text-xs font-medium text-gray-500">
                    Email Preview
                  </div>
                  <iframe
                    ref={iframeRef}
                    title="Email preview"
                    className="w-full border-0"
                    style={{ height: "360px" }}
                    sandbox="allow-same-origin"
                  />
                </div>
              )}

              {/* Editable fields */}
              {preview.editable?.requiresDestination && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Destination (required by {preview.vendor})
                  </label>
                  <input
                    type="text"
                    value={editDestination}
                    onChange={(e) => setEditDestination(e.target.value)}
                    placeholder="e.g. EGLL, London Heathrow"
                    className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-500"
                  />
                </div>
              )}

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Notes (optional)
                </label>
                <textarea
                  value={editNotes}
                  onChange={(e) => setEditNotes(e.target.value)}
                  rows={2}
                  placeholder="Add any notes for the vendor..."
                  className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-500 resize-none"
                />
              </div>
            </>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-gray-200 flex justify-end gap-3">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm font-medium rounded-md bg-gray-100 text-gray-700 hover:bg-gray-200"
          >
            Cancel
          </button>
          {preview?.to ? (
            <button
              onClick={handleSend}
              disabled={sending || loading}
              className="px-5 py-2 text-sm font-medium rounded-md bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {sending ? "Sending..." : "Send Release Email"}
            </button>
          ) : preview && !preview.to ? (
            <button
              onClick={handleSend}
              disabled={sending || loading}
              className="px-5 py-2 text-sm font-medium rounded-md bg-slate-900 text-white hover:bg-slate-700 disabled:opacity-50"
            >
              {sending ? "Submitting..." : "Submit Release (Manual)"}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

// ─── Main Dashboard ─────────────────────────────────────────────────────────

export default function FleetFuelDashboard() {
  const [dateStr, setDateStr] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    return d.toISOString().split("T")[0];
  });
  const [plans, setPlans] = useState<TailPlan[]>([]);
  const [releases, setReleases] = useState<FuelRelease[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState<Record<string, boolean>>({});
  const [previewPending, setPreviewPending] = useState<PendingRelease | null>(null);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [planRes, relRes] = await Promise.all([
        fetch("/api/fuel-planning/generate", {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ date: dateStr }),
        }),
        fetch(`/api/fuel-releases?date=${dateStr}`, { credentials: "include" }),
      ]);

      if (planRes.ok) {
        const planData = await planRes.json();
        setPlans(planData.plans ?? []);
      } else {
        const errData = await planRes.json().catch(() => ({}));
        setError(errData.error ?? "Failed to generate plans");
      }

      if (relRes.ok) {
        const relData = await relRes.json();
        setReleases(relData.releases ?? []);
      }
    } catch {
      setError("Failed to load data");
    }
    setLoading(false);
  }, [dateStr]);

  useEffect(() => { loadData(); }, [loadData]);

  const refreshReleases = async () => {
    const relRes = await fetch(`/api/fuel-releases?date=${dateStr}`, { credentials: "include" });
    if (relRes.ok) {
      const relData = await relRes.json();
      setReleases(relData.releases ?? []);
    }
  };

  const getRelease = (tail: string, legIndex: number): FuelRelease | undefined => {
    return releases.find(
      (r) => r.tail_number === tail && r.plan_leg_index === legIndex && r.status !== "cancelled",
    );
  };

  // Open preview modal instead of submitting directly
  const openPreview = (tailPlan: TailPlan, legIndex: number) => {
    const leg = tailPlan.legs[legIndex];
    const orderGal = tailPlan.plan?.fuelOrderGalByStop[legIndex] ?? 0;
    if (orderGal <= 0) return;
    setPreviewPending({ tailPlan, legIndex, leg, orderGal });
  };

  // Legacy direct submit (used by "Request All")
  const submitRelease = async (tailPlan: TailPlan, legIndex: number) => {
    const leg = tailPlan.legs[legIndex];
    const orderGal = tailPlan.plan?.fuelOrderGalByStop[legIndex] ?? 0;
    if (orderGal <= 0) return;

    const key = `${tailPlan.tail}-${legIndex}`;
    setSubmitting((prev) => ({ ...prev, [key]: true }));

    try {
      const res = await fetch("/api/fuel-releases/submit", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          airport: leg.from,
          fbo: leg.departureFbo || leg.waiver?.fboName || "",
          tailNumber: tailPlan.tail,
          vendorName: leg.departureFboVendor || "",
          gallons: Math.round(orderGal),
          quotedPrice: leg.departurePricePerGal > 0 ? leg.departurePricePerGal : undefined,
          date: leg.departureDate || dateStr,
          planLegIndex: legIndex,
        }),
      });

      if (res.ok) {
        await refreshReleases();
      }
    } catch { /* ignore */ }

    setSubmitting((prev) => ({ ...prev, [key]: false }));
  };

  const submitAllForTail = async (tailPlan: TailPlan) => {
    if (!tailPlan.plan) return;
    for (let i = 0; i < tailPlan.legs.length; i++) {
      const orderGal = tailPlan.plan.fuelOrderGalByStop[i] ?? 0;
      if (orderGal > 0 && !getRelease(tailPlan.tail, i)) {
        await submitRelease(tailPlan, i);
      }
    }
  };

  // Summary stats
  const totalCost = plans.reduce((s, p) => s + (p.plan?.totalTripCost ?? 0), 0);
  const totalSavings = plans.reduce((s, p) => s + p.tankerSavings, 0);
  const totalReleases = releases.filter((r) => r.status !== "cancelled").length;

  return (
    <div className="space-y-5">
      {/* Preview Modal */}
      {previewPending && (
        <ReleasePreviewModal
          pending={previewPending}
          dateStr={dateStr}
          onClose={() => setPreviewPending(null)}
          onSent={async () => {
            setPreviewPending(null);
            await refreshReleases();
          }}
        />
      )}

      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Fleet Fuel Releases</h1>
          <p className="text-sm text-gray-500 mt-0.5">Review plans and request fuel releases for the fleet</p>
        </div>
        <div className="flex items-center gap-3">
          <input
            type="date"
            value={dateStr}
            onChange={(e) => setDateStr(e.target.value)}
            className="text-sm border border-gray-300 rounded-md px-3 py-1.5"
          />
          <Link
            href="/fuel-dashboard/vendors"
            className="px-3 py-1.5 text-sm font-medium bg-slate-900 text-white rounded-md hover:bg-slate-700 transition-colors"
          >
            Manage Vendors
          </Link>
          <button
            onClick={loadData}
            disabled={loading}
            className="px-3 py-1.5 text-sm font-medium bg-gray-100 text-gray-700 rounded-md hover:bg-gray-200 disabled:opacity-50 transition-colors"
          >
            {loading ? "Loading..." : "Refresh"}
          </button>
        </div>
      </div>

      {/* Summary bar */}
      {!loading && plans.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div className="rounded-lg border border-gray-200 bg-white px-4 py-3">
            <div className="text-xs text-gray-500 uppercase">Tails</div>
            <div className="text-lg font-bold text-gray-900">{plans.length}</div>
          </div>
          <div className="rounded-lg border border-gray-200 bg-white px-4 py-3">
            <div className="text-xs text-gray-500 uppercase">Total Fuel Cost</div>
            <div className="text-lg font-bold text-gray-900">{fmtDollars(totalCost)}</div>
          </div>
          <div className="rounded-lg border border-gray-200 bg-white px-4 py-3">
            <div className="text-xs text-gray-500 uppercase">Savings</div>
            <div className={`text-lg font-bold ${totalSavings > 0 ? "text-green-600" : "text-gray-900"}`}>{fmtDollars(totalSavings)}</div>
          </div>
          <div className="rounded-lg border border-gray-200 bg-white px-4 py-3">
            <div className="text-xs text-gray-500 uppercase">Releases</div>
            <div className="text-lg font-bold text-gray-900">{totalReleases}</div>
          </div>
        </div>
      )}

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
      )}

      {loading && (
        <div className="text-center py-12 text-gray-500 animate-pulse">Generating fuel plans...</div>
      )}

      {/* Tail cards */}
      {!loading && plans.length === 0 && !error && (
        <div className="text-center py-12 text-gray-400">No flights scheduled for {dateStr}</div>
      )}

      <div className="space-y-4">
        {plans.map((tailPlan) => {
          const optimized = tailPlan.plan;
          if (!optimized || tailPlan.legs.length === 0) return null;

          const route = [strip(tailPlan.shutdownAirport), ...tailPlan.legs.map((l) => strip(l.to))].join(" - ");
          const acLabel = tailPlan.aircraftType === "CE-750" ? "Citation X" : tailPlan.aircraftType === "CL-30" ? "Challenger 300" : tailPlan.aircraftType;
          const allRequested = tailPlan.legs.every((_, i) => {
            const orderGal = optimized.fuelOrderGalByStop[i] ?? 0;
            return orderGal <= 0 || !!getRelease(tailPlan.tail, i);
          });

          return (
            <div key={tailPlan.tail} className="rounded-lg border border-gray-200 bg-white overflow-hidden">
              {/* Tail header */}
              <div className="px-4 py-3 bg-gray-50 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-base font-bold text-gray-900">{tailPlan.tail}</span>
                  <span className="text-xs px-2 py-0.5 rounded-full bg-gray-200 text-gray-600">{acLabel}</span>
                  <span className="text-sm text-gray-600">{route}</span>
                </div>
                <div className="flex items-center gap-3">
                  {tailPlan.tankerSavings > 0 && (
                    <span className="text-sm font-semibold text-green-600">Save {fmtDollars(tailPlan.tankerSavings)}</span>
                  )}
                  <span className="text-sm font-semibold text-gray-900">{fmtDollars(optimized.totalTripCost)}</span>
                  <button
                    onClick={() => submitAllForTail(tailPlan)}
                    disabled={allRequested}
                    className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                      allRequested
                        ? "bg-green-100 text-green-700"
                        : "bg-blue-100 text-blue-700 hover:bg-blue-200"
                    }`}
                  >
                    {allRequested ? "All Requested" : "Request All"}
                  </button>
                </div>
              </div>

              {/* Legs table */}
              <div className="px-4 py-3">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs text-gray-500 border-b border-gray-100">
                      <th className="pb-2 pr-3">Leg</th>
                      <th className="pb-2 pr-3">FBO</th>
                      <th className="pb-2 pr-3">Vendor</th>
                      <th className="pb-2 pr-3 text-right">Gallons</th>
                      <th className="pb-2 pr-3 text-right">Price/gal</th>
                      <th className="pb-2 pr-3 text-right">Cost</th>
                      <th className="pb-2 pr-3 text-center">Status</th>
                      <th className="pb-2"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {tailPlan.legs.map((leg, i) => {
                      const orderGal = optimized.fuelOrderGalByStop[i] ?? 0;
                      const feePaid = optimized.feePaidByStop[i] ?? 0;
                      const legCost = orderGal * leg.departurePricePerGal + feePaid;
                      const release = getRelease(tailPlan.tail, i);
                      const isSubmitting = submitting[`${tailPlan.tail}-${i}`];

                      return (
                        <tr key={i} className="border-b border-gray-50">
                          <td className="py-2 pr-3">
                            <span className="font-medium text-gray-900">{strip(leg.from)}</span>
                            <span className="text-gray-400 mx-1">&rarr;</span>
                            <span className="font-medium text-gray-900">{strip(leg.to)}</span>
                          </td>
                          <td className="py-2 pr-3 text-xs text-gray-700 max-w-[140px] truncate">
                            {leg.departureFbo || leg.waiver?.fboName || "—"}
                          </td>
                          <td className="py-2 pr-3 text-xs text-blue-600 max-w-[120px] truncate">
                            {leg.departureFboVendor || "—"}
                          </td>
                          <td className={`py-2 pr-3 text-right font-mono ${orderGal > 0 ? "text-blue-700 font-semibold" : "text-gray-400"}`}>
                            {orderGal > 0 ? fmtNum(orderGal) : "—"}
                          </td>
                          <td className="py-2 pr-3 text-right font-mono text-gray-700">
                            {leg.departurePricePerGal > 0 ? `$${leg.departurePricePerGal.toFixed(2)}` : "—"}
                          </td>
                          <td className="py-2 pr-3 text-right font-mono font-semibold text-gray-900">
                            {legCost > 0 ? fmtDollars(legCost) : "—"}
                          </td>
                          <td className="py-2 pr-3 text-center">
                            {release ? (
                              <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${STATUS_COLORS[release.status] ?? STATUS_COLORS.pending}`}>
                                {release.status}
                              </span>
                            ) : orderGal > 0 ? (
                              <span className="text-xs text-gray-400">—</span>
                            ) : null}
                          </td>
                          <td className="py-2 text-right">
                            {orderGal > 0 && !release && (
                              <button
                                onClick={() => openPreview(tailPlan, i)}
                                disabled={isSubmitting}
                                className="text-xs px-2 py-1 rounded-md bg-blue-100 text-blue-700 font-medium hover:bg-blue-200 transition-colors disabled:opacity-50 whitespace-nowrap"
                              >
                                {isSubmitting ? "..." : "Request"}
                              </button>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
