// model.ts — Tanker planner math, ported from Swift
// Single-leg uses the aircraft carry-burn curve (non-linear, 2hr baseline scaled by flight time).
// Multi-leg uses a simpler linear carry-cost percentage model with DP optimization.

// ============================================================
// Single-leg model
// ============================================================

export type AircraftType = "CE-750" | "CL-30";
export const AIRCRAFT_TYPES: AircraftType[] = ["CE-750", "CL-30"];

interface BurnPt { fuelLbs: number; burnLbs: number; }

const CURVES: Record<AircraftType, BurnPt[]> = {
  "CE-750": [
    { fuelLbs: 1000, burnLbs: 34 },  { fuelLbs: 2000, burnLbs: 68 },
    { fuelLbs: 3000, burnLbs: 102 }, { fuelLbs: 4000, burnLbs: 268 },
    { fuelLbs: 5000, burnLbs: 508 }, { fuelLbs: 6000, burnLbs: 762 },
    { fuelLbs: 7000, burnLbs: 1143 },{ fuelLbs: 8000, burnLbs: 1715 },
  ],
  "CL-30": [
    { fuelLbs: 1000, burnLbs: 51 },  { fuelLbs: 2000, burnLbs: 105 },
    { fuelLbs: 3000, burnLbs: 160 }, { fuelLbs: 4000, burnLbs: 222 },
    { fuelLbs: 5000, burnLbs: 305 }, { fuelLbs: 6000, burnLbs: 393 },
    { fuelLbs: 7000, burnLbs: 493 }, { fuelLbs: 8000, burnLbs: 602 },
  ],
};

function lerpCurve(pts: BurnPt[], x: number): number {
  if (!pts.length) return 0;
  if (x <= pts[0].fuelLbs) return pts[0].burnLbs * (x / pts[0].fuelLbs);
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    if (x <= b.fuelLbs) {
      const span = b.fuelLbs - a.fuelLbs;
      if (!span) return a.burnLbs;
      return a.burnLbs + ((x - a.fuelLbs) / span) * (b.burnLbs - a.burnLbs);
    }
  }
  // Extrapolate beyond last point
  const a = pts[pts.length - 2], b = pts[pts.length - 1];
  const span = b.fuelLbs - a.fuelLbs;
  if (!span) return b.burnLbs;
  return b.burnLbs + ((b.burnLbs - a.burnLbs) / span) * (x - b.fuelLbs);
}

function calcAddedBurn(ac: AircraftType, extraLbs: number, hrs: number): number {
  if (extraLbs <= 0 || hrs <= 0) return 0;
  return Math.round(lerpCurve(CURVES[ac], extraLbs) * (hrs / 2.0));
}

export function calcPpg(tempC: number): number {
  return Math.max(6.4, Math.min(7.1, 6.7 * (1 + -0.0008 * (tempC - 15))));
}

export interface TankerInputs {
  aircraftType: AircraftType;
  lastLegShutdownFuelLbs: number;
  startFuelThisLeg: number;
  fuelToDestination: number;
  flightTimeHours: number;
  maxLandingGrossWeight: number;
  zeroFuelWeight: number;
  nextLegStartFuel: number;
  fuelPurchaseToWaiveFeesGallons: number;
  feesWaivedDollars: number;
  departureFuelPrice: number;
  nextLegFuelPrice: number;
  fuelTemperatureC: number;
  arrivalBufferLbs: number;
  nextLegBufferLbs: number;
}

export const DEFAULT_INPUTS: TankerInputs = {
  aircraftType: "CE-750",
  lastLegShutdownFuelLbs: 2500,
  startFuelThisLeg: 7000,
  fuelToDestination: 2500,
  flightTimeHours: 2.0,
  maxLandingGrossWeight: 33750,
  zeroFuelWeight: 25500,
  nextLegStartFuel: 6500,
  fuelPurchaseToWaiveFeesGallons: 300,
  feesWaivedDollars: 750,
  departureFuelPrice: 6.25,
  nextLegFuelPrice: 8.75,
  fuelTemperatureC: 15.0,
  arrivalBufferLbs: 300,
  nextLegBufferLbs: 200,
};

