/**
 * Shared duty-time calculation logic.
 *
 * Extracted from DutyTracker.tsx so it can be used both client-side (Duty
 * Tracker component) and server-side (duty-monitor cron job).
 *
 * NO React imports — pure TypeScript functions only.
 */

import type { Flight } from "@/lib/opsApi";

/* ── Constants ──────────────────────────────────────── */

// Part 135.267(b)(2): 10h limit for two-pilot crew in any 24 consecutive hours
export const FLIGHT_TIME_RED_MIN = 600; // 10 hours — hard limit
export const FLIGHT_TIME_YELLOW_MIN = 540; // 9 hours — caution (within 1hr of limit)
export const REST_RED_HOURS = 10; // minimum required rest
export const REST_YELLOW_HOURS = 11; // within 1hr of minimum
export const MAX_LEG_DURATION_MIN = 8 * 60; // cap any single leg at 8h
export const MIN_REST_GAP_MS = 8 * 60 * 60 * 1000; // 8h minimum to split duty periods
export const LEAD_TIME_MIN = 60; // duty starts 60min before first leg
export const POST_TIME_MIN = 30; // duty ends 30min after last leg

// Only include revenue/charter and positioning legs for duty tracking
export const DUTY_FLIGHT_TYPES = new Set(["revenue", "owner", "positioning", "ferry", "charter"]);

/* ── Types ──────────────────────────────────────────── */

export type LegInterval = {
  departure_icao: string | null;
  arrival_icao: string | null;
  startMs: number;
  endMs: number;
  durationMin: number;
  source: "actual" | "fa-estimate" | "scheduled";
  depIso: string;
  arrIso: string;
  flightType: string | null;
};

export type DutyPeriod = {
  label: string;
  dateLabel: string;
  legs: LegInterval[];
  dutyOnMs: number;
  dutyOffMs: number;
  dutyMinutes: number;
  flightMinutes: number;
};

export type RestPeriod = {
  startMs: number;
  stopMs: number;
  minutes: number;
};

/** Minimal FA flight type — satisfied by both FlightInfoMap and FlightInfo */
export type FaFlight = {
  tail: string;
  fa_flight_id?: string;
  origin_icao: string | null;
  destination_icao: string | null;
  status?: string | null;
  departure_time: string | null;
  arrival_time: string | null;
  actual_departure?: string | null;
  actual_arrival?: string | null;
};

export type TailDutyResult = {
  tail: string;
  dutyPeriods: DutyPeriod[];
  restPeriods: RestPeriod[];
  maxRolling24hrMin: number;
  hasFlightsTomorrow: boolean;
  breachLegKey: string | null;
  suggestion: string | null;
  // EDCT-adjusted variant (only present when tail has active EDCTs)
  edctMaxRolling24hrMin: number | null;
  edctRestPeriods: RestPeriod[] | null;
};

/* ── Formatting helpers ─────────────────────────────── */

export function fmtDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return `${h}h ${m.toString().padStart(2, "0")}m`;
}

export function fmtZulu(ms: number): string {
  const d = new Date(ms);
  const hh = d.getUTCHours().toString().padStart(2, "0");
  const mm = d.getUTCMinutes().toString().padStart(2, "0");
  return `${hh}${mm}Z`;
}

