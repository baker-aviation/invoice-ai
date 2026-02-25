"use client";

import React, { useState, useMemo } from "react";
import {
  AircraftType, AIRCRAFT_TYPES, TankerInputs, DEFAULT_INPUTS,
  computeResult, getOptimumTankerOut, getMaxTankerOut85, getPlannedArrival, calcPpg,
  MultiLeg, MultiRouteInputs, DEFAULT_MULTI, makeDefaultLeg,
  optimizeMultiLeg, getMultiPlannedArrival, getMultiMaxLF, MultiLegPlan,
} from "./model";

// ── helpers ──────────────────────────────────────────────────────────────────

function n0(v: number) { return Math.round(v).toLocaleString("en-US"); }
function n2(v: number) { return v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function dollar(v: number) {
  const s = Math.abs(Math.round(v)).toLocaleString("en-US");
  return v < 0 ? `-$${s}` : `$${s}`;
}

// ── primitive form components ─────────────────────────────────────────────────

function NumInput({
  label, value, onChange, step = 1, note,
}: {
  label: string; value: number; onChange: (v: number) => void;
  step?: number; note?: string;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-medium text-gray-500 uppercase tracking-wide leading-none">
        {label}
      </span>
      <input
        type="number"
        step={step}
        value={value || ""}
        onChange={e => { const v = parseFloat(e.target.value); onChange(isNaN(v) ? 0 : v); }}
        className="border border-gray-200 rounded-lg px-3 py-2 text-sm w-full focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
      />
      {note && <span className="text-xs text-gray-400">{note}</span>}
    </label>
  );
}

function TextInput({
  label, value, onChange, placeholder,
}: {
  label: string; value: string; onChange: (v: string) => void; placeholder?: string;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-medium text-gray-500 uppercase tracking-wide leading-none">{label}</span>
      <input
        type="text"
        value={value}
        placeholder={placeholder}
        onChange={e => onChange(e.target.value)}
        className="border border-gray-200 rounded-lg px-3 py-2 text-sm w-full focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white uppercase"
      />
    </label>
  );
}

function SectionCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-4 space-y-3">
      <div className="text-xs font-semibold text-gray-400 uppercase tracking-widest">{title}</div>
      {children}
    </div>
  );
}

function Grid2({ children }: { children: React.ReactNode }) {
  return <div className="grid grid-cols-2 gap-3">{children}</div>;
}

function Grid3({ children }: { children: React.ReactNode }) {
  return <div className="grid grid-cols-3 gap-3">{children}</div>;
}

function ResultRow({
  label, value, unit, warn, ok,
}: {
  label: string; value: string; unit?: string; warn?: boolean; ok?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between py-1 border-b border-gray-50 last:border-0">
      <span className="text-sm text-gray-500">{label}</span>
      <span className={`text-sm font-semibold tabular-nums ${warn ? "text-red-600" : ok ? "text-green-600" : "text-gray-800"}`}>
        {value}{unit ? <span className="ml-1 font-normal text-gray-400 text-xs">{unit}</span> : null}
      </span>
    </div>
  );
}

// ── Fueling Mode modal ────────────────────────────────────────────────────────

function FuelingModal({ lbs, gal, route, exceedsMLW, onClose }: {
  lbs: number; gal: number; route: string; exceedsMLW: boolean; onClose: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-3xl shadow-2xl p-10 mx-6 max-w-sm w-full text-center space-y-4"
        onClick={e => e.stopPropagation()}
      >
        <div className="text-sm font-semibold text-gray-400 uppercase tracking-widest">
          {route || "Fueling Mode"}
        </div>
        <div className="text-xs text-gray-400 uppercase tracking-wide">Order this much</div>
        <div className="text-6xl font-black text-gray-900 tabular-nums">
          {n0(lbs)} <span className="text-2xl font-semibold text-gray-400">lbs</span>
        </div>
        <div className="text-4xl font-bold text-blue-600 tabular-nums">
          {n0(gal)} <span className="text-xl font-semibold text-blue-400">gal</span>
        </div>
        {exceedsMLW && (
          <div className="text-red-600 text-sm font-semibold bg-red-50 rounded-xl px-4 py-2">
            ⚠️ Landing fuel exceeds MLW — reduce tanker-out
          </div>
        )}
        <button
          onClick={onClose}
          className="mt-2 w-full bg-gray-900 text-white font-semibold py-3 rounded-2xl hover:bg-gray-700 transition"
        >
          Done
        </button>
      </div>
    </div>
  );
}