export function getPlannedArrival(inp: TankerInputs): number {
  return inp.startFuelThisLeg - inp.fuelToDestination - Math.max(0, inp.arrivalBufferLbs);
}

export function getMaxLandingFuel(inp: TankerInputs): number {
  return inp.maxLandingGrossWeight - inp.zeroFuelWeight;
}

function tankerInFrom(ac: AircraftType, out: number, hrs: number): { tin: number; burn: number } {
  const burn = calcAddedBurn(ac, Math.max(0, out), hrs);
  return { tin: Math.max(0, out - burn), burn };
}

function reqPurchaseGal(inp: TankerInputs, tankerIn: number, ppg: number): number {
  const have = getPlannedArrival(inp) + tankerIn;
  const need = inp.nextLegStartFuel + Math.max(0, inp.nextLegBufferLbs);
  return Math.max(0, need - have) / ppg;
}

function calcDestCost(inp: TankerInputs, gal: number): { total: number; feePaid: number } {
  const w = Math.max(0, inp.fuelPurchaseToWaiveFeesGallons);
  const fee = Math.max(0, inp.feesWaivedDollars);
  if (!w || !fee || gal >= w) return { total: gal * inp.nextLegFuelPrice, feePaid: 0 };
  const withFee = { total: gal * inp.nextLegFuelPrice + fee, feePaid: fee };
  const topUp   = { total: w * inp.nextLegFuelPrice, feePaid: 0 };
  return topUp.total < withFee.total ? topUp : withFee;
}

function maxTankerOut(inp: TankerInputs, step = 50): number {
  const maxLF = getMaxLandingFuel(inp);
  const paf   = getPlannedArrival(inp);
  if (maxLF <= 0) return 0;
  const upper = Math.max(0, maxLF - paf);
  let best = 0;
  for (let x = 0; x <= upper + 0.001; x += step) {
    const { tin } = tankerInFrom(inp.aircraftType, x, inp.flightTimeHours);
    if (paf + tin <= maxLF + 0.001) best = x; else break;
  }
  return best;
}

export function getOptimumTankerOut(inp: TankerInputs): number {
  const ppg = calcPpg(inp.fuelTemperatureC);
  if (inp.nextLegFuelPrice <= inp.departureFuelPrice) return 0;
  const maxOut = maxTankerOut(inp, 25);
  if (maxOut <= 0) return 0;
  const baseGal  = reqPurchaseGal(inp, 0, ppg);
  const baseCost = calcDestCost(inp, baseGal).total;
  const maxLF    = getMaxLandingFuel(inp);
  const paf      = getPlannedArrival(inp);
  let bestOut = 0, bestSav = 0;
  for (let out = 0; out <= maxOut + 0.001; out += 100) {
    const { tin } = tankerInFrom(inp.aircraftType, out, inp.flightTimeHours);
    if (paf + tin > maxLF + 0.001) continue;
    const sav = baseCost
      - calcDestCost(inp, reqPurchaseGal(inp, tin, ppg)).total
      - (out / ppg) * inp.departureFuelPrice;
    if (sav > bestSav) { bestSav = sav; bestOut = out; }
  }
  return Math.round(bestOut);
}

export function getMaxTankerOut85(inp: TankerInputs): number {
  return Math.round(0.85 * maxTankerOut(inp));
}

export interface TankerResult {
  tankerOut: number;
  tankerIn: number;
  addedBurn: number;
  netSavings: number;
  tankerSavings: number;
  carryCost: number;
  feeImpact: number;
  losesFeeWaiver: boolean;
  isManual: boolean;
  exceedsMLW: boolean;
  landingFuel: number;
  maxLF: number;
  fuelToOrderLbs: number;
  fuelToOrderGal: number;
  ppg: number;
  plannedArrival: number;
}

