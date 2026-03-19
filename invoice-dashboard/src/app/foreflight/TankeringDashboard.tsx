"use client";

import { useState, useCallback } from "react";
import type { AircraftType, MultiLegPlan } from "@/app/tanker/model";

// ─── Types matching the API response ───────────────────────────────────

interface LegData {
  from: string;
  to: string;
  fuelToDestLbs: number;
  totalFuelLbs: number;
  flightTimeHours: number;
  departurePricePerGal: number;
  departureFboVendor: string | null;
  ffSource: "foreflight" | "estimate";
}

interface TailPlan {
  tail: string;
  aircraftType: AircraftType;
  shutdownFuel: number;
  shutdownAirport: string;
  legs: LegData[];
  plan: MultiLegPlan | null;
  error?: string;
}

interface GenerateResponse {
  ok: boolean;
  date: string;
  plans: TailPlan[];
  fleetTotals: { totalFuelCost: number; totalFees: number; totalTripCost: number; planCount: number };
  fuelPriceCount: number;
  shutdownDataDate: string | null;
  message?: string;
  error?: string;
}

interface UploadResponse {
  ok: boolean;
  inserted: number;
  skipped: number;
  totalParsed: number;
  dates: string[];
  tails: string[];
  shutdownByTail: Record<string, { fuel: number; airport: string }>;
  error?: string;
}

// ─── Helpers ───────────────────────────────────────────────────────────

function fmtNum(n: number, decimals = 0): string {
  return n.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

function fmtDollars(n: number): string {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 });
}

function fmtHrs(h: number): string {
  const hrs = Math.floor(h);
  const min = Math.round((h - hrs) * 60);
  return hrs > 0 ? `${hrs}h ${min}m` : `${min}m`;
}

// ─── Component ─────────────────────────────────────────────────────────

export default function TankeringDashboard() {
  const [uploading, setUploading] = useState(false);
  const [uploadResult, setUploadResult] = useState<UploadResponse | null>(null);
  const [generating, setGenerating] = useState(false);
  const [result, setResult] = useState<GenerateResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [targetDate, setTargetDate] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    return d.toISOString().split("T")[0];
  });

  // ── Upload handler ──
  const handleUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setUploadResult(null);
    setError(null);

    try {
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch("/api/fuel-planning/post-flight/upload", {
        method: "POST",
        body: formData,
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? `Upload failed: HTTP ${res.status}`);
        return;
      }
      setUploadResult(data);
    } catch (err) {
      setError(String(err));
    } finally {
      setUploading(false);
      e.target.value = "";
    }
  }, []);

  // ── Generate plan handler ──
  const handleGenerate = useCallback(async () => {
    setGenerating(true);
    setResult(null);
    setError(null);

    try {
      const res = await fetch("/api/fuel-planning/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date: targetDate }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? `Generate failed: HTTP ${res.status}`);
        return;
      }
      setResult(data);
    } catch (err) {
      setError(String(err));
    } finally {
      setGenerating(false);
    }
  }, [targetDate]);

  return (
    <div className="px-6 py-4 space-y-5 max-w-6xl mx-auto">
      {/* ── Controls ── */}
      <div className="rounded-lg border border-gray-200 bg-white p-5">
        <h2 className="text-lg font-semibold text-gray-900 mb-1">Automated Tankering Planner</h2>
        <p className="text-sm text-gray-500 mb-4">
          Upload tonight&apos;s post-flight data, then generate optimal fuel plans for tomorrow&apos;s schedule.
        </p>

        <div className="flex flex-wrap items-end gap-4">
          {/* Upload */}
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Post-Flight CSV</label>
            <label
              className={`inline-flex items-center gap-2 px-4 py-2.5 rounded-md text-sm font-medium cursor-pointer transition-colors ${
                uploading
                  ? "bg-gray-100 text-gray-400 cursor-wait"
                  : "bg-white border border-gray-300 text-gray-700 hover:bg-gray-50"
              }`}
            >
              {uploading ? "Uploading..." : "Upload CSV"}
              <input
                type="file"
                accept=".csv"
                onChange={handleUpload}
                disabled={uploading}
                className="hidden"
              />
            </label>
          </div>

          {/* Date picker */}
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Plan Date</label>
            <input
              type="date"
              value={targetDate}
              onChange={(e) => setTargetDate(e.target.value)}
              className="rounded-md border border-gray-300 px-3 py-2.5 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            />
          </div>

          {/* Generate */}
          <button
            onClick={handleGenerate}
            disabled={generating}
            className="px-5 py-2.5 bg-blue-600 text-white text-sm font-medium rounded-md hover:bg-blue-500 disabled:opacity-50 transition-colors"
          >
            {generating ? "Generating Plans..." : "Generate Fuel Plans"}
          </button>
        </div>

        {/* Upload result */}
        {uploadResult && (
          <div className="mt-3 rounded-md bg-green-50 border border-green-200 px-4 py-3">
            <p className="text-sm font-medium text-green-800">
              Uploaded {uploadResult.inserted} rows ({uploadResult.tails.length} tails) for {uploadResult.dates.join(", ")}
            </p>
            <div className="mt-2 flex flex-wrap gap-3">
              {Object.entries(uploadResult.shutdownByTail).map(([tail, info]) => (
                <span key={tail} className="inline-flex items-center gap-1.5 text-xs bg-green-100 text-green-700 px-2 py-1 rounded-full">
                  <span className="font-semibold">{tail}</span>
                  <span>{fmtNum(info.fuel)} lbs @ {info.airport}</span>
                </span>
              ))}
            </div>
          </div>
        )}

        {error && (
          <div className="mt-3 rounded-md bg-red-50 border border-red-200 px-4 py-3">
            <p className="text-sm text-red-700">{error}</p>
          </div>
        )}
      </div>

      {/* ── No-flight message ── */}
      {result?.message && !result.plans.length && (
        <div className="rounded-lg border border-gray-200 bg-white p-6 text-center text-gray-500">
          <p className="text-sm">{result.message}</p>
        </div>
      )}

      {/* ── Fleet Summary ── */}
      {result?.plans.length ? (
        <>
          <div className="rounded-lg border border-blue-200 bg-blue-50 p-4">
            <div className="flex items-center justify-between flex-wrap gap-3">
              <div>
                <span className="text-lg font-bold text-blue-900">
                  Fleet Fuel Plan — {result.date}
                </span>
                <span className="ml-3 text-sm text-blue-600">
                  {result.fleetTotals.planCount} aircraft
                </span>
              </div>
              <div className="flex items-center gap-6 text-sm">
                <span className="text-blue-700">
                  <span className="text-xs text-blue-500 uppercase mr-1">Total Fuel</span>
                  {fmtDollars(result.fleetTotals.totalFuelCost)}
                </span>
                {result.fleetTotals.totalFees > 0 && (
                  <span className="text-blue-700">
                    <span className="text-xs text-blue-500 uppercase mr-1">Fees</span>
                    {fmtDollars(result.fleetTotals.totalFees)}
                  </span>
                )}
                <span className="text-blue-900 font-semibold">
                  <span className="text-xs text-blue-500 uppercase mr-1">Total</span>
                  {fmtDollars(result.fleetTotals.totalTripCost)}
                </span>
              </div>
            </div>
            <div className="mt-2 text-xs text-blue-500">
              {result.fuelPriceCount} advertised fuel prices loaded
              {result.shutdownDataDate && <> &middot; Post-flight data from {result.shutdownDataDate}</>}
            </div>
          </div>

          {/* ── Per-Tail Plans ── */}
          {result.plans.map((tp) => (
            <TailPlanCard key={tp.tail} plan={tp} />
          ))}
        </>
      ) : null}
    </div>
  );
}