// ── Single-leg results panel ──────────────────────────────────────────────────

function ResultsPanel({
  result, inp, useManual, onFuelingMode,
}: {
  result: ReturnType<typeof computeResult>;
  inp: TankerInputs;
  useManual: boolean;
  onFuelingMode: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const savingsColor = result.netSavings >= 0 ? "text-green-600" : "text-red-600";

  return (
    <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5 space-y-4 sticky top-6">
      <div className="text-xs font-semibold text-gray-400 uppercase tracking-widest">Results</div>

      {/* Net savings */}
      <div className={`text-4xl font-black tabular-nums ${savingsColor}`}>
        {dollar(result.netSavings)}
        <span className="ml-2 text-base font-normal text-gray-400">net savings</span>
      </div>

      {result.exceedsMLW && (
        <div className="text-red-600 text-xs font-semibold bg-red-50 rounded-xl px-3 py-2">
          ⚠️ Landing fuel {n0(result.landingFuel)} lbs exceeds MLW limit {n0(result.maxLF)} lbs
        </div>
      )}
      {result.losesFeeWaiver && (
        <div className="text-amber-600 text-xs font-semibold bg-amber-50 rounded-xl px-3 py-2">
          ⚠️ Tankering causes you to miss the fee waiver at destination
        </div>
      )}

      {/* Key metrics */}
      <div className="space-y-0">
        <ResultRow label={useManual ? "Tanker-out (manual)" : "Tanker-out (optimum)"} value={n0(result.tankerOut)} unit="lbs" />
        <ResultRow label="Tanker-in" value={n0(result.tankerIn)} unit="lbs" />
        <ResultRow label="Added burn" value={n0(result.addedBurn)} unit="lbs" />
        <ResultRow
          label="Landing fuel"
          value={`${n0(result.landingFuel)} / ${n0(result.maxLF)}`}
          unit="lbs"
          warn={result.exceedsMLW}
          ok={!result.exceedsMLW && result.landingFuel > 0}
        />
      </div>

      {/* Fuel to order — the big actionable number */}
      <div className="bg-blue-50 rounded-xl p-4 text-center">
        <div className="text-xs font-semibold text-blue-400 uppercase tracking-wide mb-1">Fuel to order</div>
        <div className="text-3xl font-black text-blue-700 tabular-nums">{n0(result.fuelToOrderLbs)} lbs</div>
        <div className="text-lg font-semibold text-blue-500 tabular-nums">{n0(result.fuelToOrderGal)} gal</div>
        <div className="text-xs text-blue-400 mt-1">{n2(result.ppg)} lb/gal</div>
      </div>

      {/* Savings breakdown toggle */}
      <button
        onClick={() => setExpanded(e => !e)}
        className="text-xs text-blue-600 hover:underline w-full text-left"
      >
        {expanded ? "Hide breakdown ▲" : "Show savings breakdown ▼"}
      </button>

      {expanded && (
        <div className="space-y-0 text-sm border-t pt-3">
          <ResultRow label="Price delta" value={`$${n2(inp.nextLegFuelPrice - inp.departureFuelPrice)}`} unit="/gal" />
          <ResultRow label="Tanker savings" value={dollar(result.tankerSavings)} ok={result.tankerSavings > 0} />
          <ResultRow label="Carry cost (added burn)" value={`-${dollar(result.carryCost)}`} />
          {result.feeImpact !== 0 && (
            <ResultRow label="Fee impact" value={dollar(result.feeImpact)} warn={result.feeImpact < 0} ok={result.feeImpact > 0} />
          )}
          <div className="flex justify-between pt-2 border-t">
            <span className="text-sm font-semibold text-gray-700">Net savings</span>
            <span className={`text-sm font-bold tabular-nums ${savingsColor}`}>{dollar(result.netSavings)}</span>
          </div>
        </div>
      )}

      {/* Fueling mode button */}
      <button
        onClick={onFuelingMode}
        className="w-full bg-gray-900 hover:bg-gray-700 text-white font-semibold py-2.5 rounded-xl transition text-sm"
      >
        ⛽ Fueling Mode
      </button>
    </div>
  );
}

// ── Single-leg form ───────────────────────────────────────────────────────────

function SingleLegPlanner() {
  const [inp, setInp] = useState<TankerInputs>(DEFAULT_INPUTS);
  const [useManual, setUseManual] = useState(false);
  const [manualOut, setManualOut] = useState(0);
  const [route, setRoute] = useState("");
  const [showFueling, setShowFueling] = useState(false);

  const set = (key: keyof TankerInputs) => (v: number) =>
    setInp(prev => ({ ...prev, [key]: v }));

  const result = useMemo(
    () => computeResult(inp, useManual ? manualOut : undefined),
    [inp, useManual, manualOut],
  );

  const optimum = useMemo(() => getOptimumTankerOut(inp), [inp]);
  const max85   = useMemo(() => getMaxTankerOut85(inp),   [inp]);
  const paf     = useMemo(() => getPlannedArrival(inp),   [inp]);
  const ppg     = useMemo(() => calcPpg(inp.fuelTemperatureC), [inp.fuelTemperatureC]);

  return (
    <>
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_340px] gap-6 items-start">
        {/* ── Form ── */}
        <div className="space-y-4">
          {/* Aircraft + route */}
          <SectionCard title="Aircraft & Route">
            <div className="flex gap-2">
              {AIRCRAFT_TYPES.map(ac => (
                <button
                  key={ac}
                  onClick={() => setInp(p => ({ ...p, aircraftType: ac }))}
                  className={`flex-1 py-2 rounded-xl text-sm font-semibold border transition ${
                    inp.aircraftType === ac
                      ? "bg-gray-900 text-white border-gray-900"
                      : "bg-white text-gray-600 border-gray-200 hover:border-gray-400"
                  }`}
                >
                  {ac}
                </button>
              ))}
            </div>
            <TextInput label="Route / label" value={route} onChange={setRoute} placeholder="e.g. N700TB KBUR → KTEB" />
          </SectionCard>

          {/* This leg */}
          <SectionCard title="This Leg">
            <Grid3>
              <NumInput label="Last Shutdown (lbs)" value={inp.lastLegShutdownFuelLbs} onChange={set("lastLegShutdownFuelLbs")} />
              <NumInput label="Start Fuel (lbs)" value={inp.startFuelThisLeg} onChange={set("startFuelThisLeg")} />
              <NumInput label="Fuel to Dest (lbs)" value={inp.fuelToDestination} onChange={set("fuelToDestination")} />
            </Grid3>
            <Grid3>
              <NumInput label="Flight Time (hrs)" value={inp.flightTimeHours} onChange={set("flightTimeHours")} step={0.1} />
              <NumInput label="MLW (lbs)" value={inp.maxLandingGrossWeight} onChange={set("maxLandingGrossWeight")} />
              <NumInput label="ZFW (lbs)" value={inp.zeroFuelWeight} onChange={set("zeroFuelWeight")} />
            </Grid3>
            <Grid2>
              <NumInput label="Arrival Buffer (lbs)" value={inp.arrivalBufferLbs} onChange={set("arrivalBufferLbs")} />
              <div className="flex flex-col justify-end pb-1">
                <span className="text-xs text-gray-400">Planned arrival</span>
                <span className="text-sm font-semibold text-gray-700">{n0(paf)} lbs</span>
              </div>
            </Grid2>
          </SectionCard>

          {/* Next leg + fees */}
          <SectionCard title="Next Leg & Fees at Destination">
            <Grid3>
              <NumInput label="Next Leg Start Fuel (lbs)" value={inp.nextLegStartFuel} onChange={set("nextLegStartFuel")} />
              <NumInput label="Next Leg Buffer (lbs)" value={inp.nextLegBufferLbs} onChange={set("nextLegBufferLbs")} />
              <div />
            </Grid3>
            <Grid2>
              <NumInput label="Waiver Min (gal)" value={inp.fuelPurchaseToWaiveFeesGallons} onChange={set("fuelPurchaseToWaiveFeesGallons")}
                note="0 = no waiver program" />
              <NumInput label="Fee if Not Waived ($)" value={inp.feesWaivedDollars} onChange={set("feesWaivedDollars")} />
            </Grid2>
          </SectionCard>

          {/* Prices + density */}
          <SectionCard title="Fuel Prices & Density">
            <Grid3>
              <NumInput label="Departure ($/gal)" value={inp.departureFuelPrice} onChange={set("departureFuelPrice")} step={0.01} />
              <NumInput label="Next Leg ($/gal)" value={inp.nextLegFuelPrice} onChange={set("nextLegFuelPrice")} step={0.01} />
              <div className="flex flex-col justify-end pb-1">
                <span className="text-xs text-gray-400">Price delta</span>
                <span className={`text-sm font-semibold ${inp.nextLegFuelPrice > inp.departureFuelPrice ? "text-green-600" : "text-red-500"}`}>
                  ${n2(inp.nextLegFuelPrice - inp.departureFuelPrice)}/gal
                </span>
              </div>
            </Grid3>
            <Grid2>
              <NumInput label="OAT / Fuel Temp (°C)" value={inp.fuelTemperatureC} onChange={set("fuelTemperatureC")} step={1} />
              <div className="flex flex-col justify-end pb-1">
                <span className="text-xs text-gray-400">Jet-A density</span>
                <span className="text-sm font-semibold text-gray-700">{n2(ppg)} lb/gal</span>
              </div>
            </Grid2>
          </SectionCard>

          {/* Manual tanker option */}
          <SectionCard title="Tanker Override">
            <div className="flex items-center gap-3">
              <button
                onClick={() => setUseManual(m => !m)}
                className={`relative w-11 h-6 rounded-full transition ${useManual ? "bg-blue-600" : "bg-gray-200"}`}
              >
                <span className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${useManual ? "translate-x-5" : ""}`} />
              </button>
              <span className="text-sm text-gray-700">Use manual tanker-out</span>
            </div>
            {useManual && (
              <NumInput label="Manual Tanker-out (lbs)" value={manualOut} onChange={setManualOut} />
            )}
            <div className="text-xs text-gray-400 space-y-0.5">
              <div>Optimum: <span className="font-medium text-gray-600">{n0(optimum)} lbs</span></div>
              <div>Max 85%: <span className="font-medium text-gray-600">{n0(max85)} lbs</span></div>
            </div>
          </SectionCard>
        </div>

        {/* ── Results panel ── */}
        <ResultsPanel
          result={result}
          inp={inp}
          useManual={useManual}
          onFuelingMode={() => setShowFueling(true)}
        />
      </div>

      {showFueling && (
        <FuelingModal
          lbs={result.fuelToOrderLbs}
          gal={result.fuelToOrderGal}
          route={route}
          exceedsMLW={result.exceedsMLW}
          onClose={() => setShowFueling(false)}
        />
      )}
    </>
  );
}

// ── Multi-leg planner ─────────────────────────────────────────────────────────

function MultiLegPlanner() {
  const [route, setRoute] = useState<MultiRouteInputs>(DEFAULT_MULTI);

  const setGlobal = (key: keyof Omit<MultiRouteInputs, "legs">) => (v: number) =>
    setRoute(r => ({ ...r, [key]: v }));

  const setLeg = (id: string, key: keyof Omit<MultiLeg, "id" | "from" | "to">) => (v: number) =>
    setRoute(r => ({ ...r, legs: r.legs.map(l => l.id === id ? { ...l, [key]: v } : l) }));

  const setLegStr = (id: string, key: "from" | "to") => (v: string) =>
    setRoute(r => ({ ...r, legs: r.legs.map(l => l.id === id ? { ...l, [key]: v } : l) }));

  const addLeg = () => {
    const last = route.legs.at(-1);
    setRoute(r => ({ ...r, legs: [...r.legs, makeDefaultLeg(last?.to ?? "", "")] }));
  };

  const removeLeg = (id: string) => {
    if (route.legs.length <= 2) return;
    setRoute(r => ({ ...r, legs: r.legs.filter(l => l.id !== id) }));
  };

  const plan = useMemo(() => optimizeMultiLeg(route), [route]);
  const ppg  = useMemo(() => calcPpg(route.fuelTemperatureC), [route.fuelTemperatureC]);

  return (
    <div className="space-y-4">
      {/* Global settings */}
      <SectionCard title="Global Settings">
        <Grid3>
          <NumInput label="Start Shutdown Fuel (lbs)" value={route.startShutdownFuelLbs} onChange={setGlobal("startShutdownFuelLbs")} />
          <NumInput label="Carry Cost (%/hr)" value={route.carryCostPctPerHour} onChange={setGlobal("carryCostPctPerHour")} step={0.01} />
          <NumInput label="OAT / Fuel Temp (°C)" value={route.fuelTemperatureC} onChange={setGlobal("fuelTemperatureC")} step={1} />
        </Grid3>
        <Grid2>
          <NumInput label="Arrival Buffer (lbs)" value={route.arrivalBufferLbs} onChange={setGlobal("arrivalBufferLbs")} />
          <div className="flex flex-col justify-end pb-1">
            <span className="text-xs text-gray-400">Jet-A density</span>
            <span className="text-sm font-semibold text-gray-700">{n2(ppg)} lb/gal</span>
          </div>
        </Grid2>
      </SectionCard>

      {/* Leg cards */}
      {route.legs.map((leg, i) => {
        const paf   = getMultiPlannedArrival(route, i);
        const maxLF = getMultiMaxLF(route, i);
        const landingFuel = plan ? plan.landingFuelByStop[i] : null;
        const mlwWarn = landingFuel !== null && landingFuel > maxLF + 0.001;

        return (
          <div key={leg.id} className="bg-white rounded-2xl border border-gray-100 shadow-sm p-4 space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="bg-gray-900 text-white text-xs font-bold px-2 py-1 rounded-lg">LEG {i + 1}</span>
                {plan && (
                  <span className={`text-xs font-semibold px-2 py-1 rounded-lg ${mlwWarn ? "bg-red-50 text-red-600" : "bg-green-50 text-green-600"}`}>
                    {mlwWarn ? "⚠️ MLW exceeded" : `Order ${n0(plan.fuelOrderGalByStop[i])} gal`}
                  </span>
                )}
              </div>
              {route.legs.length > 2 && (
                <button onClick={() => removeLeg(leg.id)} className="text-xs text-red-400 hover:text-red-600 px-2 py-1">Remove</button>
              )}
            </div>

            {/* From / To */}
            <div className="grid grid-cols-2 gap-3">
              <TextInput label="From" value={leg.from} onChange={setLegStr(leg.id, "from")} placeholder="KABC" />
              <TextInput label="To" value={leg.to} onChange={setLegStr(leg.id, "to")} placeholder="KXYZ" />
            </div>

            {/* Required fields */}
            <Grid3>
              <NumInput label="Req. Start Fuel (lbs)" value={leg.requiredStartFuelLbs} onChange={setLeg(leg.id, "requiredStartFuelLbs")} />
              <NumInput label="Fuel to Dest (lbs)" value={leg.fuelToDestLbs} onChange={setLeg(leg.id, "fuelToDestLbs")} />
              <NumInput label="Flight Time (hrs)" value={leg.flightTimeHours} onChange={setLeg(leg.id, "flightTimeHours")} step={0.1} />
            </Grid3>

            <Grid2>
              <NumInput label="Departure Price ($/gal)" value={leg.departurePricePerGal} onChange={setLeg(leg.id, "departurePricePerGal")} step={0.01} />
              <div />
            </Grid2>

            {/* MLW / ZFW + fees (collapsible) */}
            <LegAdvanced leg={leg} i={i} setLeg={setLeg} paf={paf} maxLF={maxLF} />
          </div>
        );
      })}

      <button
        onClick={addLeg}
        className="w-full border-2 border-dashed border-gray-200 rounded-2xl py-3 text-sm font-semibold text-gray-400 hover:border-blue-400 hover:text-blue-500 transition"
      >
        + Add Leg
      </button>

      {/* Results */}
      <MultiLegResults plan={plan} route={route} />
    </div>
  );
}

function LegAdvanced({
  leg, i, setLeg, paf, maxLF,
}: {
  leg: MultiLeg;
  i: number;
  setLeg: (id: string, key: keyof Omit<MultiLeg, "id" | "from" | "to">) => (v: number) => void;
  paf: number;
  maxLF: number;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button onClick={() => setOpen(o => !o)} className="text-xs text-blue-500 hover:underline">
        {open ? "Hide MLW / fee settings ▲" : "MLW / fee settings ▼"}
      </button>
      {open && (
        <div className="mt-3 space-y-3">
          <Grid2>
            <NumInput label="MLW at Dest (lbs)" value={leg.maxLandingGrossWeightLbs} onChange={setLeg(leg.id, "maxLandingGrossWeightLbs")} />
            <NumInput label="ZFW at Dest (lbs)" value={leg.zeroFuelWeightLbs} onChange={setLeg(leg.id, "zeroFuelWeightLbs")} />
          </Grid2>
          <div className="text-xs text-gray-400">
            Planned arrival: {n0(paf)} lbs &nbsp;·&nbsp; Max landing fuel: {n0(maxLF)} lbs
          </div>
          <Grid2>
            <NumInput label="Waiver Min (gal)" value={leg.waiveFeesGallons} onChange={setLeg(leg.id, "waiveFeesGallons")} />
            <NumInput label="Fee if Not Waived ($)" value={leg.feesWaivedDollars} onChange={setLeg(leg.id, "feesWaivedDollars")} />
          </Grid2>
        </div>
      )}
    </div>
  );
}

function MultiLegResults({ plan, route }: { plan: MultiLegPlan | null; route: MultiRouteInputs }) {
  if (!plan) {
    return (
      <div className="bg-red-50 rounded-2xl border border-red-100 p-4 text-sm text-red-600">
        No feasible plan with current constraints — check MLW limits, required fuel, or reduce carry cost.
      </div>
    );
  }

  return (
    <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5 space-y-4">
      <div className="text-xs font-semibold text-gray-400 uppercase tracking-widest">Trip Results</div>

      {/* Per-stop summary */}
      <div className="space-y-3">
        {route.legs.map((leg, i) => {
          const maxLF = getMultiMaxLF(route, i);
          const landFuel = plan.landingFuelByStop[i];
          const mlwWarn = landFuel > maxLF + 0.001;
          const label = `${leg.from || `STOP ${i + 1}`} → ${leg.to || `STOP ${i + 2}`}`;

          return (
            <div key={leg.id} className="rounded-xl bg-gray-50 px-4 py-3 space-y-2">
              <div className="text-sm font-semibold text-gray-700">{label}</div>
              <div className="grid grid-cols-3 gap-2 text-center">
                <Pill label="Order" value={`${n0(plan.fuelOrderGalByStop[i])} gal`} />
                <Pill
                  label="Landing"
                  value={`${n0(landFuel)} lbs`}
                  warn={mlwWarn}
                  note={mlwWarn ? "⚠️ MLW" : `/ ${n0(maxLF)}`}
                />
                <Pill
                  label="Fee"
                  value={plan.feePaidByStop[i] > 0 ? `$${n0(plan.feePaidByStop[i])}` : "Waived"}
                  warn={plan.feePaidByStop[i] > 0}
                />
              </div>
            </div>
          );
        })}
      </div>

      {/* Totals */}
      <div className="border-t pt-4 space-y-0">
        <ResultRow label="Total fuel cost" value={dollar(plan.totalFuelCost)} />
        <ResultRow label="Total fees" value={dollar(plan.totalFees)} warn={plan.totalFees > 0} />
        <div className="flex justify-between pt-2 border-t">
          <span className="text-sm font-bold text-gray-800">Total trip cost</span>
          <span className="text-base font-black text-gray-900 tabular-nums">{dollar(plan.totalTripCost)}</span>
        </div>
      </div>
    </div>
  );
}

function Pill({ label, value, warn, note }: { label: string; value: string; warn?: boolean; note?: string }) {
  return (
    <div className={`rounded-lg px-2 py-2 ${warn ? "bg-red-50" : "bg-white"}`}>
      <div className="text-xs text-gray-400">{label}</div>
      <div className={`text-sm font-bold tabular-nums ${warn ? "text-red-600" : "text-gray-800"}`}>{value}</div>
      {note && <div className={`text-xs ${warn ? "text-red-400" : "text-gray-400"}`}>{note}</div>}
    </div>
  );
}

// ── Root component ────────────────────────────────────────────────────────────

export default function TankerPlanner() {
  const [mode, setMode] = useState<"single" | "multi">("single");

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6">
      {/* Mode toggle */}
      <div className="flex gap-2">
        {(["single", "multi"] as const).map(m => (
          <button
            key={m}
            onClick={() => setMode(m)}
            className={`px-5 py-2 rounded-xl text-sm font-semibold border transition ${
              mode === m
                ? "bg-gray-900 text-white border-gray-900"
                : "bg-white text-gray-600 border-gray-200 hover:border-gray-400"
            }`}
          >
            {m === "single" ? "Single Leg" : "Multi Leg"}
          </button>
        ))}
      </div>

      {mode === "single" ? <SingleLegPlanner /> : <MultiLegPlanner />}
    </div>
  );
}
