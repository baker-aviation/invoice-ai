"use client";

import { useState, useCallback } from "react";
import type { AircraftType, MultiLegPlan } from "@/app/tanker/model";

// ─── Types matching the API response ───────────────────────────────────

interface LegWaiver {
  fboName: string;
  minGallons: number;
  feeWaived: number;
  landingFee: number;
  securityFee: number;
  overnightFee: number;
}

interface LegData {
  from: string;
  to: string;
  fuelToDestLbs: number;
  totalFuelLbs: number;
  flightTimeHours: number;
  departurePricePerGal: number;
  departureFboVendor: string | null;
  departureFbo: string | null;
  ffSource: "foreflight" | "estimate";
  waiver?: LegWaiver;
}

interface TailPlan {
  tail: string;
  aircraftType: AircraftType;
  shutdownFuel: number;
  shutdownAirport: string;
  legs: LegData[];
  plan: MultiLegPlan | null;
  naiveCost: number;
  tankerSavings: number;
  error?: string;
}

interface GenerateResponse {
  ok: boolean;
  date: string;
  plans: TailPlan[];
  fleetTotals: { totalFuelCost: number; totalFees: number; totalTripCost: number; naiveCost: number; tankerSavings: number; planCount: number };
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

const FUEL_PLANNING_SLACK_CHANNEL = "C0ANTTQ6R96";

export default function TankeringDashboard() {
  const [uploading, setUploading] = useState(false);
  const [uploadResult, setUploadResult] = useState<UploadResponse | null>(null);
  const [generating, setGenerating] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [shareResult, setShareResult] = useState<string | null>(null);
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
      const text = await res.text();
      let data: GenerateResponse;
      try {
        data = JSON.parse(text);
      } catch {
        setError(`Server returned non-JSON response (HTTP ${res.status}): ${text.slice(0, 200)}`);
        return;
      }
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

  // ── Share to Slack handler (creates links for each plan) ──
  const handleShareSlack = useCallback(async () => {
    if (!result?.plans.length) return;
    setSharing(true);
    setShareResult(null);
    setError(null);

    try {
      let sentCount = 0;
      for (const plan of result.plans) {
        if (plan.error && !plan.plan) continue;
        const res = await fetch("/api/fuel-planning/create-plan-link", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            tail: plan.tail,
            aircraftType: plan.aircraftType,
            date: result.date,
            plan: plan,
            send_slack: true,
          }),
        });
        if (res.ok) sentCount++;
      }
      setShareResult(`Sent ${sentCount} plans to Slack (with links)`);
    } catch (err) {
      setError(String(err));
    } finally {
      setSharing(false);
    }
  }, [result]);

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

          {/* Share to Slack */}
          {result?.plans.length ? (
            <button
              onClick={handleShareSlack}
              disabled={sharing}
              className="px-5 py-2.5 bg-purple-600 text-white text-sm font-medium rounded-md hover:bg-purple-500 disabled:opacity-50 transition-colors"
            >
              {sharing ? "Sending..." : "Share to Slack"}
            </button>
          ) : null}

          {/* Send Tankering Alerts (with links) */}
          {result?.plans.length ? (
            <SendAlertsButton date={result.date} />
          ) : null}
        </div>

        {shareResult && (
          <div className="mt-3 rounded-md bg-purple-50 border border-purple-200 px-4 py-3">
            <p className="text-sm font-medium text-purple-800">{shareResult}</p>
          </div>
        )}

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
                {result.fleetTotals.tankerSavings > 0 && (
                  <span className="text-green-700 font-semibold">
                    <span className="text-xs text-green-500 uppercase mr-1">Savings</span>
                    {fmtDollars(result.fleetTotals.tankerSavings)}
                  </span>
                )}
              </div>
            </div>
            <div className="mt-2 text-xs text-blue-500">
              {result.fuelPriceCount} advertised fuel prices loaded
              {result.shutdownDataDate && <> &middot; Post-flight data from {result.shutdownDataDate}</>}
            </div>
          </div>

          {/* ── Per-Tail Plans — savings first (expanded), no savings (collapsed) ── */}
          {(() => {
            const withSavings = result.plans
              .filter((tp) => tp.tankerSavings > 0 && !tp.error)
              .sort((a, b) => b.tankerSavings - a.tankerSavings);
            const noSavings = result.plans
              .filter((tp) => tp.tankerSavings <= 0 || tp.error);
            return (
              <>
                {withSavings.map((tp) => (
                  <TailPlanCard key={tp.tail} plan={tp} date={result.date} defaultOpen />
                ))}
                {noSavings.length > 0 && (
                  <div className="mt-2">
                    <p className="text-xs text-gray-400 uppercase font-medium tracking-wide mb-2">
                      No tankering opportunity ({noSavings.length} aircraft)
                    </p>
                    {noSavings.map((tp) => (
                      <TailPlanCard key={tp.tail} plan={tp} date={result.date} defaultOpen={false} />
                    ))}
                  </div>
                )}
              </>
            );
          })()}
        </>
      ) : null}
    </div>
  );
}