// ─── Tail Plan Card ────────────────────────────────────────────────────

function TailPlanCard({ plan: tp }: { plan: TailPlan }) {
  const ppg = 6.7; // standard for display conversion
  const hasError = !!tp.error;
  const plan = tp.plan;

  return (
    <div className={`rounded-lg border bg-white overflow-hidden ${hasError && !plan ? "border-amber-200" : "border-gray-200"}`}>
      {/* Header */}
      <div className={`px-5 py-3 flex items-center justify-between ${hasError && !plan ? "bg-amber-50" : "bg-gray-50"}`}>
        <div className="flex items-center gap-3">
          <span className="text-base font-bold text-gray-900">{tp.tail}</span>
          <span className="text-xs px-2 py-0.5 rounded-full bg-gray-200 text-gray-600">
            {tp.aircraftType === "CE-750" ? "Citation X" : "Challenger 300"}
          </span>
          <span className="text-xs text-gray-500">
            Shutdown: {fmtNum(tp.shutdownFuel)} lbs @ {tp.shutdownAirport}
          </span>
        </div>
        {plan && (
          <span className="text-sm font-semibold text-gray-900">
            {fmtDollars(plan.totalTripCost)}
          </span>
        )}
      </div>

      {/* Error state */}
      {hasError && !plan && (
        <div className="px-5 py-4 text-sm text-amber-700 bg-amber-50 border-t border-amber-200">
          {tp.error}
        </div>
      )}

      {/* Legs table */}
      {plan && tp.legs.length > 0 && (
        <div className="px-5 py-4">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-gray-500 border-b border-gray-100">
                  <th className="pb-2 pr-3">Leg</th>
                  <th className="pb-2 pr-3 text-right">Fuel Burn</th>
                  <th className="pb-2 pr-3 text-right">Flight Time</th>
                  <th className="pb-2 pr-3 text-right">Price/gal</th>
                  <th className="pb-2 pr-3">FBO</th>
                  <th className="pb-2 pr-3 text-right">Order (lbs)</th>
                  <th className="pb-2 pr-3 text-right">Order (gal)</th>
                  <th className="pb-2 pr-3 text-right">Landing Fuel</th>
                  <th className="pb-2 text-right">Cost</th>
                </tr>
              </thead>
              <tbody>
                {tp.legs.map((leg, i) => {
                  const orderLbs = plan.fuelOrderLbsByStop[i] ?? 0;
                  const orderGal = plan.fuelOrderGalByStop[i] ?? 0;
                  const landingFuel = plan.landingFuelByStop[i] ?? 0;
                  const legCost = orderGal * leg.departurePricePerGal + (plan.feePaidByStop[i] ?? 0);

                  return (
                    <tr key={i} className="border-b border-gray-50">
                      <td className="py-2.5 pr-3">
                        <span className="font-medium text-gray-900">{leg.from}</span>
                        <span className="text-gray-400 mx-1">&rarr;</span>
                        <span className="font-medium text-gray-900">{leg.to}</span>
                        {leg.ffSource === "estimate" && (
                          <span className="ml-1.5 text-[10px] px-1 py-0.5 rounded bg-amber-100 text-amber-600">EST</span>
                        )}
                      </td>
                      <td className="py-2.5 pr-3 text-right font-mono text-gray-700">
                        {fmtNum(leg.fuelToDestLbs)}
                      </td>
                      <td className="py-2.5 pr-3 text-right text-gray-600">
                        {fmtHrs(leg.flightTimeHours)}
                      </td>
                      <td className="py-2.5 pr-3 text-right font-mono">
                        {leg.departurePricePerGal > 0 ? fmtDollars(leg.departurePricePerGal) : (
                          <span className="text-gray-400">N/A</span>
                        )}
                      </td>
                      <td className="py-2.5 pr-3 text-gray-600 text-xs max-w-[120px] truncate">
                        {leg.departureFboVendor ?? "—"}
                      </td>
                      <td className={`py-2.5 pr-3 text-right font-mono font-semibold ${orderLbs > 0 ? "text-blue-700" : "text-gray-400"}`}>
                        {orderLbs > 0 ? fmtNum(orderLbs) : "—"}
                      </td>
                      <td className={`py-2.5 pr-3 text-right font-mono ${orderGal > 0 ? "text-blue-600" : "text-gray-400"}`}>
                        {orderGal > 0 ? fmtNum(orderGal) : "—"}
                      </td>
                      <td className="py-2.5 pr-3 text-right font-mono text-gray-700">
                        {fmtNum(landingFuel)}
                      </td>
                      <td className="py-2.5 text-right font-mono font-semibold text-gray-900">
                        {legCost > 0 ? fmtDollars(legCost) : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr className="border-t border-gray-200">
                  <td colSpan={5} className="py-2.5 text-xs text-gray-500 font-medium">TOTALS</td>
                  <td className="py-2.5 pr-3 text-right font-mono font-bold text-gray-900">
                    {fmtNum(plan.fuelOrderLbsByStop.reduce((a, b) => a + b, 0))}
                  </td>
                  <td className="py-2.5 pr-3 text-right font-mono font-bold text-gray-900">
                    {fmtNum(plan.fuelOrderGalByStop.reduce((a, b) => a + b, 0))}
                  </td>
                  <td className="py-2.5 pr-3"></td>
                  <td className="py-2.5 text-right font-mono font-bold text-gray-900">
                    {fmtDollars(plan.totalTripCost)}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>

          {/* Tankering summary */}
          {plan.tankerOutByStop.some((t) => t > 0) && (
            <div className="mt-3 pt-3 border-t border-gray-100">
              <p className="text-xs font-medium text-gray-500 mb-2">TANKERING RECOMMENDATIONS</p>
              <div className="flex flex-wrap gap-2">
                {plan.tankerOutByStop.map((tankerOut, i) => {
                  if (tankerOut <= 0) return null;
                  const leg = tp.legs[i];
                  const tankerIn = plan.tankerInByStop[i] ?? 0;
                  return (
                    <div key={i} className="text-xs bg-emerald-50 text-emerald-700 border border-emerald-200 rounded-md px-3 py-1.5">
                      <span className="font-semibold">{leg.from}</span>: carry +{fmtNum(tankerOut)} lbs
                      <span className="text-emerald-500 ml-1">({fmtNum(tankerIn)} lbs on arrival at {leg.to})</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Warning if any leg used estimate */}
          {tp.legs.some((l) => l.ffSource === "estimate") && (
            <p className="mt-2 text-xs text-amber-600">
              Legs marked EST used estimated fuel burns (ForeFlight unavailable). Actual numbers may differ.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
