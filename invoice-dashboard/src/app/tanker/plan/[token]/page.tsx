"use client";

import React, { useState, useEffect, useCallback, useMemo } from "react";
import { STD_AIRCRAFT, type AircraftType } from "@/app/tanker/model";
import FboFeesBlock, { type LegFeeQuery } from "@/app/fuel-planning/FboFeesBlock";
import FboFeesEditModal from "@/app/fuel-planning/FboFeesEditModal";

/**
 * Reusable fuel plan view. Used by:
 *  - the tokenized crew share link at /tanker/plan/[token] (mode="crew")
 *  - the admin Aircraft Fuel Plans tab (mode="admin") — embeds multiple cards
 */
export type FuelPlanViewMode = "crew" | "admin";

type VendorOption = {
  vendor: string;
  price: number;
  tier: string;
};

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
  priceSource?: "trip_notes" | "contract" | "retail" | "airport_fallback" | "none";
  bestPriceAtFbo?: number | null;
  bestVendorAtFbo?: string | null;
  allVendors?: VendorOption[];
  ffSource: string;
  ffZfw: number | null;
  ffMlw: number | null;
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
  nationalAvgPrice?: number;
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

export function SharedPlanView({ token, mode = "crew" }: { token: string | null; mode?: FuelPlanViewMode }) {
  const [plan, setPlan] = useState<PlanData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [date, setDate] = useState<string>("");
  const [expiresAt, setExpiresAt] = useState<string>("");
  const [recalculating, setRecalculating] = useState(false);
  const [showOverrides, setShowOverrides] = useState(false);
  const [slackSending, setSlackSending] = useState(false);
  const [slackSent, setSlackSent] = useState(false);

  // Fuel release state
  const [isAuthed, setIsAuthed] = useState(false);
  const [releaseStatus, setReleaseStatus] = useState<Record<number, { status: "idle" | "loading" | "submitted" | "error"; id?: string; message?: string }>>({});
  const [releaseDetails, setReleaseDetails] = useState<Record<number, {
    status: string;
    vendor_name?: string | null;
    vendor_confirmation?: string | null;
    latest_reply?: { at?: string; note?: string; by?: string } | null;
    timeline?: Array<{ at?: string; status?: string; by?: string; note?: string }>;
    attachments?: Array<{ name: string; content_type: string; size: number | null; uploaded_at: string | null; url: string | null }>;
  }>>({});
  const [requestingAll, setRequestingAll] = useState(false);

  // Public release status (read-only, by airport code)
  type PublicRelease = {
    id: string;
    airport_code: string;
    vendor_name: string;
    vendor_id: string;
    status: string;
    vendor_confirmation: string | null;
  };
  type PublicVendorMeta = { release_type: string; notes: string | null };
  const [publicReleases, setPublicReleases] = useState<PublicRelease[]>([]);
  const [vendorMeta, setVendorMeta] = useState<Record<string, PublicVendorMeta>>({});

  const [mlwOverrides, setMlwOverrides] = useState<Record<string, number>>({});
  const [zfwOverrides, setZfwOverrides] = useState<Record<string, number>>({});
  const [feeOverrides, setFeeOverrides] = useState<Record<string, number>>({});
  const [waiverGalOverrides, setWaiverGalOverrides] = useState<Record<string, number>>({});
  const [fuelBurnOverrides, setFuelBurnOverrides] = useState<Record<string, number>>({});
  const [priceHistory, setPriceHistory] = useState<Record<string, {
    avgPrice: number;
    minPrice: number;
    maxPrice: number;
    recentPrices: Array<{ price: number; vendor: string; date: string; gallons: number; tail: string }>;
  }> | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [feeEditTarget, setFeeEditTarget] = useState<LegFeeQuery | null>(null);

  const loadPlan = useCallback(async () => {
    if (!token) return;
    try {
      const res = await fetch(`/api/fuel-planning/shared-plan/${token}`);
      const data = await res.json();
      if (!res.ok) { setError(data.error ?? "Failed to load plan"); return; }
      setPlan(data.plan);
      setDate(data.date);
      setExpiresAt(data.expires_at);
      // Restore persisted overrides (survive page refresh)
      if (data.overrides) {
        if (data.overrides.mlw) setMlwOverrides(data.overrides.mlw);
        if (data.overrides.zfw) setZfwOverrides(data.overrides.zfw);
        if (data.overrides.fee) setFeeOverrides(data.overrides.fee);
        if (data.overrides.waiver_gal) setWaiverGalOverrides(data.overrides.waiver_gal);
        if (data.overrides.fuel_burn) setFuelBurnOverrides(data.overrides.fuel_burn);
      }
    } catch { setError("Failed to load plan"); }
    setLoading(false);
  }, [token]);

  useEffect(() => { loadPlan(); }, [loadPlan]);

  // Fetch price history when plan loads
  useEffect(() => {
    if (!plan?.legs?.length) return;
    const airports = [...new Set(plan.legs.map((l) => {
      const c = l.from;
      return c.length === 4 && c.startsWith("K") ? c.slice(1) : c;
    }))];
    if (!airports.length) return;
    fetch(`/api/fuel-planning/price-history?airports=${airports.join(",")}&limit=5`)
      .then((r) => r.json())
      .then((d) => { if (d.ok) setPriceHistory(d.history); })
      .catch(() => {});
  }, [plan]);

  // Admins can request fuel. Crew (tokenized link) see status only.
  const canRequestFuel = mode === "admin";

  // Check if viewer is authenticated for admin-gated API calls
  useEffect(() => {
    fetch("/api/fuel-releases?limit=0", { credentials: "include" })
      .then((r) => { if (r.ok) setIsAuthed(true); })
      .catch(() => {});
  }, []);

  // Load existing releases for this plan token (admin path uses
  // /api/fuel-releases; crew path uses the public shared-plan releases
  // endpoint which exposes status + reply).
  useEffect(() => {
    if (!token) return;
    if (isAuthed) {
      fetch(`/api/fuel-releases?limit=100`, { credentials: "include" })
        .then((r) => r.json())
        .then((data) => {
          if (!data.releases) return;
          const byLeg: Record<number, { status: "submitted"; id: string }> = {};
          for (const rel of data.releases) {
            if (rel.plan_link_token === token && rel.plan_leg_index != null && rel.status !== "cancelled") {
              byLeg[rel.plan_leg_index] = { status: "submitted", id: rel.id };
            }
          }
          setReleaseStatus((prev) => ({ ...prev, ...byLeg }));
        })
        .catch(() => {});
    }
    // Always load public release details (status + reply thread) for
    // display. This works for crew (unauthed) and admin alike.
    fetch(`/api/fuel-planning/shared-plan/${token}/releases`)
      .then((r) => r.json())
      .then((data) => {
        if (!data.releases) return;
        const byLeg: Record<number, { status: "submitted"; id: string }> = {};
        const details: typeof releaseDetails = {};
        for (const rel of data.releases) {
          if (rel.plan_leg_index != null) {
            byLeg[rel.plan_leg_index] = { status: "submitted", id: rel.id };
            details[rel.plan_leg_index] = {
              status: rel.status,
              vendor_name: rel.vendor_name,
              vendor_confirmation: rel.vendor_confirmation,
              latest_reply: rel.latest_reply,
              timeline: rel.timeline,
              attachments: rel.attachments,
            };
          }
        }
        setReleaseStatus((prev) => ({ ...prev, ...byLeg }));
        setReleaseDetails(details);
      })
      .catch(() => {});
  }, [token, isAuthed]);

  // Load public release status (no auth required) — visible to everyone
  useEffect(() => {
    if (!token) return;
    fetch(`/api/fuel-planning/shared-plan/${token}/releases`)
      .then((r) => r.json())
      .then((data) => {
        if (!data.ok) return;
        setPublicReleases(data.releases ?? []);
        setVendorMeta(data.vendors ?? {});
      })
      .catch(() => {});
  }, [token]);

  // Helper: find release for a specific airport code
  const getReleaseForAirport = useCallback((airportCode: string): PublicRelease | undefined => {
    return publicReleases.find((r) => r.airport_code === airportCode && r.status !== "cancelled");
  }, [publicReleases]);

  // Helper: get payment method info for a vendor name
  const getPaymentMethod = useCallback((vendorName: string | null): { type: "email" | "card" | "api" | "unknown"; label: string } => {
    if (!vendorName) return { type: "unknown", label: "Unknown" };
    const lower = vendorName.toLowerCase();
    // Card vendors
    if (lower.includes("signature") || lower === "retail" || lower.includes("horizon card")) {
      return { type: "card", label: "Card on File" };
    }
    // Look up in vendor metadata
    const meta = vendorMeta[lower];
    if (meta) {
      if (meta.release_type === "email") return { type: "email", label: "Email Release" };
      if (meta.release_type === "card") return { type: "card", label: "Card on File" };
      if (meta.release_type === "api") return { type: "api", label: "API Release" };
    }
    return { type: "unknown", label: "Manual" };
  }, [vendorMeta]);

  const RELEASE_STATUS_STYLES: Record<string, string> = {
    pending: "bg-gray-100 text-gray-700",
    confirmed: "bg-green-100 text-green-700",
    completed: "bg-green-200 text-green-800",
    rejected: "bg-red-100 text-red-700",
    failed: "bg-red-100 text-red-700",
  };

  const PAYMENT_METHOD_STYLES: Record<string, string> = {
    email: "bg-blue-50 text-blue-700",
    card: "bg-amber-50 text-amber-700",
    api: "bg-green-50 text-green-700",
    unknown: "bg-gray-50 text-gray-600",
  };

  const submitRelease = async (legIndex: number) => {
    if (!plan?.plan || !token) return;
    const leg = plan.legs[legIndex];
    const orderGal = plan.plan.fuelOrderGalByStop[legIndex] ?? 0;
    if (orderGal <= 0) return;

    setReleaseStatus((prev) => ({ ...prev, [legIndex]: { status: "loading" } }));
    try {
      const res = await fetch("/api/fuel-releases/submit", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          airport: leg.from,
          fbo: leg.departureFbo || leg.waiver?.fboName || "",
          tailNumber: plan.tail,
          vendorName: leg.departureFboVendor || "",
          gallons: Math.round(orderGal),
          quotedPrice: leg.departurePricePerGal > 0 ? leg.departurePricePerGal : undefined,
          date: leg.departureDate || date,
          planLinkToken: token,
          planLegIndex: legIndex,
        }),
      });
      const data = await res.json();
      if (res.ok && data.ok) {
        setReleaseStatus((prev) => ({ ...prev, [legIndex]: { status: "submitted", id: data.id } }));
      } else {
        setReleaseStatus((prev) => ({ ...prev, [legIndex]: { status: "error", message: data.error || "Failed" } }));
      }
    } catch {
      setReleaseStatus((prev) => ({ ...prev, [legIndex]: { status: "error", message: "Network error" } }));
    }
  };

  const submitAllReleases = async () => {
    if (!plan?.plan) return;
    setRequestingAll(true);
    for (let i = 0; i < plan.legs.length; i++) {
      const orderGal = plan.plan.fuelOrderGalByStop[i] ?? 0;
      const existing = releaseStatus[i];
      if (orderGal > 0 && (!existing || existing.status === "idle" || existing.status === "error")) {
        await submitRelease(i);
      }
    }
    setRequestingAll(false);
  };

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
          fuel_burn_overrides: fuelBurnOverrides,
        }),
      });
      const data = await res.json();
      if (res.ok && data.plan) setPlan(data.plan);
    } catch { /* ignore */ }
    setRecalculating(false);
  };

  const wrapperCls = mode === "crew" ? "min-h-screen bg-gray-50" : "";
  const innerCls = mode === "crew"
    ? "max-w-6xl mx-auto px-4 sm:px-6 py-4 sm:py-6 space-y-4 sm:space-y-5"
    : "space-y-4";

  if (loading) {
    return (
      <div className={`${wrapperCls} flex items-center justify-center p-6`}>
        <p className="text-gray-500 animate-pulse">Loading fuel plan...</p>
      </div>
    );
  }

  if (error || !plan) {
    return (
      <div className={`${wrapperCls} flex items-center justify-center p-6`}>
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

  // Visible leg indices (crew = today only, admin = all)
  const isLegVisible = (leg: { departureDate?: string }) =>
    mode !== "crew" || !date || !leg.departureDate || leg.departureDate === date;
  const visibleTotals = optimized ? (() => {
    let lbs = 0, gal = 0, cost = 0;
    plan.legs.forEach((leg, i) => {
      if (!isLegVisible(leg)) return;
      const orderGal = optimized.fuelOrderGalByStop[i] ?? 0;
      const feePaid = optimized.feePaidByStop[i] ?? 0;
      lbs += optimized.fuelOrderLbsByStop[i] ?? 0;
      gal += orderGal;
      cost += orderGal * leg.departurePricePerGal + feePaid;
    });
    return { lbs, gal, cost };
  })() : null;

  return (
    <div className={wrapperCls}>
      <div className={innerCls}>

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
              {savings > 0 && plan.legs.length > 1 && (
                <span className="text-sm font-semibold text-green-600">
                  Save {fmtDollars(savings)}
                </span>
              )}
              {plan.legs.length === 1 && plan.legs[0]?.departurePricePerGal > 0 &&
                (plan.nationalAvgPrice ?? 0) > 0 && plan.legs[0].departurePricePerGal < (plan.nationalAvgPrice ?? 0) && (
                <span className="text-[10px] px-2 py-0.5 rounded-full bg-blue-50 text-blue-600 border border-blue-200">
                  ${plan.legs[0].departurePricePerGal.toFixed(2)} vs ${(plan.nationalAvgPrice ?? 0).toFixed(2)} avg — likely tanker opportunity when follow-on leg is known
                </span>
              )}
              {visibleTotals && (
                <span className="text-sm font-semibold text-gray-900">
                  {fmtDollars(visibleTotals.cost)}
                </span>
              )}
              {/* Request All Fuel button removed — releases are requested per-leg from the table below. */}
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

          {/* Fuel Vendor Plan */}
        {plan.legs.length > 0 && plan.legs.some((l) => (l.allVendors?.length ?? 0) > 0 || l.departureFboVendor) && (
          <div className="rounded-lg border border-gray-200 bg-white overflow-hidden">
            <div className="px-4 sm:px-5 py-3 bg-blue-50 border-b border-blue-100">
              <span className="text-sm font-semibold text-blue-900">Fuel Vendor Plan</span>
              <span className="text-xs text-blue-600 ml-2">Best vendor at each stop</span>
            </div>
            <div className="px-4 sm:px-5 py-3">
              <div className="space-y-2">
                {plan.legs.map((leg, i) => {
                  // Crew mode: only show the selected plan date's legs.
                  if (mode === "crew" && date && leg.departureDate && leg.departureDate !== date) return null;
                  const vendors = leg.allVendors ?? [];
                  const chosen = leg.departureFboVendor;
                  const chosenPrice = leg.departurePricePerGal;
                  const best = vendors[0];
                  const isOverpaying = best && chosenPrice > 0 && chosenPrice > best.price + 0.005;
                  const sourceLabel = leg.priceSource === "trip_notes" ? "Rep pick" : leg.priceSource === "contract" ? "Contract" : leg.priceSource === "retail" ? "Retail" : "";

                  return (
                    <div key={i} className="flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-3 py-2 border-b border-gray-50 last:border-0">
                      <div className="flex items-center gap-2 min-w-[120px]">
                        <span className="font-semibold text-gray-900 text-sm">{leg.from}</span>
                        <span className="text-gray-400 text-xs">&rarr;</span>
                        <span className="text-gray-500 text-sm">{leg.to}</span>
                      </div>

                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          {/* Current choice */}
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

                          {/* Overpay warning */}
                          {isOverpaying && best && (
                            <span className="text-xs text-amber-600 font-medium">
                              Better: {best.vendor} @ ${best.price.toFixed(4)} (save ${(chosenPrice - best.price).toFixed(4)}/gal)
                            </span>
                          )}
                        </div>

                        {/* FBO name */}
                        {leg.departureFbo && (
                          <div className="text-[10px] text-gray-400 mt-0.5">{leg.departureFbo}</div>
                        )}
                      </div>

                      {/* Alternative vendor options — cheapest in green, rest gray.
                          Skip the selected vendor so we don't double-display. */}
                      {vendors.length > 0 && (() => {
                        const alts = vendors.filter((v) => !(chosen && v.vendor === chosen && Math.abs(v.price - chosenPrice) < 0.001));
                        if (!alts.length) return null;
                        return (
                          <div className="flex gap-1 flex-wrap">
                            {alts.slice(0, 4).map((v, vi) => (
                              <span key={vi} className={`text-[10px] px-1.5 py-0.5 rounded border ${
                                vi === 0 ? "border-green-200 bg-green-50 text-green-700 font-medium" : "border-gray-100 text-gray-500"
                              }`}>
                                {v.vendor} ${v.price.toFixed(4)} <span className="opacity-50">{v.tier}</span>
                              </span>
                            ))}
                          </div>
                        );
                      })()}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}

        {/* FBO Fees — per leg, three-source merged */}
        {plan.legs.length > 0 && (
          <FboFeesBlock
            legs={plan.legs
              .filter((l) => mode !== "crew" || !date || !l.departureDate || l.departureDate === date)
              .map((l) => ({
                airport: l.from,
                fbo_name: l.departureFbo ?? l.waiver?.fboName ?? "",
                aircraft_type: plan.aircraftType === "CE-750" ? "Citation X" : plan.aircraftType === "CL-30" ? "Challenger 300" : String(plan.aircraftType),
              }))}
            onEditMissing={(q) => setFeeEditTarget(q)}
          />
        )}

        {feeEditTarget && (
          <FboFeesEditModal
            target={feeEditTarget}
            onClose={() => setFeeEditTarget(null)}
            onSaved={() => { setFeeEditTarget(null); loadPlan(); }}
          />
        )}

        {/* Price History — collapsible */}
        {priceHistory && Object.keys(priceHistory).length > 0 && (
          <div className="rounded-lg border border-gray-200 bg-white overflow-hidden">
            <button onClick={() => setShowHistory(!showHistory)}
              className="w-full px-4 sm:px-5 py-3 flex items-center justify-between bg-gray-50 hover:bg-gray-100 transition-colors">
              <span className="text-sm font-medium text-gray-700">Price History</span>
              <svg className={`w-4 h-4 text-gray-400 transition-transform ${showHistory ? "rotate-180" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </button>
            {showHistory && (
              <div className="px-4 sm:px-5 py-3 border-t border-gray-200 space-y-3">
                {plan.legs.map((leg, i) => {
                  if (mode === "crew" && date && leg.departureDate && leg.departureDate !== date) return null;
                  const ap = leg.from.length === 4 && leg.from.startsWith("K") ? leg.from.slice(1) : leg.from;
                  const hist = priceHistory[ap];
                  if (!hist || hist.recentPrices.length === 0) return null;
                  return (
                    <div key={i} className="border-b border-gray-50 pb-2 last:border-0 last:pb-0">
                      <div className="flex items-center gap-3 mb-1">
                        <span className="font-semibold text-sm text-gray-900">{ap}</span>
                        <span className="text-xs text-gray-500">
                          Avg ${hist.avgPrice.toFixed(4)} · Low ${hist.minPrice.toFixed(4)} · High ${hist.maxPrice.toFixed(4)}
                        </span>
                        {leg.departurePricePerGal > 0 && hist.avgPrice > 0 && (
                          <span className={`text-xs font-medium ${
                            leg.departurePricePerGal < hist.avgPrice ? "text-green-600" : leg.departurePricePerGal > hist.avgPrice + 0.05 ? "text-red-600" : "text-gray-500"
                          }`}>
                            {leg.departurePricePerGal < hist.avgPrice ? "Below avg" : leg.departurePricePerGal > hist.avgPrice + 0.05 ? "Above avg" : "Near avg"}
                          </span>
                        )}
                      </div>
                      <div className="flex flex-wrap gap-1">
                        {hist.recentPrices.map((p, pi) => (
                          <span key={pi} className="text-[10px] px-1.5 py-0.5 rounded border border-gray-100 text-gray-500">
                            ${p.price.toFixed(4)} · {p.vendor} · {p.date} · {Math.round(p.gallons)} gal
                          </span>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {optimized && plan.legs.length > 0 && (
            <div className="px-4 sm:px-5 py-4">

              {/* Desktop table — hidden on mobile */}
              <div className="hidden md:block overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs text-gray-500 border-b border-gray-100">
                      <th className="pb-2 pr-3">Leg</th>
                      <th className="pb-2 pr-3 text-right">Fuel to Dest</th>
                      <th className="pb-2 pr-3 text-right">Flight Time</th>
                      <th className="pb-2 pr-3 text-right">Price/gal</th>
                      <th className="pb-2 pr-3">FBO / Payment</th>
                      <th className="pb-2 pr-3 text-right">Handling Fee</th>
                      <th className="pb-2 pr-3 text-right">Order (lbs)</th>
                      <th className="pb-2 pr-3 text-right">Order (gal)</th>
                      <th className="pb-2 pr-3 text-right">Landing Fuel</th>
                      <th className="pb-2 text-right">Cost</th>
                      <th className="pb-2 pr-3 text-center">Release</th>
                      {canRequestFuel && <th className="pb-2 pl-3"></th>}
                    </tr>
                  </thead>
                  <tbody>
                    {plan.legs.map((leg, i) => {
                      if (mode === "crew" && date && leg.departureDate && leg.departureDate !== date) return null;
                      const orderLbs = optimized.fuelOrderLbsByStop[i] ?? 0;
                      const orderGal = optimized.fuelOrderGalByStop[i] ?? 0;
                      const landingFuel = optimized.landingFuelByStop[i] ?? 0;
                      const feePaid = optimized.feePaidByStop[i] ?? 0;
                      const legCost = orderGal * leg.departurePricePerGal + feePaid;
                      const prevDate = i > 0 ? plan.legs[i - 1].departureDate : null;
                      const showDayHeader = mode !== "crew" && leg.departureDate && leg.departureDate !== prevDate;

                      return (<>
                        {showDayHeader && (
                          <tr key={`day-${i}`} className="bg-gray-50">
                            <td colSpan={canRequestFuel ? 12 : 11} className="py-1.5 px-1 text-xs font-semibold text-gray-500 uppercase tracking-wide">
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
                            {(() => {
                              const method = getPaymentMethod(leg.departureFboVendor);
                              if (method.type === "unknown") return null;
                              return (
                                <span className={`inline-block mt-1 px-1.5 py-0.5 text-[10px] font-medium rounded ${PAYMENT_METHOD_STYLES[method.type] ?? PAYMENT_METHOD_STYLES.unknown}`}>
                                  {method.label}
                                </span>
                              );
                            })()}
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
                          <td className="py-2.5 pr-3 text-center align-top">
                            {(() => {
                              const method = getPaymentMethod(leg.departureFboVendor);
                              if (method.type === "card") {
                                return (
                                  <span className="text-[10px] px-2 py-0.5 rounded-full font-medium bg-amber-50 text-amber-700 whitespace-nowrap">
                                    Use Card
                                  </span>
                                );
                              }
                              if (orderGal <= 0) return <span className="text-gray-300 text-xs">—</span>;
                              const det = releaseDetails[i];
                              const rel = getReleaseForAirport(leg.from);
                              if (!rel && !det) {
                                return <span className="text-[10px] text-gray-400 italic">not requested</span>;
                              }
                              const relStatus = det?.status ?? rel?.status ?? "pending";
                              const ref = det?.vendor_confirmation ?? rel?.vendor_confirmation;
                              return (
                                <div className="flex flex-col items-center gap-0.5">
                                  <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${RELEASE_STATUS_STYLES[relStatus] ?? RELEASE_STATUS_STYLES.pending}`}>
                                    {relStatus}
                                  </span>
                                  {ref && (
                                    <span className="text-[9px] text-gray-400 font-mono">{ref}</span>
                                  )}
                                  {det?.latest_reply?.note && (
                                    <span className="text-[9px] text-gray-500 max-w-[160px] truncate" title={det.latest_reply.note}>
                                      &ldquo;{det.latest_reply.note.slice(0, 40)}{det.latest_reply.note.length > 40 ? "…" : ""}&rdquo;
                                    </span>
                                  )}
                                  {(det?.attachments ?? []).filter((a) => a.url).map((a, ai) => (
                                    <a
                                      key={ai}
                                      href={a.url ?? "#"}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      className="text-[9px] text-blue-600 hover:underline truncate max-w-[160px]"
                                      title={a.name}
                                    >
                                      📎 {a.name}
                                    </a>
                                  ))}
                                </div>
                              );
                            })()}
                          </td>
                          {canRequestFuel && (
                            <td className="py-2.5 pl-3">
                              {orderGal > 0 && (() => {
                                const rs = releaseStatus[i];
                                if (rs?.status === "submitted") return (
                                  <span className="text-xs px-2 py-1 rounded-md bg-green-100 text-green-700 font-medium whitespace-nowrap">Requested</span>
                                );
                                if (rs?.status === "loading") return (
                                  <span className="text-xs px-2 py-1 rounded-md bg-gray-100 text-gray-500 font-medium animate-pulse whitespace-nowrap">Sending...</span>
                                );
                                if (rs?.status === "error") return (
                                  <button onClick={() => submitRelease(i)}
                                    className="text-xs px-2 py-1 rounded-md bg-red-100 text-red-700 font-medium hover:bg-red-200 transition-colors whitespace-nowrap"
                                    title={rs.message}>Retry</button>
                                );
                                return (
                                  <button onClick={() => submitRelease(i)}
                                    className="text-xs px-2 py-1 rounded-md bg-blue-100 text-blue-700 font-medium hover:bg-blue-200 transition-colors whitespace-nowrap">
                                    Request Fuel</button>
                                );
                              })()}
                            </td>
                          )}
                        </tr>
                      </>);
                    })}
                  </tbody>
                  <tfoot>
                    <tr className="border-t border-gray-200">
                      <td colSpan={6} className="py-2.5 text-xs text-gray-500 font-medium">TOTALS</td>
                      <td className="py-2.5 pr-3 text-right font-mono font-bold text-gray-900">{fmtNum(visibleTotals?.lbs ?? 0)}</td>
                      <td className="py-2.5 pr-3 text-right font-mono font-bold text-gray-900">{fmtNum(visibleTotals?.gal ?? 0)}</td>
                      <td className="py-2.5 pr-3"></td>
                      <td className="py-2.5 text-right font-mono font-bold text-gray-900">{fmtDollars(visibleTotals?.cost ?? 0)}</td>
                      <td className="py-2.5"></td>
                      {canRequestFuel && <td></td>}
                    </tr>
                  </tfoot>
                </table>
              </div>

              {/* Mobile cards — hidden on desktop */}
              <div className="md:hidden space-y-3">
                {plan.legs.map((leg, i) => {
                  if (mode === "crew" && date && leg.departureDate && leg.departureDate !== date) return null;
                  const orderLbs = optimized.fuelOrderLbsByStop[i] ?? 0;
                  const orderGal = optimized.fuelOrderGalByStop[i] ?? 0;
                  const landingFuel = optimized.landingFuelByStop[i] ?? 0;
                  const prevDate = i > 0 ? plan.legs[i - 1].departureDate : null;
                  const showDayHeader = mode !== "crew" && leg.departureDate && leg.departureDate !== prevDate;
                  const feePaid = optimized.feePaidByStop[i] ?? 0;
                  const tankerOut = optimized.tankerOutByStop[i] ?? 0;
                  const legCost = orderGal * leg.departurePricePerGal + feePaid;

                  return (<React.Fragment key={i}>
                    {showDayHeader && (
                      <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide pt-1">
                        {new Date(leg.departureDate + "T12:00:00").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })}
                      </div>
                    )}
                    <div className="rounded-lg border p-3 border-gray-200 bg-white">
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

                      {/* FBO + payment method + release status */}
                      <div className="text-xs text-gray-600 mb-2 flex flex-wrap items-center gap-1.5">
                        <span className="font-medium">{leg.departureFbo || leg.waiver?.fboName || "—"}</span>
                        {leg.departureFboVendor && leg.departureFboVendor !== leg.departureFbo && (
                          <span className="text-blue-500">via {leg.departureFboVendor}</span>
                        )}
                        {(() => {
                          const method = getPaymentMethod(leg.departureFboVendor);
                          if (method.type === "unknown") return null;
                          return (
                            <span className={`px-1.5 py-0.5 text-[10px] font-medium rounded ${PAYMENT_METHOD_STYLES[method.type]}`}>
                              {method.label}
                            </span>
                          );
                        })()}
                        {(() => {
                          const method = getPaymentMethod(leg.departureFboVendor);
                          if (method.type === "card") return null;
                          if (orderGal <= 0) return null;
                          const rel = getReleaseForAirport(leg.from);
                          if (!rel) return null;
                          return (
                            <span className={`px-1.5 py-0.5 text-[10px] font-medium rounded-full ${RELEASE_STATUS_STYLES[rel.status] ?? RELEASE_STATUS_STYLES.pending}`}>
                              {rel.status}
                            </span>
                          );
                        })()}
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
                        <div className="mt-2 text-xs font-semibold text-gray-700">
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

                      {/* Request Fuel button (admin) / status display (crew) */}
                      {orderGal > 0 && (() => {
                        const rs = releaseStatus[i];
                        const det = releaseDetails[i];
                        const renderDetails = () => (
                          <>
                            {det?.vendor_confirmation && (
                              <div className="mt-1 text-[10px] font-mono text-gray-500 text-center">{det.vendor_confirmation}</div>
                            )}
                            {det?.latest_reply?.note && (
                              <div className="mt-1 text-[10px] text-gray-500 text-center italic">
                                &ldquo;{det.latest_reply.note.slice(0, 80)}{det.latest_reply.note.length > 80 ? "…" : ""}&rdquo;
                              </div>
                            )}
                            {(det?.attachments ?? []).filter((a) => a.url).map((a, ai) => (
                              <a
                                key={ai}
                                href={a.url ?? "#"}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="mt-1 block text-center text-[11px] text-blue-600 hover:underline truncate"
                                title={a.name}
                              >
                                📎 {a.name}
                              </a>
                            ))}
                          </>
                        );
                        if (rs?.status === "submitted") {
                          const relStatus = det?.status ?? "pending";
                          const cls =
                            relStatus === "confirmed" ? "bg-green-100 text-green-700"
                            : relStatus === "rejected" ? "bg-red-100 text-red-700"
                            : "bg-amber-100 text-amber-700";
                          return (
                            <div className="mt-2">
                              <div className={`text-center text-xs px-3 py-1.5 rounded-md font-medium ${cls}`}>{relStatus}</div>
                              {renderDetails()}
                            </div>
                          );
                        }
                        if (rs?.status === "loading") return (
                          <div className="mt-2 text-center text-xs px-3 py-1.5 rounded-md bg-gray-100 text-gray-500 font-medium animate-pulse">Sending...</div>
                        );
                        if (rs?.status === "error" && canRequestFuel) return (
                          <button onClick={() => submitRelease(i)}
                            className="mt-2 w-full text-xs px-3 py-1.5 rounded-md bg-red-100 text-red-700 font-medium hover:bg-red-200 transition-colors"
                            title={rs.message}>Retry Request</button>
                        );
                        if (canRequestFuel) return (
                          <button onClick={() => submitRelease(i)}
                            className="mt-2 w-full text-xs px-3 py-1.5 rounded-md bg-blue-100 text-blue-700 font-medium hover:bg-blue-200 transition-colors">
                            Request Fuel</button>
                        );
                        return (
                          <div className="mt-2 text-center text-xs px-3 py-1.5 rounded-md bg-gray-50 text-gray-400 italic">Not yet requested</div>
                        );
                      })()}
                    </div>
                  </React.Fragment>);
                })}

                {/* Mobile totals */}
                <div className="rounded-lg border border-gray-200 bg-white p-3">
                  <div className="flex justify-between text-sm">
                    <span className="text-gray-600 font-medium">Total Fuel</span>
                    <span className="font-mono font-bold">{fmtNum(visibleTotals?.gal ?? 0)} gal</span>
                  </div>
                  <div className="flex justify-between text-sm mt-1">
                    <span className="text-gray-600 font-medium">Total Cost</span>
                    <span className="font-mono font-bold">{fmtDollars(visibleTotals?.cost ?? 0)}</span>
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
                      return (
                        <div key={i} className="text-xs rounded-md px-3 py-1.5 border bg-gray-50 text-gray-700 border-gray-200">
                          <span className="font-semibold">{leg.from}</span>: carry +{fmtNum(tankerOut)} lbs
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
                {plan.legs.map((leg, i) => {
                  const legZfw = leg.ffZfw ?? acDefaults.zfw;
                  const legMlw = leg.ffMlw ?? acDefaults.mlw;
                  return (
                    <div key={i} className="border border-gray-100 rounded-lg px-3 py-2">
                      <div className="text-sm text-gray-700 font-semibold mb-2">{leg.from} &rarr; {leg.to}</div>
                      <div className="grid grid-cols-2 sm:flex sm:flex-wrap items-center gap-3">
                        <div className="flex items-center gap-1">
                          <label className="text-xs text-gray-500 w-14">To Dest</label>
                          <input type="number" value={fuelBurnOverrides[String(i)] ?? leg.fuelToDestLbs}
                            onChange={(e) => setFuelBurnOverrides({ ...fuelBurnOverrides, [String(i)]: parseInt(e.target.value) || leg.fuelToDestLbs })}
                            className="w-full sm:w-24 text-xs border border-gray-300 rounded px-2 py-1.5 text-right" />
                        </div>
                        <div className="flex items-center gap-1">
                          <label className="text-xs text-gray-500 w-10">MLW</label>
                          <input type="number" value={mlwOverrides[String(i)] ?? legMlw}
                            onChange={(e) => setMlwOverrides({ ...mlwOverrides, [String(i)]: parseInt(e.target.value) || legMlw })}
                            className="w-full sm:w-24 text-xs border border-gray-300 rounded px-2 py-1.5 text-right" />
                        </div>
                        <div className="flex items-center gap-1">
                          <label className="text-xs text-gray-500 w-10">ZFW</label>
                          <input type="number" value={zfwOverrides[String(i)] ?? legZfw}
                            onChange={(e) => setZfwOverrides({ ...zfwOverrides, [String(i)]: parseInt(e.target.value) || legZfw })}
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
                  );
                })}
              </div>
              <button onClick={recalculate} disabled={recalculating}
                className="mt-4 w-full sm:w-auto px-5 py-2.5 bg-blue-600 text-white text-sm font-medium rounded-md hover:bg-blue-500 disabled:opacity-50 transition-colors">
                {recalculating ? "Recalculating..." : "Recalculate Plan"}
              </button>
            </div>
          )}
        </div>

        {mode === "crew" && (
          <p className="text-center text-xs text-gray-400">
            Baker Aviation Fuel Planning &mdash; expires {new Date(expiresAt).toLocaleString()}
          </p>
        )}
      </div>
    </div>
  );
}

export default function SharedPlanPage({ params }: { params: Promise<{ token: string }> }) {
  const [token, setToken] = useState<string | null>(null);
  useEffect(() => { params.then((p) => setToken(p.token)); }, [params]);
  return <SharedPlanView token={token} mode="crew" />;
}
