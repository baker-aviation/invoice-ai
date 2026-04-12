"use client";

import React, { useState, useCallback, useEffect, useMemo } from "react";
import type { AircraftType, MultiLegPlan } from "@/app/tanker/model";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SharedPlanView } from "@/app/tanker/plan/[token]/page";

// ─── Types matching /api/fuel-planning/generate response ───────────────

interface TailPlan {
  tail: string;
  aircraftType: AircraftType;
  shutdownFuel: number;
  shutdownAirport: string;
  legs: Array<{
    from: string;
    to: string;
    departureFbo: string | null;
    departureFboVendor: string | null;
    departurePricePerGal: number;
  }>;
  plan: MultiLegPlan | null;
  naiveCost: number;
  tankerSavings: number;
  error?: string;
}

interface GenerateResponse {
  ok: boolean;
  date: string;
  plans: TailPlan[];
  fleetTotals: {
    totalFuelCost: number;
    totalFees: number;
    totalTripCost: number;
    naiveCost: number;
    tankerSavings: number;
    planCount: number;
  };
  fuelPriceCount: number;
  shutdownDataDate: string | null;
  message?: string;
  error?: string;
}

function fmtDollars(n: number): string {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

function acLabel(t: AircraftType | string): string {
  return t === "CE-750" ? "Citation X" : t === "CL-30" ? "Challenger 300" : String(t);
}

/**
 * Sort: CL-30 (Challenger) alphanumeric, then CE-750 (Citation X) alphanumeric.
 */
function sortPlans(a: TailPlan, b: TailPlan): number {
  const order: Record<string, number> = { "CL-30": 0, "CE-750": 1 };
  const oa = order[a.aircraftType] ?? 99;
  const ob = order[b.aircraftType] ?? 99;
  if (oa !== ob) return oa - ob;
  return a.tail.localeCompare(b.tail, "en", { numeric: true });
}

function tomorrowISO(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toISOString().split("T")[0];
}

export default function AircraftFuelPlans() {
  const [targetDate, setTargetDate] = useState(tomorrowISO);
  const [generating, setGenerating] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [sendingBriefings, setSendingBriefings] = useState(false);
  const [locking, setLocking] = useState(false);
  const [lockedCount, setLockedCount] = useState<number | null>(null);
  const [result, setResult] = useState<GenerateResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tokensByTail, setTokensByTail] = useState<Record<string, string>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [fleetTails, setFleetTails] = useState<Array<{ tail: string; aircraftType: string }>>([]);

  const sortedPlans = useMemo(() => {
    if (!result?.plans) return [];
    return [...result.plans].sort(sortPlans);
  }, [result]);

  // Load fleet tail list once on mount from ics_sources.
  useEffect(() => {
    fetch("/api/fuel-planning/fleet-tails")
      .then((r) => r.json())
      .then((data) => { if (data.tails) setFleetTails(data.tails); })
      .catch(() => {});
  }, []);

  const missingTails = useMemo(() => {
    if (!result?.plans || !fleetTails.length) return [];
    const planned = new Set(result.plans.map((p) => p.tail.toUpperCase()));
    return fleetTails
      .filter((t) => !planned.has(t.tail.toUpperCase()))
      .sort((a, b) => {
        const oa = a.aircraftType === "CL-30" ? 0 : 1;
        const ob = b.aircraftType === "CL-30" ? 0 : 1;
        if (oa !== ob) return oa - ob;
        return a.tail.localeCompare(b.tail, "en", { numeric: true });
      });
  }, [result, fleetTails]);

  // On mount / when targetDate changes, rehydrate tokens + plans from the
  // DB so a page refresh doesn't force a regenerate. If plans already exist
  // for the selected date, populate the list and token map.
  useEffect(() => {
    let cancelled = false;
    setTokensByTail({});
    fetch(`/api/fuel-planning/plan-links-by-date?date=${targetDate}`)
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return;
        if (data.tokens) setTokensByTail(data.tokens);
        const plans = Object.values(data.plans ?? {}) as TailPlan[];
        if (plans.length > 0) {
          setResult((prev) => prev ?? {
            ok: true,
            date: targetDate,
            plans,
            fleetTotals: {
              totalFuelCost: plans.reduce((s, p) => s + (p.plan?.totalFuelCost ?? 0), 0),
              totalFees: plans.reduce((s, p) => s + (p.plan?.totalFees ?? 0), 0),
              totalTripCost: plans.reduce((s, p) => s + (p.plan?.totalTripCost ?? 0), 0),
              naiveCost: plans.reduce((s, p) => s + (p.naiveCost ?? 0), 0),
              tankerSavings: plans.reduce((s, p) => s + (p.tankerSavings ?? 0), 0),
              planCount: plans.length,
            },
            fuelPriceCount: 0,
            shutdownDataDate: null,
          });
        }
      })
      .catch(() => { /* first-load, no existing plans is fine */ });
    return () => { cancelled = true; };
  }, [targetDate]);

  const handleGenerate = useCallback(async () => {
    setGenerating(true);
    setResult(null);
    setError(null);
    setTokensByTail({});
    try {
      const res = await fetch("/api/fuel-planning/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date: targetDate }),
      });
      const data: GenerateResponse = await res.json();
      if (!res.ok) {
        setError(data.error ?? `Generate failed: HTTP ${res.status}`);
        return;
      }
      setResult(data);

      // Create plan link tokens for every tail — even ones where the
      // optimizer couldn't find a valid tanker solution. The vendor plan
      // and FBO fees on the linked view are still useful.
      const tokens: Record<string, string> = {};
      await Promise.all(
        data.plans.map(async (p) => {
          try {
            const linkRes = await fetch("/api/fuel-planning/create-plan-link", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                tail: p.tail,
                aircraftType: p.aircraftType,
                date: data.date,
                plan: p,
              }),
            });
            const linkData = await linkRes.json();
            if (linkRes.ok && linkData.token) {
              tokens[p.tail] = linkData.token;
            }
          } catch {
            /* ignore individual failures */
          }
        }),
      );
      setTokensByTail(tokens);
    } catch (err) {
      setError(String(err));
    } finally {
      setGenerating(false);
    }
  }, [targetDate]);

  const handlePostDailySummary = useCallback(async () => {
    if (!result?.plans.length) return;
    if (!window.confirm("Post daily fuel briefing to Slack?")) return;
    setSharing(true);
    try {
      const res = await fetch("/api/fuel-planning/share-slack", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          channel: "C0ANTTQ6R96",
          date: result.date,
          plans: result.plans,
          fleetTotals: result.fleetTotals,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error ?? "Failed to post daily summary");
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setSharing(false);
    }
  }, [result]);

  const handleLockPlans = useCallback(async () => {
    if (!window.confirm(`Lock all fuel plans for ${targetDate}? Later JI schedule changes will be flagged.`)) return;
    setLocking(true);
    try {
      const res = await fetch("/api/fuel-planning/lock-plans", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date: targetDate }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Failed to lock plans");
      } else {
        setLockedCount(data.locked ?? 0);
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setLocking(false);
    }
  }, [targetDate]);

  const handleSendFuelBriefings = useCallback(async () => {
    if (!window.confirm("Send per-tail fuel briefings to Slack?")) return;
    setSendingBriefings(true);
    try {
      const res = await fetch("/api/fuel-planning/send-tankering-alerts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date: targetDate }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error ?? "Failed to send fuel briefings");
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setSendingBriefings(false);
    }
  }, [targetDate]);

  const toggleExpanded = (tail: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(tail)) next.delete(tail);
      else next.add(tail);
      return next;
    });
  };

  return (
    <div className="px-2 sm:px-4 py-3 space-y-3 sm:space-y-4 max-w-6xl mx-auto">
      {/* Controls */}
      <Card size="sm">
        <CardHeader className="pb-0">
          <CardTitle className="text-base sm:text-lg">Aircraft Fuel Plans</CardTitle>
          <CardDescription className="text-xs sm:text-sm">
            Per-tail fuel plans. Each card shows the tanker solution and FBO fee picture.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col sm:flex-row sm:flex-wrap sm:items-end gap-2 sm:gap-3">
            <div className="space-y-1">
              <Label htmlFor="plan-date" className="text-xs">Plan Date</Label>
              <Input
                id="plan-date"
                type="date"
                value={targetDate}
                onChange={(e) => setTargetDate(e.target.value)}
                className="w-full sm:w-auto h-9"
              />
            </div>
            <Button onClick={handleGenerate} disabled={generating} className="w-full sm:w-auto">
              {generating ? "Generating..." : "Generate Fuel Plans"}
            </Button>
            <div className="flex gap-2 overflow-x-auto">
              <Button variant="outline" size="sm" onClick={handlePostDailySummary} disabled={sharing || !result?.plans.length} className="whitespace-nowrap text-xs">
                {sharing ? "Posting..." : "Post Summary"}
              </Button>
              <Button variant="outline" size="sm" onClick={handleSendFuelBriefings} disabled={sendingBriefings} className="whitespace-nowrap text-xs">
                {sendingBriefings ? "Sending..." : "Send Briefings"}
              </Button>
              <Button variant="outline" size="sm" onClick={handleLockPlans} disabled={locking} className="whitespace-nowrap text-xs">
                {locking ? "Locking..." : "Lock Plans"}
              </Button>
            </div>
          </div>
          {lockedCount !== null && (
            <p className="mt-3 text-xs text-emerald-700">Locked {lockedCount} plan{lockedCount === 1 ? "" : "s"} for {targetDate}.</p>
          )}
          {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
        </CardContent>
      </Card>

      {/* Fleet summary */}
      {result?.fleetTotals && (
        <Card size="sm">
          <CardContent className="py-3">
            <div className="text-xs text-slate-500 mb-1">Fleet Fuel Plan</div>
            <div className="text-sm sm:text-base font-semibold text-slate-900 mb-2">{result.date} — {result.fleetTotals.planCount} aircraft</div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 sm:gap-4">
              <div>
                <div className="text-[10px] sm:text-xs text-slate-500">Total Fuel</div>
                <div className="text-xs sm:text-sm font-medium">{fmtDollars(result.fleetTotals.totalFuelCost)}</div>
              </div>
              <div>
                <div className="text-[10px] sm:text-xs text-slate-500">Fees</div>
                <div className="text-xs sm:text-sm font-medium">{fmtDollars(result.fleetTotals.totalFees)}</div>
              </div>
              <div>
                <div className="text-[10px] sm:text-xs text-slate-500">Total</div>
                <div className="text-xs sm:text-sm font-medium">{fmtDollars(result.fleetTotals.totalTripCost)}</div>
              </div>
              <div>
                <div className="text-[10px] sm:text-xs text-slate-500">Tanker Savings</div>
                <div className="text-xs sm:text-sm font-semibold text-emerald-600">{fmtDollars(result.fleetTotals.tankerSavings)}</div>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Per-tail cards */}
      <div className="space-y-2 sm:space-y-3">
        {sortedPlans.map((p) => {
          const isExpanded = expanded.has(p.tail);
          const savings = Math.round(p.tankerSavings);
          const legCount = p.legs?.length ?? 0;
          const token = tokensByTail[p.tail];
          const shutdown = p.shutdownAirport?.length === 4 && p.shutdownAirport.startsWith("K")
            ? p.shutdownAirport.slice(1)
            : p.shutdownAirport;

          return (
            <div key={p.tail} className="rounded-lg border border-slate-200 bg-white shadow-sm">
              <button
                onClick={() => toggleExpanded(p.tail)}
                className="w-full px-3 sm:px-4 py-2.5 sm:py-3 hover:bg-slate-50 transition-colors text-left"
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 sm:gap-3 min-w-0">
                    <svg
                      className={`w-3.5 h-3.5 sm:w-4 sm:h-4 text-slate-400 transition-transform shrink-0 ${isExpanded ? "rotate-90" : ""}`}
                      fill="none" viewBox="0 0 24 24" stroke="currentColor"
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                    </svg>
                    <span className="text-sm sm:text-base font-semibold text-slate-900">{p.tail}</span>
                    <span className="hidden sm:inline text-xs px-2 py-0.5 rounded-full bg-slate-100 text-slate-600">{acLabel(p.aircraftType)}</span>
                    <span className="text-[10px] sm:text-xs text-slate-500">{legCount} leg{legCount === 1 ? "" : "s"}</span>
                  </div>
                  <div className="flex items-center gap-2 sm:gap-4 shrink-0 ml-2">
                    {savings > 0 && (
                      <span className="text-xs sm:text-sm font-semibold text-emerald-600">
                        Save {fmtDollars(savings)}
                      </span>
                    )}
                    {p.plan && (
                      <span className="text-xs sm:text-sm font-medium text-slate-900">{fmtDollars(p.plan.totalTripCost)}</span>
                    )}
                  </div>
                </div>
                {/* Second line on mobile: aircraft type, shutdown, error */}
                <div className="flex items-center gap-2 mt-0.5 sm:mt-0 ml-6 sm:ml-7">
                  <span className="sm:hidden text-[10px] px-1.5 py-0.5 rounded-full bg-slate-100 text-slate-500">{acLabel(p.aircraftType)}</span>
                  <span className="text-[10px] text-slate-400">@ {shutdown}</span>
                  {p.error && <span className="text-[10px] text-red-500 truncate">{p.error}</span>}
                </div>
              </button>
              {isExpanded && token && (
                <div className="border-t border-slate-200 px-2 sm:px-4 py-3 sm:py-4 bg-slate-50/50">
                  <SharedPlanView token={token} mode="admin" />
                </div>
              )}
              {isExpanded && !token && (
                <div className="border-t border-slate-200 px-3 sm:px-4 py-3 sm:py-4 text-sm text-slate-500">
                  Plan link not available — regenerate plans to view details.
                </div>
              )}
            </div>
          );
        })}
      </div>

      {result && !sortedPlans.length && (
        <p className="text-sm text-slate-500 text-center py-6">No plans for {result.date}.</p>
      )}

      {/* Tails with no flights scheduled */}
      {missingTails.length > 0 && result && (
        <div className="mt-6">
          <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">No Flights Scheduled</h3>
          <div className="space-y-1">
            {missingTails.map((t) => (
              <div key={t.tail} className="rounded-lg border border-slate-100 bg-slate-50/50 px-4 py-2 flex items-center gap-3">
                <span className="text-sm font-medium text-slate-400">{t.tail}</span>
                <span className="text-xs px-2 py-0.5 rounded-full bg-slate-100 text-slate-400">
                  {t.aircraftType === "CE-750" ? "Citation X" : t.aircraftType === "CL-30" ? "Challenger 300" : t.aircraftType}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