export function computeResult(inp: TankerInputs, manualOut?: number): TankerResult {
  const ppg      = calcPpg(inp.fuelTemperatureC);
  const tankerOut = Math.max(0, manualOut ?? getOptimumTankerOut(inp));
  const { tin: tankerIn, burn: addedBurn } = tankerInFrom(inp.aircraftType, tankerOut, inp.flightTimeHours);
  const paf        = getPlannedArrival(inp);
  const maxLF      = getMaxLandingFuel(inp);
  const landingFuel = paf + tankerIn;
  const baseGal    = reqPurchaseGal(inp, 0, ppg);
  const base       = calcDestCost(inp, baseGal);
  const dGal       = reqPurchaseGal(inp, tankerIn, ppg);
  const dest       = calcDestCost(inp, dGal);
  const depCost    = (tankerOut / ppg) * inp.departureFuelPrice;
  const netSavings = base.total - (depCost + dest.total);
  const costDiff   = inp.nextLegFuelPrice - inp.departureFuelPrice;
  const fuelToOrderLbs = Math.max(0, inp.startFuelThisLeg + tankerOut - inp.lastLegShutdownFuelLbs);
  return {
    tankerOut, tankerIn, addedBurn, netSavings,
    tankerSavings: Math.min(tankerIn / ppg, baseGal) * costDiff,
    carryCost: (addedBurn / ppg) * inp.departureFuelPrice,
    feeImpact: base.feePaid - dest.feePaid,
    losesFeeWaiver: base.feePaid === 0 && dest.feePaid > 0,
    isManual: manualOut !== undefined,
    exceedsMLW: landingFuel > maxLF + 0.001,
    landingFuel, maxLF,
    fuelToOrderLbs,
    fuelToOrderGal: fuelToOrderLbs / ppg,
    ppg, plannedArrival: paf,
  };
}

// ============================================================
// Multi-leg model
// ============================================================

export interface MultiLeg {
  id: string;
  from: string;
  to: string;
  requiredStartFuelLbs: number;
  fuelToDestLbs: number;
  flightTimeHours: number;
  maxLandingGrossWeightLbs: number;
  zeroFuelWeightLbs: number;
  departurePricePerGal: number;
  waiveFeesGallons: number;
  feesWaivedDollars: number;
}

export function makeDefaultLeg(from = "", to = ""): MultiLeg {
  return {
    id: Math.random().toString(36).slice(2),
    from, to,
    requiredStartFuelLbs: 4000,
    fuelToDestLbs: 1200,
    flightTimeHours: 1.0,
    maxLandingGrossWeightLbs: 31800,
    zeroFuelWeightLbs: 24185,
    departurePricePerGal: 4.0,
    waiveFeesGallons: 0,
    feesWaivedDollars: 0,
  };
}

export interface MultiRouteInputs {
  startShutdownFuelLbs: number;
  carryCostPctPerHour: number;
  fuelTemperatureC: number;
  arrivalBufferLbs: number;
  legs: MultiLeg[];
}

export const DEFAULT_MULTI: MultiRouteInputs = {
  startShutdownFuelLbs: 2500,
  carryCostPctPerHour: 3.94,
  fuelTemperatureC: 15.0,
  arrivalBufferLbs: 300,
  legs: [makeDefaultLeg("DEP", "STOP1"), makeDefaultLeg("STOP1", "DEST")],
};

export function getMultiPlannedArrival(r: MultiRouteInputs, i: number): number {
  const l = r.legs[i];
  return l.requiredStartFuelLbs - l.fuelToDestLbs - r.arrivalBufferLbs;
}

export function getMultiMaxLF(r: MultiRouteInputs, i: number): number {
  const l = r.legs[i];
  return l.maxLandingGrossWeightLbs - l.zeroFuelWeightLbs;
}

export interface MultiLegPlan {
  tankerOutByStop: number[];
  tankerInByStop: number[];
  fuelOrderLbsByStop: number[];
  fuelOrderGalByStop: number[];
  landingFuelByStop: number[];
  feePaidByStop: number[];
  totalFuelCost: number;
  totalFees: number;
  totalTripCost: number;
}

