"use client";

import React, { useState, useEffect, useCallback } from "react";

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

export default function FleetFuelDashboard() {
  const [dateStr, setDateStr] = useState(() => {
    // Default to tomorrow
    const d = new Date();
    d.setDate(d.getDate() + 1);
    return d.toISOString().split("T")[0];
  });
  const [plans, setPlans] = useState<TailPlan[]>([]);
  const [releases, setReleases] = useState<FuelRelease[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState<Record<string, boolean>>({});

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

  // Get release for a specific tail + leg index
  const getRelease = (tail: string, legIndex: number): FuelRelease | undefined => {
    return releases.find(
      (r) => r.tail_number === tail && r.plan_leg_index === legIndex && r.status !== "cancelled",
    );
  };

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
        }),
      });

      if (res.ok) {
        // Refresh releases
        const relRes = await fetch(`/api/fuel-releases?date=${dateStr}`, { credentials: "include" });
        if (relRes.ok) {
          const relData = await relRes.json();
          setReleases(relData.releases ?? []);
        }
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
                                onClick={() => submitRelease(tailPlan, i)}
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