export function fmtDateShort(ms: number): string {
  const d = new Date(ms);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

/* ── EDCT helper ────────────────────────────────────── */

/** Find the active (unacknowledged) EDCT alert for a flight */
export function getActiveEdct(f: Flight): { edct_time: string } | null {
  const now = Date.now();
  return f.alerts?.find(a => {
    if (a.alert_type !== "EDCT" || !a.edct_time || a.acknowledged_at) return false;
    if (new Date(a.edct_time).getTime() < now - 2 * 60 * 60 * 1000) return false;
    return true;
  }) as { edct_time: string } | null ?? null;
}

/* ── Core calculation functions ─────────────────────── */

/**
 * Find the max rolling 24hr flight time. By default only counts windows
 * containing at least one future leg. Pass `includeAllWindows: true` for
 * confirmation checks where all legs are in the past.
 */
export function findMaxRolling24(
  legs: LegInterval[],
  opts?: { includeAllWindows?: boolean },
): number {
  if (legs.length === 0) return 0;
  const WINDOW_MS = 24 * 60 * 60 * 1000;
  const nowMs = Date.now();
  const includeAll = opts?.includeAllWindows ?? false;
  const checkPoints = new Set<number>();
  for (const leg of legs) {
    checkPoints.add(leg.startMs);
    checkPoints.add(leg.endMs);
    checkPoints.add(leg.startMs + WINDOW_MS);
    checkPoints.add(leg.endMs + WINDOW_MS);
  }
  let maxTotalMs = 0;
  for (const windowEnd of checkPoints) {
    const windowStart = windowEnd - WINDOW_MS;
    if (!includeAll) {
      const hasFutureLeg = legs.some(l => l.endMs >= nowMs && l.startMs < windowEnd && l.endMs > windowStart);
      if (!hasFutureLeg) continue;
    }
    let totalMs = 0;
    for (const leg of legs) {
      const os = Math.max(leg.startMs, windowStart);
      const oe = Math.min(leg.endMs, windowEnd);
      if (oe > os) totalMs += oe - os;
    }
    if (totalMs > maxTotalMs) maxTotalMs = totalMs;
  }
  return maxTotalMs / 60_000;
}

/** Get yesterday 0000Z to end of tomorrow 2359Z */
export function getThreeDayWindowMs(): { startMs: number; endMs: number } {
  const now = new Date();
  const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return {
    startMs: todayUtc - 24 * 60 * 60 * 1000,
    endMs: todayUtc + 2 * 24 * 60 * 60 * 1000,
  };
}

/** Group sorted legs into duty periods (split at gaps >= MIN_REST_GAP_MS) */
export function groupIntoDutyPeriods(legs: LegInterval[]): DutyPeriod[] {
  if (legs.length === 0) return [];
  const dps: DutyPeriod[] = [];
  let currentLegs: LegInterval[] = [legs[0]];

  for (let i = 1; i < legs.length; i++) {
    const gap = legs[i].startMs - legs[i - 1].endMs;
    if (gap >= MIN_REST_GAP_MS) {
      dps.push(buildDP(currentLegs, dps.length + 1));
      currentLegs = [legs[i]];
    } else {
      currentLegs.push(legs[i]);
    }
  }
  dps.push(buildDP(currentLegs, dps.length + 1));
  return dps;
}

export function buildDP(legs: LegInterval[], num: number): DutyPeriod {
  const firstDep = legs[0].startMs;
  const lastArr = legs[legs.length - 1].endMs;
  const dutyOnMs = firstDep - LEAD_TIME_MIN * 60_000;
  const dutyOffMs = lastArr + POST_TIME_MIN * 60_000;
  return {
    label: `DP ${num}`,
    dateLabel: fmtDateShort(firstDep),
    legs,
    dutyOnMs,
    dutyOffMs,
    dutyMinutes: (dutyOffMs - dutyOnMs) / 60_000,
    flightMinutes: legs.reduce((s, l) => s + l.durationMin, 0),
  };
}

/** Relabel DPs: use date as label, add "- DP N" suffix when multiple DPs share a date */
export function relabelDPs(dps: DutyPeriod[]): void {
  const countByDate = new Map<string, number>();
  for (const dp of dps) {
    countByDate.set(dp.dateLabel, (countByDate.get(dp.dateLabel) ?? 0) + 1);
  }
  const seenByDate = new Map<string, number>();
  for (const dp of dps) {
    const count = countByDate.get(dp.dateLabel) ?? 1;
    if (count > 1) {
      const idx = (seenByDate.get(dp.dateLabel) ?? 0) + 1;
      seenByDate.set(dp.dateLabel, idx);
      dp.label = `${dp.dateLabel} - DP ${idx}`;
    } else {
      dp.label = dp.dateLabel;
    }
  }
}

export function buildRestPeriods(dps: DutyPeriod[]): RestPeriod[] {
  const rests: RestPeriod[] = [];
  for (let i = 0; i < dps.length - 1; i++) {
    const startMs = dps[i].dutyOffMs;
    const stopMs = dps[i + 1].dutyOnMs;
    rests.push({ startMs, stopMs, minutes: Math.max(0, (stopMs - startMs) / 60_000) });
  }
  return rests;
}

/** Find the leg that pushes the rolling 24hr total past caution (9h).
 *  Returns "dpIdx-legIdx" key or null. */
export function findBreachLeg(dps: DutyPeriod[]): string | null {
  const WINDOW_MS = 24 * 60 * 60 * 1000;
  const nowMs = Date.now();
  const allLegs: { dpIdx: number; legIdx: number; leg: LegInterval }[] = [];
  for (let d = 0; d < dps.length; d++) {
    for (let l = 0; l < dps[d].legs.length; l++) {
      allLegs.push({ dpIdx: d, legIdx: l, leg: dps[d].legs[l] });
    }
  }
  allLegs.sort((a, b) => a.leg.startMs - b.leg.startMs);

  for (let i = 0; i < allLegs.length; i++) {
    if (allLegs[i].leg.startMs < nowMs) continue;
    const windowEnd = allLegs[i].leg.endMs;
    const windowStart = windowEnd - WINDOW_MS;
    let totalMin = 0;
    for (let j = 0; j <= i; j++) {
      const os = Math.max(allLegs[j].leg.startMs, windowStart);
      const oe = Math.min(allLegs[j].leg.endMs, windowEnd);
      if (oe > os) totalMin += (oe - os) / 60_000;
    }
    if (totalMin >= FLIGHT_TIME_YELLOW_MIN) {
      return `${allLegs[i].dpIdx}-${allLegs[i].legIdx}`;
    }
  }
  return null;
}

/** Compute a fix suggestion for the breach leg. */
export function computeSuggestion(dps: DutyPeriod[], breachKey: string | null): string | null {
  if (!breachKey) return null;
  const [dpIdxStr, legIdxStr] = breachKey.split("-");
  const dpIdx = parseInt(dpIdxStr);
  const legIdx = parseInt(legIdxStr);
  const dp = dps[dpIdx];
  if (!dp) return null;
  const breachLeg = dp.legs[legIdx];
  if (!breachLeg) return null;

  const route = `${breachLeg.departure_icao ?? "?"}-${breachLeg.arrival_icao ?? "?"}`;

  const priorLegs: LegInterval[] = [];
  for (let d = 0; d < dps.length; d++) {
    for (let l = 0; l < dps[d].legs.length; l++) {
      if (d === dpIdx && l === legIdx) break;
      priorLegs.push(dps[d].legs[l]);
    }
    if (d === dpIdx) break;
  }

  const WINDOW_MS = 24 * 60 * 60 * 1000;
  const legDurMs = breachLeg.durationMin * 60_000;
  const STEP = 5 * 60_000;
  const MAX_SHIFT = 12 * 60 * 60_000;

  for (let shift = STEP; shift <= MAX_SHIFT; shift += STEP) {
    const newStart = breachLeg.startMs + shift;
    const newEnd = newStart + legDurMs;
    const windowStart = newEnd - WINDOW_MS;

    let totalMin = 0;
    for (const leg of priorLegs) {
      const os = Math.max(leg.startMs, windowStart);
      const oe = Math.min(leg.endMs, newEnd);
      if (oe > os) totalMin += (oe - os) / 60_000;
    }
    totalMin += breachLeg.durationMin;

    if (totalMin < FLIGHT_TIME_RED_MIN) {
      const d = new Date(newStart);
      const hh = d.getUTCHours().toString().padStart(2, "0");
      const mm = d.getUTCMinutes().toString().padStart(2, "0");
      return `Slide ${route} to depart ${hh}${mm}Z or later`;
    }
  }

  return `Consider removing or shortening ${route}`;
}

/* ── High-level orchestrators ───────────────────────── */

/** Group a flat FA flights array into a Map keyed by tail number. */
export function groupFaByTail<T extends FaFlight>(faFlights: T[]): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const fi of faFlights) {
    if (!map.has(fi.tail)) map.set(fi.tail, []);
    map.get(fi.tail)!.push(fi);
  }
  return map;
}