// ─── Tail Plan Card ────────────────────────────────────────────────────

function TailPlanCard({ plan: tp, date, defaultOpen = true }: { plan: TailPlan; date: string; defaultOpen?: boolean }) {
  const ppg = 6.7; // standard for display conversion
  const hasError = !!tp.error;
  const plan = tp.plan;
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [linkSent, setLinkSent] = useState<string | null>(null);
  const [open, setOpen] = useState(defaultOpen);

  const handleSendToSlack = async () => {
    if (!plan) return;
    setSending(true);
    try {
      // Create a shareable link first, then send Slack with the link included
      const res = await fetch("/api/fuel-planning/create-plan-link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tail: tp.tail,
          aircraftType: tp.aircraftType,
          date,
          plan: tp,
          send_slack: true,
        }),
      });
      const data = await res.json();
      if (data.url) {
        setLinkSent(data.url);
        setSent(true);
      }
    } catch { /* ignore */ }
    finally { setSending(false); }
  };

  return (
    <div className={`rounded-lg border bg-white overflow-hidden ${hasError && !plan ? "border-amber-200" : "border-gray-200"}`}>
      {/* Header — click to expand/collapse */}
      <div
        className={`px-5 py-3 flex items-center justify-between cursor-pointer ${hasError && !plan ? "bg-amber-50" : "bg-gray-50"}`}
        onClick={() => setOpen(!open)}
      >
        <div className="flex items-center gap-3">
          <svg className={`w-4 h-4 text-gray-400 transition-transform ${open ? "rotate-90" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
          <span className="text-base font-bold text-gray-900">{tp.tail}</span>
          <span className="text-xs px-2 py-0.5 rounded-full bg-gray-200 text-gray-600">
            {tp.aircraftType === "CE-750" ? "Citation X" : "Challenger 300"}
          </span>
          <span className="text-xs text-gray-500">
            Shutdown: {fmtNum(tp.shutdownFuel)} lbs @ {tp.shutdownAirport}
          </span>
        </div>
        <div className="flex items-center gap-4">
          {tp.tankerSavings > 0 && (
            <span className="text-sm font-semibold text-green-600">
              Save {fmtDollars(tp.tankerSavings)}
            </span>
          )}
          {plan && (
            <span className="text-sm font-semibold text-gray-900">
              {fmtDollars(plan.totalTripCost)}
            </span>
          )}
          {plan && (
            <button
              onClick={(e) => { e.stopPropagation(); handleSendToSlack(); }}
              disabled={sending || sent}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                sent
                  ? "bg-green-100 text-green-700 cursor-default"
                  : "bg-gray-100 text-gray-600 hover:bg-purple-100 hover:text-purple-700 disabled:opacity-50"
              }`}
              title={linkSent ?? "Send plan to Slack with shareable link"}
            >
              {sent ? "Sent" : sending ? "Sending..." : "Send to Slack"}
            </button>
          )}
        </div>
      </div>

      {/* Collapsible body */}
      {!open ? null : (<>

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
                  <th className="pb-2 pr-3 text-right">Handling Fee</th>
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
                      <td className="py-2.5 pr-3 text-xs max-w-[180px]">
                        <div className="text-gray-700 truncate font-medium">
                          {leg.departureFbo || "—"}
                        </div>
                        {leg.waiver && leg.waiver.minGallons > 0 && (
                          <div className="text-[10px] text-gray-400">
                            Waive at {fmtNum(leg.waiver.minGallons)} gal
                          </div>
                        )}
                        {leg.departureFboVendor && leg.departureFboVendor !== leg.departureFbo && (
                          <div className="text-[10px] text-blue-400 truncate">
                            Fuel: {leg.departureFboVendor}
                          </div>
                        )}
                      </td>
                      <td className="py-2.5 pr-3 text-right text-xs">
                        {leg.waiver && leg.waiver.feeWaived > 0 ? (
                          <div>
                            <span className={`font-mono font-semibold ${(plan.feePaidByStop[i] ?? 0) > 0 ? "text-red-600" : "text-green-600"}`}>
                              {fmtDollars(leg.waiver.feeWaived)}
                            </span>
                            <div className={`text-[10px] ${(plan.feePaidByStop[i] ?? 0) > 0 ? "text-red-400" : "text-green-500"}`}>
                              {(plan.feePaidByStop[i] ?? 0) > 0 ? "not waived" : "waived"}
                            </div>
                          </div>
                        ) : (
                          <span className="text-gray-400">—</span>
                        )}
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
                      <td className="py-2.5 text-right">
                        {legCost > 0 ? (
                          <div>
                            <span className="font-mono font-semibold text-gray-900">{fmtDollars(legCost)}</span>
                            {(plan.feePaidByStop[i] ?? 0) > 0 && (
                              <div className="text-[10px] text-red-500">+{fmtDollars(plan.feePaidByStop[i])} fee</div>
                            )}
                          </div>
                        ) : (
                          <span className="font-mono text-gray-400">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr className="border-t border-gray-200">
                  <td colSpan={6} className="py-2.5 text-xs text-gray-500 font-medium">TOTALS</td>
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
                  const nextLeg = tp.legs[i + 1];
                  const tankerIn = plan.tankerInByStop[i] ?? 0;
                  // Determine reason: price play vs fee waiver
                  const nextPrice = nextLeg?.departurePricePerGal ?? 0;
                  const isFeeWaiver = leg.departurePricePerGal >= nextPrice && nextPrice > 0;
                  return (
                    <div key={i} className={`text-xs rounded-md px-3 py-1.5 border ${
                      isFeeWaiver
                        ? "bg-blue-50 text-blue-700 border-blue-200"
                        : "bg-emerald-50 text-emerald-700 border-emerald-200"
                    }`}>
                      <span className="font-semibold">{leg.from}</span>: carry +{fmtNum(tankerOut)} lbs
                      <span className={`ml-1 ${isFeeWaiver ? "text-blue-500" : "text-emerald-500"}`}>
                        ({fmtNum(tankerIn)} lbs on arrival at {leg.to})
                      </span>
                      {isFeeWaiver && (
                        <span className="ml-1.5 text-[10px] px-1.5 py-0.5 rounded bg-blue-100 text-blue-600">FEE WAIVER</span>
                      )}
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

      </>)}
    </div>
  );
}

// ─── Send All Tankering Alerts Button ─────────────────────────────────

function SendAlertsButton({ date }: { date: string }) {
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<{ sent: number; savingsPlans: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleSend = async () => {
    setSending(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch("/api/fuel-planning/send-tankering-alerts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Failed");
        return;
      }
      setResult({ sent: data.sent, savingsPlans: data.savingsPlans });
    } catch (err) {
      setError(String(err));
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="flex items-center gap-3">
      <button
        onClick={handleSend}
        disabled={sending}
        className="px-5 py-2.5 bg-green-600 text-white text-sm font-medium rounded-md hover:bg-green-500 disabled:opacity-50 transition-colors"
      >
        {sending ? "Sending Alerts..." : "Send Tankering Alerts"}
      </button>
      {result && (
        <span className="text-sm text-green-700 font-medium">
          {result.savingsPlans} aircraft with savings, {result.sent} alerts sent
        </span>
      )}
      {error && <span className="text-sm text-red-600">{error}</span>}
    </div>
  );
}
