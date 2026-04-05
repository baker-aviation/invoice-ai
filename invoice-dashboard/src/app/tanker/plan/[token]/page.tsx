"use client";

import React, { useState, useEffect, useCallback } from "react";
import { STD_AIRCRAFT, type AircraftType } from "@/app/tanker/model";

type LegData = {
  from: string;
  to: string;
  departureDate?: string;
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

function fmtNum(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

function fmtDollars(n: number): string {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 });
}

function fmtHrs(h: number): string {
  const hrs = Math.floor(h);
  const min = Math.round((h - hrs) * 60);
  return hrs > 0 ? `${hrs}h ${min}m` : `${min}m`;
}

export default function SharedPlanPage({ params }: { params: Promise<{ token: string }> }) {
  const [token, setToken] = useState<string | null>(null);
  const [plan, setPlan] = useState<PlanData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [date, setDate] = useState<string>("");
  const [expiresAt, setExpiresAt] = useState<string>("");
  const [recalculating, setRecalculating] = useState(false);
  const [showOverrides, setShowOverrides] = useState(false);
  const [slackSending, setSlackSending] = useState(false);
  const [slackSent, setSlackSent] = useState(false);

  const [mlwOverrides, setMlwOverrides] = useState<Record<string, number>>({});
  const [zfwOverrides, setZfwOverrides] = useState<Record<string, number>>({});
  const [feeOverrides, setFeeOverrides] = useState<Record<string, number>>({});
  const [waiverGalOverrides, setWaiverGalOverrides] = useState<Record<string, number>>({});

  useEffect(() => { params.then((p) => setToken(p.token)); }, [params]);

  const loadPlan = useCallback(async () => {
    if (!token) return;
    try {
      const res = await fetch(`/api/fuel-planning/shared-plan/${token}`);
      const data = await res.json();
      if (!res.ok) { setError(data.error ?? "Failed to load plan"); return; }
      setPlan(data.plan);
      setDate(data.date);
      setExpiresAt(data.expires_at);
    } catch { setError("Failed to load plan"); }
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
        body: JSON.stringify({
          mlw_overrides: mlwOverrides,
          zfw_overrides: zfwOverrides,
          fee_overrides: feeOverrides,
          waiver_gal_overrides: waiverGalOverrides,
        }),
      });
      const data = await res.json();
      if (res.ok && data.plan) setPlan(data.plan);
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

  if (error || !plan) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-center">
          <h1 className="text-xl font-bold text-gray-800 mb-2">Plan Unavailable</h1>
          <p className="text-gray-500">{error ?? "Plan not found"}</p>
        </div>
      </div>
    );
  }

  const acDefaults = STD_AIRCRAFT[plan.aircraftType] ?? STD_AIRCRAFT["CE-750"];
  const acLabel = plan.aircraftType === "CE-750" ? "Citation X" : plan.aircraftType === "CL-30" ? "Challenger 300" : plan.aircraftType;
  const optimized = plan.plan;
  const savings = Math.round(plan.tankerSavings);

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-4 sm:py-6 space-y-4 sm:space-y-5">

        {/* Header */}
        <div className="rounded-lg border border-gray-200 bg-white overflow-hidden">
          <div className="px-4 sm:px-5 py-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 bg-gray-50">
            <div className="flex flex-wrap items-center gap-2 sm:gap-3">
              <span className="text-base font-bold text-gray-900">{plan.tail}</span>
              <span className="text-xs px-2 py-0.5 rounded-full bg-gray-200 text-gray-600">
                {acLabel}
              </span>
              <span className="text-xs text-gray-500">
                {fmtNum(plan.shutdownFuel)} lbs @ {plan.shutdownAirport}
              </span>
            </div>
            <div className="flex items-center gap-3">
              {savings > 0 && (
                <span className="text-sm font-semibold text-green-600">
                  Save {fmtDollars(savings)}
                </span>
              )}
              {optimized && (
                <span className="text-sm font-semibold text-gray-900">
                  {fmtDollars(optimized.totalTripCost)}
                </span>
              )}
              <button
                onClick={async () => {
                  setSlackSending(true);
                  try {
                    const res = await fetch("/api/fuel-planning/create-plan-link", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ tail: plan.tail, aircraftType: plan.aircraftType, date, plan, send_slack: true, mode: "pilot_summary" }),
                    });
                    if (res.ok) setSlackSent(true);
                  } catch { /* ignore */ }
                  setSlackSending(false);
                }}
                disabled={slackSending || slackSent}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                  slackSent ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-600 hover:bg-purple-100 hover:text-purple-700 disabled:opacity-50"
                }`}
              >
                {slackSent ? "Sent" : slackSending ? "..." : "Post to Slack"}
              </button>
            </div>
          </div>

          {optimized && plan.legs.length > 0 && (
            <div className="px-4 sm:px-5 py-4">

              {/* Desktop table — hidden on mobile */}
              <div className="hidden md:block overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs text-gray-500 border-b border-gray-100">
                      <th className="pb-2 pr-3">Leg</th>
                      <th className="pb-2 pr-3 text-right">Fuel Burn</th>
                      <th className="pb-2 pr-3 text-right">Flight Time</th>
                      <th className="pb-2 pr-3 text-right">Price/gal</th>
                      <th className="pb-2 pr-3">FBO</th>
                      <th className="pb-2 pr-3 text-right">Handling Fee</th>
                      <th className="pb-2 pr-3 text-right">Order (lbs)</th>
                      <th className="pb-2 pr-3 text-right">Order (gal)</th>
                      <th className="pb-2 pr-3 text-right">Landing Fuel</th>
                      <th className="pb-2 text-right">Cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {plan.legs.map((leg, i) => {
                      const orderLbs = optimized.fuelOrderLbsByStop[i] ?? 0;
                      const orderGal = optimized.fuelOrderGalByStop[i] ?? 0;
                      const landingFuel = optimized.landingFuelByStop[i] ?? 0;
                      const feePaid = optimized.feePaidByStop[i] ?? 0;
                      const legCost = orderGal * leg.departurePricePerGal + feePaid;
                      const prevDate = i > 0 ? plan.legs[i - 1].departureDate : null;
                      const showDayHeader = leg.departureDate && leg.departureDate !== prevDate;

                      return (<>
                        {showDayHeader && (
                          <tr key={`day-${i}`} className="bg-gray-50">
                            <td colSpan={10} className="py-1.5 px-1 text-xs font-semibold text-gray-500 uppercase tracking-wide">
                              {new Date(leg.departureDate + "T12:00:00").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })}
                            </td>
                          </tr>
                        )}
                        <tr key={i} className="border-b border-gray-50">
                          <td className="py-2.5 pr-3">
                            <span className="font-medium text-gray-900">{leg.from}</span>
                            <span className="text-gray-400 mx-1">&rarr;</span>
                            <span className="font-medium text-gray-900">{leg.to}</span>
                            {leg.ffSource === "estimate" && (
                              <span className="ml-1.5 text-[10px] px-1 py-0.5 rounded bg-amber-100 text-amber-600">EST</span>
                            )}
                          </td>
                          <td className="py-2.5 pr-3 text-right font-mono text-gray-700">{fmtNum(leg.fuelToDestLbs)}</td>
                          <td className="py-2.5 pr-3 text-right text-gray-600">{fmtHrs(leg.flightTimeHours)}</td>
                          <td className="py-2.5 pr-3 text-right font-mono">
                            {leg.departurePricePerGal > 0 ? fmtDollars(leg.departurePricePerGal) : <span className="text-gray-400">N/A</span>}
                          </td>
                          <td className="py-2.5 pr-3 text-xs max-w-[180px]">
                            <div className="text-gray-700 truncate font-medium">{leg.departureFbo || leg.waiver?.fboName || "—"}</div>
                            {leg.waiver?.minGallons > 0 && <div className="text-[10px] text-gray-400">Waive at {fmtNum(leg.waiver.minGallons)} gal</div>}
                            {leg.departureFboVendor && leg.departureFboVendor !== leg.departureFbo && (
                              <div className="text-[10px] text-blue-400 truncate">Fuel: {leg.departureFboVendor}</div>
                            )}
                          </td>
                          <td className="py-2.5 pr-3 text-right text-xs">
                            {leg.waiver?.feeWaived > 0 ? (
                              <div>
                                <span className={`font-mono font-semibold ${feePaid > 0 ? "text-red-600" : "text-green-600"}`}>{fmtDollars(leg.waiver.feeWaived)}</span>
                                <div className={`text-[10px] ${feePaid > 0 ? "text-red-400" : "text-green-500"}`}>{feePaid > 0 ? "not waived" : "waived"}</div>
                              </div>
                            ) : <span className="text-gray-400">—</span>}
                          </td>
                          <td className={`py-2.5 pr-3 text-right font-mono font-semibold ${orderLbs > 0 ? "text-blue-700" : "text-gray-400"}`}>
                            {orderLbs > 0 ? fmtNum(orderLbs) : "—"}
                          </td>
                          <td className={`py-2.5 pr-3 text-right font-mono ${orderGal > 0 ? "text-blue-600" : "text-gray-400"}`}>
                            {orderGal > 0 ? fmtNum(orderGal) : "—"}
                          </td>
                          <td className="py-2.5 pr-3 text-right font-mono text-gray-700">{fmtNum(landingFuel)}</td>
                          <td className="py-2.5 text-right">
                            {legCost > 0 ? (
                              <div>
                                <span className="font-mono font-semibold text-gray-900">{fmtDollars(legCost)}</span>
                                {feePaid > 0 && <div className="text-[10px] text-red-500">+{fmtDollars(feePaid)} fee</div>}
                              </div>
                            ) : <span className="font-mono text-gray-400">—</span>}
                          </td>
                        </tr>
                      </>);
                    })}
                  </tbody>
                  <tfoot>
                    <tr className="border-t border-gray-200">
                      <td colSpan={6} className="py-2.5 text-xs text-gray-500 font-medium">TOTALS</td>
                      <td className="py-2.5 pr-3 text-right font-mono font-bold text-gray-900">{fmtNum(optimized.fuelOrderLbsByStop.reduce((a, b) => a + b, 0))}</td>
                      <td className="py-2.5 pr-3 text-right font-mono font-bold text-gray-900">{fmtNum(optimized.fuelOrderGalByStop.reduce((a, b) => a + b, 0))}</td>
                      <td className="py-2.5 pr-3"></td>
                      <td className="py-2.5 text-right font-mono font-bold text-gray-900">{fmtDollars(optimized.totalTripCost)}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>

              {/* Mobile cards — hidden on desktop */}
              <div className="md:hidden space-y-3">
                {plan.legs.map((leg, i) => {
                  const orderLbs = optimized.fuelOrderLbsByStop[i] ?? 0;
                  const orderGal = optimized.fuelOrderGalByStop[i] ?? 0;
                  const landingFuel = optimized.landingFuelByStop[i] ?? 0;
                  const prevDate = i > 0 ? plan.legs[i - 1].departureDate : null;
                  const showDayHeader = leg.departureDate && leg.departureDate !== prevDate;
                  const feePaid = optimized.feePaidByStop[i] ?? 0;
                  const tankerOut = optimized.tankerOutByStop[i] ?? 0;
                  const legCost = orderGal * leg.departurePricePerGal + feePaid;

                  return (<React.Fragment key={i}>
                    {showDayHeader && (
                      <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide pt-1">
                        {new Date(leg.departureDate + "T12:00:00").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })}
                      </div>
                    )}
                    <div className={`rounded-lg border p-3 ${tankerOut > 0 ? "border-emerald-200 bg-emerald-50/50" : "border-gray-200 bg-white"}`}>
                      {/* Leg header */}
                      <div className="flex items-center justify-between mb-2">
                        <div className="flex items-center gap-1.5">
                          <span className="font-bold text-gray-900">{leg.from}</span>
                          <span className="text-gray-400">&rarr;</span>
                          <span className="font-bold text-gray-900">{leg.to}</span>
                          {leg.ffSource === "estimate" && (
                            <span className="text-[10px] px-1 py-0.5 rounded bg-amber-100 text-amber-600">EST</span>
                          )}
                        </div>
                        <span className="text-xs text-gray-500">{fmtHrs(leg.flightTimeHours)}</span>
                      </div>

                      {/* FBO */}
                      <div className="text-xs text-gray-600 mb-2">
                        <span className="font-medium">{leg.departureFbo || leg.waiver?.fboName || "—"}</span>
                        {leg.departureFboVendor && leg.departureFboVendor !== leg.departureFbo && (
                          <span className="text-blue-500 ml-1">via {leg.departureFboVendor}</span>
                        )}
                      </div>

                      {/* Stats grid */}
                      <div className="grid grid-cols-3 gap-2 text-center">
                        <div className="bg-gray-50 rounded px-2 py-1.5">
                          <div className="text-[10px] text-gray-500 uppercase">Price</div>
                          <div className="text-sm font-mono font-semibold">
                            {leg.departurePricePerGal > 0 ? `$${leg.departurePricePerGal.toFixed(2)}` : "N/A"}
                          </div>
                        </div>
                        <div className="bg-gray-50 rounded px-2 py-1.5">
                          <div className="text-[10px] text-gray-500 uppercase">Order</div>
                          <div className={`text-sm font-mono font-semibold ${orderGal > 0 ? "text-blue-700" : "text-gray-400"}`}>
                            {orderGal > 0 ? `${fmtNum(orderGal)} gal` : "—"}
                          </div>
                        </div>
                        <div className="bg-gray-50 rounded px-2 py-1.5">
                          <div className="text-[10px] text-gray-500 uppercase">Landing</div>
                          <div className="text-sm font-mono font-semibold text-gray-700">{fmtNum(landingFuel)}</div>
                        </div>
                      </div>

                      {/* Tanker badge */}
                      {tankerOut > 0 && (
                        <div className="mt-2 text-xs font-semibold text-emerald-700">
                          Tanker +{fmtNum(tankerOut)} lbs
                        </div>
                      )}

                      {/* Fee + cost row */}
                      <div className="mt-2 flex items-center justify-between text-xs">
                        <div>
                          {leg.waiver?.feeWaived > 0 ? (
                            <span className={feePaid > 0 ? "text-red-600 font-semibold" : "text-green-600 font-semibold"}>
                              {fmtDollars(leg.waiver.feeWaived)} {feePaid > 0 ? "not waived" : "waived"}
                            </span>
                          ) : (
                            <span className="text-gray-400">No handling fee</span>
                          )}
                        </div>
                        {legCost > 0 && (
                          <span className="font-mono font-bold text-gray-900">{fmtDollars(legCost)}</span>
                        )}
                      </div>
                    </div>
                  </React.Fragment>);
                })}

                {/* Mobile totals */}
                <div className="rounded-lg border border-gray-200 bg-white p-3">
                  <div className="flex justify-between text-sm">
                    <span className="text-gray-600 font-medium">Total Fuel</span>
                    <span className="font-mono font-bold">{fmtNum(optimized.fuelOrderGalByStop.reduce((a, b) => a + b, 0))} gal</span>
                  </div>
                  <div className="flex justify-between text-sm mt-1">
                    <span className="text-gray-600 font-medium">Total Cost</span>
                    <span className="font-mono font-bold">{fmtDollars(optimized.totalTripCost)}</span>
                  </div>
                  {savings > 0 && (
                    <div className="flex justify-between text-sm mt-1 pt-1 border-t border-gray-100">
                      <span className="text-green-700 font-semibold">Savings</span>
                      <span className="text-green-700 font-bold">{fmtDollars(savings)}</span>
                    </div>
                  )}
                </div>
              </div>

              {/* Tankering recommendations — responsive */}
              {optimized.tankerOutByStop.some((t) => t > 0) && (
                <div className="mt-3 pt-3 border-t border-gray-100">
                  <p className="text-xs font-medium text-gray-500 mb-2">TANKERING RECOMMENDATIONS</p>
                  <div className="flex flex-wrap gap-2">
                    {optimized.tankerOutByStop.map((tankerOut, i) => {
                      if (tankerOut <= 0) return null;
                      const leg = plan.legs[i];
                      const tankerIn = optimized.tankerInByStop[i] ?? 0;
                      const nextLeg = plan.legs[i + 1];
                      const nextPrice = nextLeg?.departurePricePerGal ?? 0;
                      const isFeeWaiver = leg.departurePricePerGal >= nextPrice && nextPrice > 0;
                      return (
                        <div key={i} className={`text-xs rounded-md px-3 py-1.5 border ${
                          isFeeWaiver ? "bg-blue-50 text-blue-700 border-blue-200" : "bg-emerald-50 text-emerald-700 border-emerald-200"
                        }`}>
                          <span className="font-semibold">{leg.from}</span>: carry +{fmtNum(tankerOut)} lbs
                          <span className={`ml-1 ${isFeeWaiver ? "text-blue-500" : "text-emerald-500"}`}>
                            ({fmtNum(tankerIn)} lbs at {leg.to})
                          </span>
                          {isFeeWaiver && <span className="ml-1.5 text-[10px] px-1.5 py-0.5 rounded bg-blue-100 text-blue-600">FEE WAIVER</span>}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {plan.legs.some((l) => l.ffSource === "estimate") && (
                <p className="mt-2 text-xs text-amber-600">
                  Legs marked EST used estimated fuel burns. Actual numbers may differ.
                </p>
              )}
            </div>
          )}
        </div>

        {/* Adjust overrides — collapsible */}
        <div className="rounded-lg border border-gray-200 bg-white overflow-hidden">
          <button onClick={() => setShowOverrides(!showOverrides)}
            className="w-full px-4 sm:px-5 py-3 flex items-center justify-between bg-gray-50 hover:bg-gray-100 transition-colors">
            <span className="text-sm font-medium text-gray-700">Adjust Weights & Fees</span>
            <svg className={`w-4 h-4 text-gray-400 transition-transform ${showOverrides ? "rotate-180" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </button>

          {showOverrides && (
            <div className="px-4 sm:px-5 py-4 border-t border-gray-200">
              <p className="text-xs text-gray-500 mb-3">Override values per leg, then hit Recalculate.</p>
              <div className="space-y-3">
                {plan.legs.map((leg, i) => (
                  <div key={i} className="border border-gray-100 rounded-lg px-3 py-2">
                    <div className="text-sm text-gray-700 font-semibold mb-2">{leg.from} &rarr; {leg.to}</div>
                    <div className="grid grid-cols-2 sm:flex sm:flex-wrap items-center gap-3">
                      <div className="flex items-center gap-1">
                        <label className="text-xs text-gray-500 w-10">MLW</label>
                        <input type="number" value={mlwOverrides[String(i)] ?? acDefaults.mlw}
                          onChange={(e) => setMlwOverrides({ ...mlwOverrides, [String(i)]: parseInt(e.target.value) || acDefaults.mlw })}
                          className="w-full sm:w-24 text-xs border border-gray-300 rounded px-2 py-1.5 text-right" />
                      </div>
                      <div className="flex items-center gap-1">
                        <label className="text-xs text-gray-500 w-10">ZFW</label>
                        <input type="number" value={zfwOverrides[String(i)] ?? acDefaults.zfw}
                          onChange={(e) => setZfwOverrides({ ...zfwOverrides, [String(i)]: parseInt(e.target.value) || acDefaults.zfw })}
                          className="w-full sm:w-24 text-xs border border-gray-300 rounded px-2 py-1.5 text-right" />
                      </div>
                      <div className="flex items-center gap-1">
                        <label className="text-xs text-gray-500 w-10">Fee $</label>
                        <input type="number" value={feeOverrides[String(i)] ?? (leg.waiver?.feeWaived ?? 0)}
                          onChange={(e) => setFeeOverrides({ ...feeOverrides, [String(i)]: parseInt(e.target.value) || 0 })}
                          className="w-full sm:w-20 text-xs border border-gray-300 rounded px-2 py-1.5 text-right" />
                      </div>
                      <div className="flex items-center gap-1">
                        <label className="text-xs text-gray-500 w-10">Waive</label>
                        <input type="number" value={waiverGalOverrides[String(i)] ?? (leg.waiver?.minGallons ?? 0)}
                          onChange={(e) => setWaiverGalOverrides({ ...waiverGalOverrides, [String(i)]: parseInt(e.target.value) || 0 })}
                          className="w-full sm:w-20 text-xs border border-gray-300 rounded px-2 py-1.5 text-right" />
                      </div>
                    </div>
                  </div>
                ))}
              </div>
              <button onClick={recalculate} disabled={recalculating}
                className="mt-4 w-full sm:w-auto px-5 py-2.5 bg-blue-600 text-white text-sm font-medium rounded-md hover:bg-blue-500 disabled:opacity-50 transition-colors">
                {recalculating ? "Recalculating..." : "Recalculate Plan"}
              </button>
            </div>
          )}
        </div>

        <p className="text-center text-xs text-gray-400">
          Baker Aviation Fuel Planning &mdash; expires {new Date(expiresAt).toLocaleString()}
        </p>
      </div>
    </div>
  );
}