/**
 * Build LegInterval arrays per tail from ICS flights + FA data.
 * Extracted from DutyTracker.tsx intervalsByTail useMemo.
 */
export function buildLegIntervals(
  flights: Flight[],
  faByTail: Map<string, FaFlight[]>,
): Map<string, LegInterval[]> {
  const result = new Map<string, LegInterval[]>();
  const now = Date.now();
  const { startMs: windowStart, endMs: windowEnd } = getThreeDayWindowMs();

  for (const f of flights) {
    if (!f.tail_number) continue;
    if (f.id.startsWith("edct-orphan-")) continue;
    const ft = (f.flight_type ?? "").toLowerCase();
    if (ft && !DUTY_FLIGHT_TYPES.has(ft)) continue;

    const tailFaFlights = faByTail.get(f.tail_number) ?? [];
    let fi: FaFlight | undefined;
    const schedMs = new Date(f.scheduled_departure).getTime();

    // 1. Direct ID match
    if (f.fa_flight_id) {
      fi = tailFaFlights.find(fa => fa.fa_flight_id === f.fa_flight_id);
    }

    // 2. Exact route match within 6h
    if (!fi) {
      fi = tailFaFlights.find((fa) => {
        if (fa.origin_icao !== f.departure_icao || fa.destination_icao !== f.arrival_icao) return false;
        const faDep = fa.departure_time ?? fa.actual_departure;
        if (!faDep) return true;
        return Math.abs(new Date(faDep).getTime() - schedMs) < 6 * 60 * 60 * 1000;
      });
    }

    // 3. Closest departure within 2h
    if (!fi && tailFaFlights.length > 0) {
      let bestDiff = Infinity;
      for (const fa of tailFaFlights) {
        const faDep = fa.departure_time ?? fa.actual_departure;
        if (!faDep) continue;
        const diff = Math.abs(new Date(faDep).getTime() - schedMs);
        if (diff < bestDiff && diff < 2 * 60 * 60 * 1000) {
          bestDiff = diff;
          fi = fa;
        }
      }
    }

    const actualDep = fi?.actual_departure ?? null;
    const fiDestMatch = fi && fi.destination_icao === f.arrival_icao;
    const actualArr = fiDestMatch ? (fi?.actual_arrival ?? null) : null;
    const estimatedArr = fiDestMatch ? (fi?.arrival_time ?? null) : null;
    const faDep = fi?.departure_time ?? null;

    const depIso = actualDep ?? faDep ?? f.scheduled_departure;
    const depMs = new Date(depIso).getTime();

    let source: "actual" | "fa-estimate" | "scheduled";
    let endMs: number;

    if (actualArr) {
      source = "actual";
      endMs = new Date(actualArr).getTime();
    } else if (actualDep && !actualArr) {
      source = estimatedArr ? "fa-estimate" : "actual";
      endMs = estimatedArr ? new Date(estimatedArr).getTime() : now;
    } else if (faDep && estimatedArr) {
      source = "fa-estimate";
      endMs = new Date(estimatedArr).getTime();
    } else if (estimatedArr) {
      source = "fa-estimate";
      endMs = new Date(estimatedArr).getTime();
    } else {
      source = "scheduled";
      endMs = f.scheduled_arrival ? new Date(f.scheduled_arrival).getTime() : depMs;
    }

    let durationMin = (endMs - depMs) / 60_000;

    // Sanity check: fall back to ICS if FA duration is wildly long
    if (source !== "scheduled") {
      if (f.scheduled_arrival) {
        const schedDur = (new Date(f.scheduled_arrival).getTime() - new Date(f.scheduled_departure).getTime()) / 60_000;
        if (schedDur > 0 && durationMin > Math.max(schedDur * 1.5, schedDur + 90)) {
          source = "scheduled";
          endMs = new Date(f.scheduled_arrival).getTime();
          durationMin = (endMs - depMs) / 60_000;
        }
      } else if (durationMin > 360) {
        source = "scheduled";
        durationMin = 360;
        endMs = depMs + durationMin * 60_000;
      }
    }

    if (durationMin < 0) durationMin = 0;
    if (source === "scheduled" && durationMin > 360) {
      durationMin = 180;
    }
    if (durationMin > MAX_LEG_DURATION_MIN) durationMin = MAX_LEG_DURATION_MIN;
    endMs = depMs + durationMin * 60_000;

    if (durationMin <= 0) continue;
    if (endMs < windowStart || depMs > windowEnd) continue;

    const arrIso = new Date(endMs).toISOString();

    if (!result.has(f.tail_number)) result.set(f.tail_number, []);
    result.get(f.tail_number)!.push({
      departure_icao: f.departure_icao,
      arrival_icao: f.arrival_icao,
      startMs: depMs,
      endMs,
      durationMin,
      source,
      depIso,
      arrIso,
      flightType: f.flight_type,
    });
  }

  // Sort, dedup, fix overlaps per tail
  for (const [tail, legs] of result) {
    legs.sort((a, b) => a.startMs - b.startMs);

    const deduped: LegInterval[] = [];
    for (const leg of legs) {
      const prev = deduped[deduped.length - 1];
      const sameRoute = prev && prev.departure_icao === leg.departure_icao && prev.arrival_icao === leg.arrival_icao;
      if (sameRoute && Math.abs(prev.startMs - leg.startMs) < 5 * 60_000) {
        continue;
      }
      if (leg.source === "scheduled" && deduped.some((d) => d.departure_icao === leg.departure_icao && d.arrival_icao === leg.arrival_icao && (d.source === "actual" || d.source === "fa-estimate"))) {
        continue;
      }
      if (leg.source === "actual" || leg.source === "fa-estimate") {
        const schedIdx = deduped.findIndex((d) => d.departure_icao === leg.departure_icao && d.arrival_icao === leg.arrival_icao && d.source === "scheduled");
        if (schedIdx !== -1) {
          deduped.splice(schedIdx, 1);
        }
      }
      deduped.push(leg);
    }

    deduped.sort((a, b) => a.startMs - b.startMs);
    for (let i = 1; i < deduped.length; i++) {
      const prev = deduped[i - 1];
      if (deduped[i].startMs < prev.endMs) {
        deduped[i].startMs = prev.endMs;
        deduped[i].depIso = new Date(prev.endMs).toISOString();
        deduped[i].durationMin = Math.max(0, (deduped[i].endMs - deduped[i].startMs) / 60_000);
        if (deduped[i].durationMin > MAX_LEG_DURATION_MIN) {
          deduped[i].durationMin = MAX_LEG_DURATION_MIN;
          deduped[i].endMs = deduped[i].startMs + MAX_LEG_DURATION_MIN * 60_000;
        }
      }
    }
    result.set(tail, deduped);
  }
  return result;
}

