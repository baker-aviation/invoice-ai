"use client";

import { useState, useEffect, useCallback } from "react";
import { STD_AIRCRAFT, type AircraftType } from "@/app/tanker/model";

// No auth required — public page with token-based access

type LegData = {
  from: string;
  to: string;
  fuelToDestLbs: number;
  totalFuelLbs: number;
  flightTimeHours: number;
  departurePricePerGal: number;
  departureFboVendor: string | null;
  departureFbo: string | null;
  ffSource: string;
  waiver: {
    fboName: string;
    minGallons: number;
    feeWaived: number;
    landingFee: number;
    securityFee: number;
    overnightFee: number;
  };
};

type MultiLegPlan = {
  tankerOutByStop: number[];
  tankerInByStop: number[];
  fuelOrderLbsByStop: number[];
  fuelOrderGalByStop: number[];
  landingFuelByStop: number[];
  feePaidByStop: number[];
  totalFuelCost: number;
  totalFees: number;
  totalTripCost: number;
};

type PlanData = {
  tail: string;
  aircraftType: AircraftType;
  shutdownFuel: number;
  shutdownAirport: string;
  legs: LegData[];
  plan: MultiLegPlan | null;
  naiveCost: number;
  tankerSavings: number;
};

export default function SharedPlanPage({ params }: { params: Promise<{ token: string }> }) {
  const [token, setToken] = useState<string | null>(null);
  const [plan, setPlan] = useState<PlanData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [date, setDate] = useState<string>("");
  const [expiresAt, setExpiresAt] = useState<string>("");
  const [recalculating, setRecalculating] = useState(false);

  // Per-leg weight overrides
  const [mlwOverrides, setMlwOverrides] = useState<Record<string, number>>({});
  const [zfwOverrides, setZfwOverrides] = useState<Record<string, number>>({});

  // Resolve params
  useEffect(() => {
    params.then((p) => setToken(p.token));
  }, [params]);

  const loadPlan = useCallback(async () => {
    if (!token) return;
    try {
      const res = await fetch(`/api/fuel-planning/shared-plan/${token}`);
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Failed to load plan");
        return;
      }
      setPlan(data.plan);
      setDate(data.date);
      setExpiresAt(data.expires_at);
    } catch {
      setError("Failed to load plan");
    }
    setLoading(false);
  }, [token]);

  useEffect(() => { loadPlan(); }, [loadPlan]);

  const recalculate = async () => {
    if (!token) return;
    setRecalculating(true);
    try {
      const res = await fetch(`/api/fuel-planning/shared-plan/${token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mlw_overrides: mlwOverrides, zfw_overrides: zfwOverrides }),
      });
      const data = await res.json();
      if (res.ok && data.plan) {
        setPlan(data.plan);
      }
    } catch { /* ignore */ }
    setRecalculating(false);
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <p className="text-gray-500 animate-pulse">Loading fuel plan...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-center">
          <h1 className="text-xl font-bold text-gray-800 mb-2">Plan Unavailable</h1>
          <p className="text-gray-500">{error}</p>
        </div>
      </div>
    );
  }

  if (!plan) return null;

  const acDefaults = STD_AIRCRAFT[plan.aircraftType] ?? STD_AIRCRAFT["CE-750"];
  const acLabel = plan.aircraftType === "CE-750" ? "Citation X" : plan.aircraftType === "CL-30" ? "Challenger 300" : plan.aircraftType;
  const optimized = plan.plan;
  const route = [plan.shutdownAirport, ...plan.legs.map((l) => l.to)].join(" → ");
  const savings = Math.round(plan.tankerSavings);

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <div className="bg-white border-b border-gray-200 px-6 py-4">
        <div className="max-w-4xl mx-auto">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-xl font-bold text-gray-900">{plan.tail} Fuel Plan</h1>
              <p className="text-sm text-gray-500">{acLabel} — {date}</p>
            </div>
            <div className="text-right">
              {savings > 0 && (
                <span className="inline-block bg-green-100 text-green-800 text-sm font-semibold px-3 py-1 rounded-full">
                  Saves ~${savings.toLocaleString()}
                </span>
              )}
              <p className="text-xs text-gray-400 mt-1">
                Expires {new Date(expiresAt).toLocaleString()}
              </p>
            </div>
          </div>
          <p className="text-sm text-gray-600 mt-1 font-mono">{route}</p>
        </div>
      </div>

      <div className="max-w-4xl mx-auto px-6 py-6 space-y-6">
        {/* Shutdown fuel */}
        <div className="bg-white rounded-lg border border-gray-200 px-4 py-3">
          <p className="text-sm text-gray-600">
            <span className="font-medium">Shutdown Fuel:</span>{" "}
            {plan.shutdownFuel.toLocaleString()} lbs at {plan.shutdownAirport}
          </p>
        </div>

        {/* Legs table */}
        <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="text-left px-4 py-2 font-medium text-gray-600">Leg</th>
                <th className="text-right px-4 py-2 font-medium text-gray-600">Burn</th>
                <th className="text-right px-4 py-2 font-medium text-gray-600">Time</th>
                <th className="text-right px-4 py-2 font-medium text-gray-600">$/gal</th>
                <th className="text-right px-4 py-2 font-medium text-gray-600">Order</th>
                <th className="text-right px-4 py-2 font-medium text-gray-600">Landing Fuel</th>
                <th className="text-left px-4 py-2 font-medium text-gray-600">FBO</th>
                <th className="text-right px-4 py-2 font-medium text-gray-600">Fee</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {plan.legs.map((leg, i) => {
                const orderLbs = optimized?.fuelOrderLbsByStop?.[i] ?? 0;
                const orderGal = optimized?.fuelOrderGalByStop?.[i] ?? 0;
                const landingFuel = optimized?.landingFuelByStop?.[i] ?? 0;
                const feePaid = optimized?.feePaidByStop?.[i] ?? 0;
                const tankerOut = optimized?.tankerOutByStop?.[i] ?? 0;

                return (
                  <tr key={i} className={tankerOut > 0 ? "bg-blue-50" : ""}>
                    <td className="px-4 py-2 font-medium">
                      {leg.from} → {leg.to}
                      {tankerOut > 0 && (
                        <span className="ml-2 text-xs text-blue-600 font-semibold">
                          +{tankerOut.toLocaleString()} lbs tanker
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2 text-right text-gray-600">{leg.fuelToDestLbs.toLocaleString()}</td>
                    <td className="px-4 py-2 text-right text-gray-600">{leg.flightTimeHours.toFixed(1)}h</td>
                    <td className="px-4 py-2 text-right text-gray-600">${leg.departurePricePerGal.toFixed(2)}</td>
                    <td className="px-4 py-2 text-right font-medium">
                      {orderLbs > 0 ? (
                        <span>
                          {orderLbs.toLocaleString()} lbs
                          <span className="text-gray-400 text-xs ml-1">({orderGal.toLocaleString()} gal)</span>
                        </span>
                      ) : (
                        <span className="text-gray-400">—</span>
                      )}
                    </td>
                    <td className="px-4 py-2 text-right text-gray-600">{landingFuel.toLocaleString()}</td>
                    <td className="px-4 py-2 text-gray-500 text-xs">
                      {leg.waiver?.fboName || leg.departureFbo || "—"}
                    </td>
                    <td className="px-4 py-2 text-right text-gray-600">
                      {feePaid > 0 ? `$${feePaid.toLocaleString()}` : <span className="text-green-600 text-xs">waived</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Totals */}
        {optimized && (
          <div className="bg-white rounded-lg border border-gray-200 px-4 py-3">
            <div className="flex justify-between text-sm">
              <span className="text-gray-600">Total Fuel Cost</span>
              <span className="font-medium">${optimized.totalFuelCost.toLocaleString()}</span>
            </div>
            <div className="flex justify-between text-sm mt-1">
              <span className="text-gray-600">Total Fees</span>
              <span className="font-medium">${optimized.totalFees.toLocaleString()}</span>
            </div>
            <div className="flex justify-between text-sm mt-1 pt-1 border-t border-gray-200">
              <span className="font-semibold text-gray-800">Total Trip Cost</span>
              <span className="font-bold">${optimized.totalTripCost.toLocaleString()}</span>
            </div>
            {savings > 0 && (
              <div className="flex justify-between text-sm mt-1">
                <span className="text-green-700 font-medium">Tankering Savings</span>
                <span className="text-green-700 font-bold">${savings.toLocaleString()}</span>
              </div>
            )}
          </div>
        )}

        {/* Adjustable weights */}
        <div className="bg-white rounded-lg border border-gray-200 px-4 py-4">
          <h3 className="text-sm font-semibold text-gray-800 mb-3">Adjust Weights</h3>
          <p className="text-xs text-gray-500 mb-3">
            Change MLW or ZFW per leg and recalculate. Defaults: MLW {acDefaults.mlw.toLocaleString()} lbs, ZFW {acDefaults.zfw.toLocaleString()} lbs
          </p>
          <div className="space-y-2">
            {plan.legs.map((leg, i) => (
              <div key={i} className="flex items-center gap-4 text-sm">
                <span className="w-28 text-gray-600 font-medium">{leg.from} → {leg.to}</span>
                <div className="flex items-center gap-1">
                  <label className="text-xs text-gray-500">MLW</label>
                  <input
                    type="number"
                    value={mlwOverrides[String(i)] ?? acDefaults.mlw}
                    onChange={(e) => setMlwOverrides({ ...mlwOverrides, [String(i)]: parseInt(e.target.value) || acDefaults.mlw })}
                    className="w-24 text-xs border border-gray-300 rounded px-2 py-1 text-right"
                  />
                </div>
                <div className="flex items-center gap-1">
                  <label className="text-xs text-gray-500">ZFW</label>
                  <input
                    type="number"
                    value={zfwOverrides[String(i)] ?? acDefaults.zfw}
                    onChange={(e) => setZfwOverrides({ ...zfwOverrides, [String(i)]: parseInt(e.target.value) || acDefaults.zfw })}
                    className="w-24 text-xs border border-gray-300 rounded px-2 py-1 text-right"
                  />
                </div>
              </div>
            ))}
          </div>
          <button
            onClick={recalculate}
            disabled={recalculating}
            className="mt-4 px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors"
          >
            {recalculating ? "Recalculating..." : "Recalculate Plan"}
          </button>
        </div>

        {/* Footer */}
        <p className="text-center text-xs text-gray-400">
          Baker Aviation Fuel Planning — link expires {new Date(expiresAt).toLocaleString()}
        </p>
      </div>
    </div>
  );
}