export function optimizeMultiLeg(route: MultiRouteInputs, stepLbs = 100): MultiLegPlan | null {
  const legs = route.legs;
  const n = legs.length;
  if (!n) return null;

  const ppg  = calcPpg(route.fuelTemperatureC);
  const snap = (x: number) => Math.round(x / stepLbs) * stepLbs;

  const maxIns  = legs.map((_, i) => Math.max(0, getMultiMaxLF(route, i) - getMultiPlannedArrival(route, i)));
  const cfs     = legs.map(l => (route.carryCostPctPerHour / 100) * l.flightTimeHours);
  const maxOuts = legs.map((_, i) => snap(maxIns[i] / Math.max(1e-6, 1 - cfs[i])));
  const overallMax = Math.max(...maxOuts, 0);
  const maxJ = Math.round(overallMax / stepLbs) + 1;

  const INF = 1e15;
  const dp         = Array.from({ length: n + 1 }, () => new Float64Array(maxJ + 1).fill(INF));
  const outChoice  = Array.from({ length: n },     () => new Int32Array(maxJ + 1).fill(-1));

  // Base case: no cost after last leg regardless of leftover
  for (let j = 0; j <= maxJ; j++) dp[n][j] = 0;

  for (let i = n - 1; i >= 0; i--) {
    const leg   = legs[i];
    const maxOJ = Math.min(maxJ, Math.round(maxOuts[i] / stepLbs));
    const cf    = cfs[i];
    const maxIn = maxIns[i];

    for (let aj = 0; aj <= maxJ; aj++) {
      const arrE = aj * stepLbs;
      if (arrE > maxOuts[i] + 0.001) continue;

      let best = INF, bestOJ = -1;
      for (let oj = aj; oj <= maxOJ; oj++) {   // can't dump fuel: outExtra >= arrExtra
        const outE = oj * stepLbs;
        const inE  = outE * (1 - cf);
        if (inE > maxIn + 0.001) continue;

        const nextAJ = Math.min(maxJ, Math.round(snap(inE) / stepLbs));
        const fut    = dp[i + 1][nextAJ];
        if (fut >= INF) continue;

        const shutdown = i === 0
          ? route.startShutdownFuelLbs
          : getMultiPlannedArrival(route, i - 1) + arrE;
        const oLbs = Math.max(0, leg.requiredStartFuelLbs + outE - shutdown);
        const oGal = oLbs / ppg;
        const fc   = oGal * leg.departurePricePerGal;
        const fee  = leg.waiveFeesGallons > 0 && oGal + 0.001 < leg.waiveFeesGallons
          ? leg.feesWaivedDollars : 0;
        const t = fc + fee + fut;
        if (t < best) { best = t; bestOJ = oj; }
      }
      if (bestOJ >= 0) { dp[i][aj] = best; outChoice[i][aj] = bestOJ; }
    }
  }

  if (dp[0][0] >= INF) return null;

  const tOuts: number[] = [], tIns: number[] = [];
  const oLbsArr: number[] = [], oGalArr: number[] = [];
  const landing: number[] = [], feesArr: number[] = [];
  let totalFC = 0, totalFees = 0;
  let aj = 0;

  for (let i = 0; i < n; i++) {
    const leg  = legs[i];
    const oj   = outChoice[i][aj];
    if (oj < 0) return null;
    const arrE = aj * stepLbs;
    const outE = oj * stepLbs;
    const inE  = outE * (1 - cfs[i]);

    tOuts.push(outE); tIns.push(inE);

    const shutdown = i === 0
      ? route.startShutdownFuelLbs
      : getMultiPlannedArrival(route, i - 1) + arrE;
    const oLbs = Math.max(0, leg.requiredStartFuelLbs + outE - shutdown);
    const oGal = oLbs / ppg;
    oLbsArr.push(oLbs); oGalArr.push(oGal);

    const fc  = oGal * leg.departurePricePerGal;
    totalFC  += fc;
    const fee = leg.waiveFeesGallons > 0 && oGal + 0.001 < leg.waiveFeesGallons
      ? leg.feesWaivedDollars : 0;
    feesArr.push(fee); totalFees += fee;
    landing.push(getMultiPlannedArrival(route, i) + inE);

    aj = Math.min(maxJ, Math.round(snap(inE) / stepLbs));
  }

  return {
    tankerOutByStop: tOuts, tankerInByStop: tIns,
    fuelOrderLbsByStop: oLbsArr, fuelOrderGalByStop: oGalArr,
    landingFuelByStop: landing, feePaidByStop: feesArr,
    totalFuelCost: totalFC, totalFees, totalTripCost: totalFC + totalFees,
  };
}