/**
 * Compute duty data for a single tail.
 * Extracted from DutyTracker.tsx tailData useMemo (per-tail body).
 */
export function computeTailDuty(
  tail: string,
  legs: LegInterval[],
  tailFlights: Flight[],
): TailDutyResult {
  const validLegs = legs.filter((l) => l.durationMin > 0);
  const dutyPeriods = groupIntoDutyPeriods(validLegs);
  relabelDPs(dutyPeriods);
  const restPeriods = buildRestPeriods(dutyPeriods);
  const maxRolling24hrMin = findMaxRolling24(validLegs);

  const now = new Date();
  const tomorrowUtcStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) + 24 * 60 * 60 * 1000;
  const tomorrowUtcEnd = tomorrowUtcStart + 24 * 60 * 60 * 1000;
  const hasFlightsTomorrow = validLegs.some((l) => l.startMs >= tomorrowUtcStart && l.startMs < tomorrowUtcEnd);
  const breachLegKey = maxRolling24hrMin >= FLIGHT_TIME_YELLOW_MIN ? findBreachLeg(dutyPeriods) : null;
  const suggestion = maxRolling24hrMin >= FLIGHT_TIME_YELLOW_MIN ? computeSuggestion(dutyPeriods, breachLegKey) : null;

  // EDCT-adjusted variant
  let edctMaxRolling24hrMin: number | null = null;
  let edctRestPeriods: RestPeriod[] | null = null;
  const hasEdct = tailFlights.some(f => getActiveEdct(f) != null);
  if (hasEdct) {
    const edctLegs = validLegs.map(leg => ({ ...leg }));
    edctLegs.sort((a, b) => a.startMs - b.startMs);
    for (const leg of edctLegs) {
      if (leg.source === "actual" && leg.startMs < Date.now()) continue;
      const matchedFlight = tailFlights.find(f =>
        f.departure_icao === leg.departure_icao &&
        f.arrival_icao === leg.arrival_icao &&
        Math.abs(new Date(f.scheduled_departure).getTime() - leg.startMs) < 2 * 60 * 60 * 1000
      );
      if (!matchedFlight) continue;
      const edct = getActiveEdct(matchedFlight);
      if (!edct?.edct_time) continue;
      const deltaMs = new Date(edct.edct_time).getTime() - new Date(matchedFlight.scheduled_departure).getTime();
      if (deltaMs <= 0) continue;
      leg.startMs += deltaMs;
      leg.endMs += deltaMs;
    }
    const MIN_TURN_MS = 30 * 60_000;
    edctLegs.sort((a, b) => a.startMs - b.startMs);
    for (let i = 1; i < edctLegs.length; i++) {
      const gap = edctLegs[i].startMs - edctLegs[i - 1].endMs;
      if (gap < MIN_TURN_MS) {
        const shift = MIN_TURN_MS - gap;
        edctLegs[i].startMs += shift;
        edctLegs[i].endMs += shift;
      }
    }
    edctMaxRolling24hrMin = findMaxRolling24(edctLegs);

    const todayUtcStart = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate());
    const todayUtcEnd = todayUtcStart + 24 * 60 * 60 * 1000;
    edctRestPeriods = [];
    for (let dpIdx = 0; dpIdx < dutyPeriods.length; dpIdx++) {
      if (dpIdx >= restPeriods.length) break;
      const normalRest = restPeriods[dpIdx];
      const dp = dutyPeriods[dpIdx];
      const hasTodayLegs = dp.legs.some(l => l.startMs >= todayUtcStart && l.startMs < todayUtcEnd);
      if (!hasTodayLegs) {
        edctRestPeriods.push(normalRest);
        continue;
      }
      let edctDpLastArr = 0;
      for (const leg of dp.legs) {
        const edctLeg = edctLegs.find(el =>
          el.departure_icao === leg.departure_icao && el.arrival_icao === leg.arrival_icao &&
          Math.abs(el.startMs - leg.startMs) < 6 * 60 * 60 * 1000
        );
        edctDpLastArr = Math.max(edctDpLastArr, edctLeg?.endMs ?? leg.endMs);
      }
      const edctOff = edctDpLastArr + POST_TIME_MIN * 60_000;
      const normalNextOn = dutyPeriods[dpIdx + 1].dutyOnMs;
      edctRestPeriods.push({
        startMs: edctOff,
        stopMs: normalNextOn,
        minutes: Math.max(0, (normalNextOn - edctOff) / 60_000),
      });
    }
  }

  return {
    tail,
    dutyPeriods,
    restPeriods,
    maxRolling24hrMin,
    hasFlightsTomorrow,
    breachLegKey,
    suggestion,
    edctMaxRolling24hrMin,
    edctRestPeriods,
  };
}
