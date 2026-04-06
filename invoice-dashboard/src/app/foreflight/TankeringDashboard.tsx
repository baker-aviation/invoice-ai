"use client";

import React, { useState, useCallback } from "react";
import type { AircraftType, MultiLegPlan } from "@/app/tanker/model";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

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
  departureDate?: string;
  fuelToDestLbs: number;
  totalFuelLbs: number;
  flightTimeHours: number;
  departurePricePerGal: number;
  departureFboVendor: string | null;
  departureFbo: string | null;
  priceSource?: "trip_notes" | "contract" | "retail" | "airport_fallback" | "none";
  bestPriceAtFbo?: number | null;
  bestVendorAtFbo?: string | null;
  allVendors?: Array<{ vendor: string; price: number; tier: string }>;
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
  nationalAvgPrice?: number;
  fuelPriceCount: number;
  shutdownDataDate: string | null;
  message?: string;
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

  // ── Share to Slack handler (consolidated fleet summary) ──
  const handleShareSlack = useCallback(async () => {
    if (!result?.plans.length) return;
    if (!window.confirm("Post daily fuel briefing to #fuel-planning? Each tail will have a clickable plan link.")) return;
    setSharing(true);
    setShareResult(null);
    setError(null);

    try {
      const res = await fetch("/api/fuel-planning/share-slack", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          channel: FUEL_PLANNING_SLACK_CHANNEL,
          date: result.date,
          plans: result.plans,
          fleetTotals: result.fleetTotals,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Failed to share to Slack");
        return;
      }
      setShareResult(`Fuel briefing sent to Slack (${data.sent} plans sent)`);
    } catch (err) {
      setError(String(err));
    } finally {
      setSharing(false);
    }
  }, [result]);

  return (
    <div className="px-6 py-3 space-y-4 max-w-6xl mx-auto">
      {/* ── Controls ── */}
      <Card size="sm">
        <CardHeader className="pb-0">
          <CardTitle>Automated Tankering Planner</CardTitle>
          <CardDescription>
            Generate optimal fuel plans using JetInsight post-flight data and tomorrow&apos;s schedule.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1">
              <Label htmlFor="plan-date" className="text-xs">Plan Date</Label>
              <Input
                id="plan-date"
                type="date"
                value={targetDate}
                onChange={(e) => setTargetDate(e.target.value)}
                className="w-auto h-9"
              />
            </div>

            <Button onClick={handleGenerate} disabled={generating} size="lg" className="h-9">
              {generating ? "Generating Plans..." : "Generate Fuel Plans"}
            </Button>

            {result?.plans.length ? (
              <Button onClick={handleShareSlack} disabled={sharing} variant="secondary" size="lg" className="h-9">
                {sharing ? "Sending..." : "Post Daily Summary"}
              </Button>
            ) : null}

            {result?.plans.length ? (
              <SendAlertsButton date={result.date} />
            ) : null}
          </div>

          {shareResult && (
            <div className="mt-3 rounded-md bg-purple-50 border border-purple-200 px-4 py-3">
              <p className="text-sm font-medium text-purple-800">{shareResult}</p>
            </div>
          )}

          {error && (
            <div className="mt-3 rounded-md bg-red-50 border border-red-200 px-4 py-3">
              <p className="text-sm text-red-700">{error}</p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── No-flight message ── */}
      {result?.message && !result.plans.length && (
        <Card>
          <CardContent className="text-center text-muted-foreground py-2">
            <p className="text-sm">{result.message}</p>
          </CardContent>
        </Card>
      )}

      {/* ── Fleet Summary ── */}
      {result?.plans.length ? (
        <>
          <Card className="bg-blue-50 ring-blue-200">
            <CardContent>
              <div className="flex items-center justify-between flex-wrap gap-3">
                <div className="flex items-center gap-3">
                  <span className="text-lg font-bold text-blue-900">
                    Fleet Fuel Plan — {result.date}
                  </span>
                  <Badge variant="secondary" className="bg-blue-100 text-blue-700">
                    {result.fleetTotals.planCount} aircraft
                  </Badge>
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
                    <Badge className="bg-green-100 text-green-700 border-green-200">
                      Savings {fmtDollars(result.fleetTotals.tankerSavings)}
                    </Badge>
                  )}
                </div>
              </div>
              <div className="mt-2 text-xs text-blue-500">
                {result.fuelPriceCount} advertised fuel prices loaded
                {result.shutdownDataDate && <> &middot; Post-flight data from {result.shutdownDataDate}</>}
              </div>
            </CardContent>
          </Card>

          {/* ── Per-Tail Plans — savings first (expanded), no savings (collapsed) ── */}
          {(() => {
            const withSavings = result.plans
              .filter((tp) => tp.tankerSavings > 0 && !tp.error && tp.legs.length > 1)
              .sort((a, b) => b.tankerSavings - a.tankerSavings);
            const noSavings = result.plans
              .filter((tp) => tp.tankerSavings <= 0 || tp.error || tp.legs.length <= 1);
            return (
              <>
                {withSavings.map((tp) => (
                  <TailPlanCard key={tp.tail} plan={tp} date={result.date} defaultOpen nationalAvgPrice={result.nationalAvgPrice} />
                ))}
                {noSavings.length > 0 && (
                  <div className="mt-2">
                    <p className="text-xs text-gray-400 uppercase font-medium tracking-wide mb-2">
                      Vendor plan only — no tankering savings ({noSavings.length} aircraft)
                    </p>
                    {noSavings.map((tp) => (
                      <TailPlanCard key={tp.tail} plan={tp} date={result.date} defaultOpen={false} nationalAvgPrice={result.nationalAvgPrice} />
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

function TailPlanCard({ plan: tp, date, defaultOpen = true, nationalAvgPrice = 0 }: { plan: TailPlan; date: string; defaultOpen?: boolean; nationalAvgPrice?: number }) {
  const ppg = 6.7; // standard for display conversion
  const hasError = !!tp.error;
  const plan = tp.plan;
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [linkSent, setLinkSent] = useState<string | null>(null);
  const [open, setOpen] = useState(defaultOpen);
  const [showVendorPlan, setShowVendorPlan] = useState(false);
  const hasVendorData = tp.legs.some((l) => (l.allVendors?.length ?? 0) > 0 || l.departureFboVendor);
  const isSingleLeg = tp.legs.length === 1;
  const singleLegPrice = isSingleLeg ? tp.legs[0]?.departurePricePerGal ?? 0 : 0;
  const isBelowAvg = isSingleLeg && nationalAvgPrice > 0 && singleLegPrice > 0 && singleLegPrice < nationalAvgPrice;

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
          <Badge variant="secondary">
            {tp.aircraftType === "CE-750" ? "Citation X" : "Challenger 300"}
          </Badge>
          <span className="text-xs text-gray-500">
            Shutdown: {fmtNum(tp.shutdownFuel)} lbs @ {tp.shutdownAirport}
          </span>
        </div>
        <div className="flex items-center gap-4">
          {tp.tankerSavings > 0 && !isSingleLeg && (
            <Badge className="bg-green-100 text-green-700 border-green-200">
              Save {fmtDollars(tp.tankerSavings)}
            </Badge>
          )}
          {isBelowAvg && (
            <Badge variant="outline" className="text-blue-600 border-blue-200 bg-blue-50 text-[10px]">
              Below avg — likely tanker opportunity when follow-on leg is known
            </Badge>
          )}
          {plan && (
            <span className="text-sm font-semibold text-foreground">
              {fmtDollars(plan.totalTripCost)}
            </span>
          )}
          {plan && (
            <Button
              onClick={(e) => { e.stopPropagation(); handleSendToSlack(); }}
              disabled={sending || sent}
              variant={sent ? "ghost" : "outline"}
              size="sm"
              title={linkSent ?? "Send plan to Slack with shareable link"}
              className={sent ? "text-green-700 bg-green-50" : ""}
            >
              {sent ? "Sent" : sending ? "Sending..." : "Send to Slack"}
            </Button>
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

      {/* Fuel Vendor Plan toggle */}
      {hasVendorData && (
        <div className="border-t border-gray-100">
          <button
            onClick={() => setShowVendorPlan(!showVendorPlan)}
            className="w-full px-5 py-2.5 flex items-center gap-2 text-left hover:bg-blue-50 transition-colors"
          >
            <svg className={`w-3.5 h-3.5 text-blue-500 transition-transform ${showVendorPlan ? "rotate-90" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
            <span className="text-xs font-semibold text-blue-700 uppercase tracking-wide">Fuel Vendor Plan</span>
          </button>
          {showVendorPlan && (
            <div className="px-5 pb-3 space-y-1.5">
              {tp.legs.map((leg, i) => {
                const vendors = leg.allVendors ?? [];
                const chosen = leg.departureFboVendor;
                const chosenPrice = leg.departurePricePerGal;
                const best = vendors[0];
                const isOverpaying = best && chosenPrice > 0 && chosenPrice > best.price + 0.005;
                const sourceLabel = leg.priceSource === "trip_notes" ? "Rep pick" : leg.priceSource === "contract" ? "Contract" : leg.priceSource === "retail" ? "Retail" : "";

                return (
                  <div key={i} className="flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-3 py-1.5 border-b border-gray-50 last:border-0">
                    <div className="flex items-center gap-2 min-w-[100px]">
                      <span className="font-semibold text-gray-900 text-sm">{leg.from}</span>
                      <span className="text-gray-400 text-xs">&rarr;</span>
                      <span className="text-gray-500 text-sm">{leg.to}</span>
                    </div>
                    <div className="flex-1 flex items-center gap-2 flex-wrap">
                      {chosen && chosenPrice > 0 ? (
                        <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                          isOverpaying ? "bg-amber-100 text-amber-700" : "bg-green-100 text-green-700"
                        }`}>
                          {chosen} @ ${chosenPrice.toFixed(4)}/gal
                          {sourceLabel && <span className="ml-1 opacity-60">({sourceLabel})</span>}
                        </span>
                      ) : (
                        <span className="text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-500">No vendor selected</span>
                      )}
                      {isOverpaying && best && (
                        <span className="text-xs text-amber-600 font-medium">
                          Better: {best.vendor} @ ${best.price.toFixed(4)} (save ${(chosenPrice - best.price).toFixed(4)}/gal)
                        </span>
                      )}
                    </div>
                    {vendors.length > 1 && (
                      <div className="flex gap-1 flex-wrap">
                        {vendors.slice(0, 4).map((v, vi) => (
                          <span key={vi} className={`text-[10px] px-1.5 py-0.5 rounded border ${
                            vi === 0 ? "border-green-200 bg-green-50 text-green-700 font-medium" : "border-gray-100 text-gray-500"
                          }`}>
                            {v.vendor} ${v.price.toFixed(4)} <span className="opacity-50">{v.tier}</span>
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
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
                  <th className="pb-2 pr-3 text-right">Fuel to Dest</th>
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
                  const prevDate = i > 0 ? tp.legs[i - 1].departureDate : null;
                  const showDayHeader = leg.departureDate && leg.departureDate !== prevDate;

                  return (<React.Fragment key={`leg-${i}`}>
                    {showDayHeader && (
                      <tr className="bg-gray-50">
                        <td colSpan={10} className="py-1.5 px-1 text-xs font-semibold text-gray-500 uppercase tracking-wide">
                          {new Date(leg.departureDate + "T12:00:00").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })}
                        </td>
                      </tr>
                    )}
                    <tr className="border-b border-gray-50">
                      <td className="py-2.5 pr-3">
                        <span className="font-medium text-gray-900">{leg.from}</span>
                        <span className="text-gray-400 mx-1">&rarr;</span>
                        <span className="font-medium text-gray-900">{leg.to}</span>
                        {leg.ffSource === "estimate" && (
                          <Badge variant="outline" className="ml-1.5 text-[10px] bg-amber-50 text-amber-600 border-amber-200">EST</Badge>
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
                        {leg.priceSource === "retail" && (
                          <div className="text-[10px] text-amber-500 font-medium">Retail price (no contract)</div>
                        )}
                        {leg.priceSource === "none" && (
                          <div className="text-[10px] text-amber-500 font-medium">No pricing data</div>
                        )}
                        {leg.bestPriceAtFbo != null && leg.bestVendorAtFbo && (
                          <div className="text-[10px] text-red-500 font-medium">
                            Better: {leg.bestVendorAtFbo} @ {fmtDollars(leg.bestPriceAtFbo)}/gal
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
                  </React.Fragment>);
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
                  return (
                    <div key={i} className="text-xs rounded-md px-3 py-1.5 border bg-gray-50 text-gray-700 border-gray-200">
                      <span className="font-semibold">{leg.from}</span>: carry +{fmtNum(tankerOut)} lbs
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
    if (!window.confirm("This will send fuel briefings to Slack for all aircraft. Continue?")) return;
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
      setResult({ sent: data.sent, savingsPlans: data.briefingsSent ?? data.savingsPlans });
    } catch (err) {
      setError(String(err));
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="flex items-center gap-3">
      <Button
        onClick={handleSend}
        disabled={sending}
        size="lg"
        className="bg-green-600 hover:bg-green-500 text-white"
      >
        {sending ? "Sending..." : "Send Fuel Briefings"}
      </Button>
      {result && (
        <span className="text-sm text-green-700 font-medium">
          {result.savingsPlans} briefings, {result.sent} sent to Slack
        </span>
      )}
      {error && <span className="text-sm text-red-600">{error}</span>}
    </div>
  );
}
