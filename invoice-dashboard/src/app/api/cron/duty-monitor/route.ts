import { NextRequest, NextResponse } from "next/server";
import { verifyCronSecret } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";
import { fetchFlightsLite } from "@/lib/opsApi";
import type { FlightInfo } from "@/lib/flightaware";
import {
  buildLegIntervals,
  computeTailDuty,
  groupFaByTail,
  findMaxRolling24,
  buildRestPeriods,
  groupIntoDutyPeriods,
  relabelDPs,
  fmtDuration,
  FLIGHT_TIME_RED_MIN,
  FLIGHT_TIME_YELLOW_MIN,
  REST_RED_HOURS,
  REST_YELLOW_HOURS,
} from "@/lib/dutyCalc";
import type { TailDutyResult, DutyPeriod, RestPeriod, LegInterval } from "@/lib/dutyCalc";
import {
  buildFlightTimeBlocks,
  buildRestBlocks,
  buildConfirmationBlocks,
  sendDutyAlert,
} from "@/lib/dutyAlertSlack";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/* ── Types ──────────────────────────────────────────── */

type DutyAlertRow = {
  id: string;
  tail_number: string;
  alert_type: string;
  severity: string;
  duty_period_key: string;
  status: string;
  projected_minutes: number | null;
  confirmed_minutes: number | null;
  breach_leg: string | null;
  suggestion: string | null;
  slack_ts: string | null;
  slack_channel: string | null;
  first_detected_at: string;
  confirmed_at: string | null;
  cleared_at: string | null;
};

/* ── Helpers ────────────────────────────────────────── */

/** Round ms to nearest 15-min boundary for stable dedup keys */
function roundTo15Min(ms: number): number {
  const FIFTEEN_MIN = 15 * 60 * 1000;
  return Math.round(ms / FIFTEEN_MIN) * FIFTEEN_MIN;
}

function makeFlightTimeKey(tail: string, dp: DutyPeriod): string {
  return `${tail}|ft|${roundTo15Min(dp.dutyOnMs)}`;
}

function makeRestKey(tail: string, rest: RestPeriod): string {
  return `${tail}|rest|${roundTo15Min(rest.startMs)}|${roundTo15Min(rest.stopMs)}`;
}

/** Check if all legs in a duty period have actual arrival data */
function allLegsLanded(dp: DutyPeriod): boolean {
  return dp.legs.every(l => l.source === "actual");
}

function stripK(icao: string | null): string {
  if (!icao) return "???";
  const u = icao.toUpperCase();
  if (u.length === 4 && u.startsWith("K")) return u.slice(1);
  return u;
}

function fmtLegRoute(leg: LegInterval): string {
  return `${stripK(leg.departure_icao)} → ${stripK(leg.arrival_icao)}`;
}

/* ── Main Handler ──────────────────────────────────── */

export async function GET(req: NextRequest) {
  if (!verifyCronSecret(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supa = createServiceClient();
  const stats = { tails_checked: 0, violations: 0, cautions: 0, confirmations: 0, cleared: 0 };

  try {
    // 1. Fetch ICS flight schedule (36h back + 48h forward covers 3-day window)
    const { flights } = await fetchFlightsLite({ lookback_hours: 36, lookahead_hours: 48 });

    // 2. Fetch FA data from fa_flights table (same source as /api/aircraft/flights)
    const cutoff = new Date(Date.now() - 36 * 60 * 60 * 1000).toISOString();
    const { data: faRows } = await supa
      .from("fa_flights")
      .select("*")
      .gt("updated_at", cutoff)
      .order("departure_time", { ascending: true, nullsFirst: false });

    const faFlights: FlightInfo[] = (faRows ?? []).map((row: Record<string, unknown>) => ({
      tail: row.tail as string,
      ident: row.ident as string,
      fa_flight_id: row.fa_flight_id as string,
      origin_icao: row.origin_icao as string | null,
      origin_name: row.origin_name as string | null,
      destination_icao: row.destination_icao as string | null,
      destination_name: row.destination_name as string | null,
      status: row.status as string | null,
      progress_percent: row.progress_percent as number | null,
      departure_time: row.departure_time ? new Date(row.departure_time as string).toISOString() : null,
      arrival_time: row.arrival_time ? new Date(row.arrival_time as string).toISOString() : null,
      scheduled_arrival: row.scheduled_arrival ? new Date(row.scheduled_arrival as string).toISOString() : null,
      actual_departure: row.actual_departure ? new Date(row.actual_departure as string).toISOString() : null,
      actual_arrival: row.actual_arrival ? new Date(row.actual_arrival as string).toISOString() : null,
      route: row.route as string | null,
      route_distance_nm: row.route_distance_nm as number | null,
      filed_altitude: row.filed_altitude as number | null,
      diverted: (row.diverted as boolean) ?? false,
      cancelled: (row.cancelled as boolean) ?? false,
      aircraft_type: row.aircraft_type as string | null,
      latitude: row.latitude as number | null,
      longitude: row.longitude as number | null,
      altitude: row.altitude as number | null,
      groundspeed: row.groundspeed as number | null,
      heading: row.heading as number | null,
    }));

    // 3. Compute duty data for all tails
    const faByTail = groupFaByTail(faFlights);
    const legsByTail = buildLegIntervals(flights, faByTail);
    const results = new Map<string, TailDutyResult>();

    for (const [tail, legs] of legsByTail) {
      const tailFlights = flights.filter(f => f.tail_number === tail);
      results.set(tail, computeTailDuty(tail, legs, tailFlights));
    }
    stats.tails_checked = results.size;

    // 4. Load existing active alerts for dedup
    const alertLookback = new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString();
    const { data: existingRows } = await supa
      .from("duty_alerts")
      .select("*")
      .neq("status", "cleared")
      .gte("first_detected_at", alertLookback);

    const existingMap = new Map<string, DutyAlertRow>();
    for (const row of (existingRows ?? []) as DutyAlertRow[]) {
      existingMap.set(`${row.tail_number}|${row.alert_type}|${row.duty_period_key}`, row);
    }

    // 5. Detect violations / cautions and send alerts
    for (const [tail, td] of results) {
      // ── 10/24 flight time check ──
      // Use EDCT-adjusted value when available (worst case)
      const effectiveFlightMin = td.edctMaxRolling24hrMin != null
        ? Math.max(td.maxRolling24hrMin, td.edctMaxRolling24hrMin)
        : td.maxRolling24hrMin;

      if (effectiveFlightMin >= FLIGHT_TIME_YELLOW_MIN) {
        const severity = effectiveFlightMin >= FLIGHT_TIME_RED_MIN ? "red" : "yellow";
        const alertType = "flight_time";

        // Find the breach DP (the DP containing the breach leg)
        let breachDp: DutyPeriod | null = null;
        let breachLeg: LegInterval | null = null;
        if (td.breachLegKey) {
          const [dpIdx, legIdx] = td.breachLegKey.split("-").map(Number);
          breachDp = td.dutyPeriods[dpIdx] ?? null;
          breachLeg = breachDp?.legs[legIdx] ?? null;
        }

        // Use the breach DP for the dedup key, fallback to first DP
        const keyDp = breachDp ?? td.dutyPeriods[0];
        if (keyDp) {
          const dpKey = makeFlightTimeKey(tail, keyDp);
          const existing = existingMap.get(`${tail}|${alertType}|${dpKey}`);

          if (!existing) {
            // New alert — send Slack + insert
            const { blocks, fallback } = buildFlightTimeBlocks({
              tail,
              severity,
              flightMinutes: effectiveFlightMin,
              breachLeg,
              suggestion: td.suggestion,
              dutyPeriod: breachDp,
            });
            const slackTs = await sendDutyAlert(blocks, fallback);

            await supa.from("duty_alerts").insert({
              tail_number: tail,
              alert_type: alertType,
              severity,
              duty_period_key: dpKey,
              status: "projected",
              projected_minutes: effectiveFlightMin,
              breach_leg: breachLeg ? fmtLegRoute(breachLeg) : null,
              suggestion: td.suggestion,
              slack_ts: slackTs,
              slack_channel: "C0APKG2KBT5",
            });

            if (severity === "red") stats.violations++;
            else stats.cautions++;

            console.log(`[duty-monitor] New ${severity} flight_time alert: ${tail} at ${fmtDuration(effectiveFlightMin)}`);
          }
          // If existing, don't re-alert (dedup)
        }
      }

      // ── Rest check ──
      const effectiveRests = td.edctRestPeriods ?? td.restPeriods;
      for (let i = 0; i < effectiveRests.length; i++) {
        const rest = effectiveRests[i];
        if (rest.minutes >= REST_YELLOW_HOURS * 60) continue; // OK

        const severity = rest.minutes < REST_RED_HOURS * 60 ? "red" : "yellow";
        const alertType = "rest";
        const dpBefore = td.dutyPeriods[i];
        const dpAfter = td.dutyPeriods[i + 1];
        if (!dpBefore || !dpAfter) continue;

        const restKey = makeRestKey(tail, rest);
        const existing = existingMap.get(`${tail}|${alertType}|${restKey}`);

        if (!existing) {
          const { blocks, fallback } = buildRestBlocks({
            tail,
            severity,
            restMinutes: rest.minutes,
            restPeriod: rest,
            dpBefore,
            dpAfter,
          });
          const slackTs = await sendDutyAlert(blocks, fallback);

          await supa.from("duty_alerts").insert({
            tail_number: tail,
            alert_type: alertType,
            severity,
            duty_period_key: restKey,
            status: "projected",
            projected_minutes: rest.minutes,
            slack_ts: slackTs,
            slack_channel: "C0APKG2KBT5",
          });

          if (severity === "red") stats.violations++;
          else stats.cautions++;

          console.log(`[duty-monitor] New ${severity} rest alert: ${tail} at ${fmtDuration(rest.minutes)}`);
        }
      }
    }

    // 6. Check for confirmations on existing projected alerts
    for (const [dedup, alert] of existingMap) {
      if (alert.status !== "projected") continue;
      const td = results.get(alert.tail_number);
      if (!td) continue;

      if (alert.alert_type === "flight_time") {
        // Check if the relevant DP has all legs landed
        const keyDp = td.dutyPeriods.find(dp => makeFlightTimeKey(alert.tail_number, dp) === alert.duty_period_key);
        if (!keyDp || !allLegsLanded(keyDp)) continue;

        // Recompute with all-windows mode (all legs are past)
        const allLegs = td.dutyPeriods.flatMap(dp => dp.legs);
        const finalMin = findMaxRolling24(allLegs, { includeAllWindows: true });
        const cleared = finalMin < FLIGHT_TIME_YELLOW_MIN;

        const { blocks, fallback } = buildConfirmationBlocks({
          tail: alert.tail_number,
          alertType: "flight_time",
          cleared,
          projectedMinutes: alert.projected_minutes ?? 0,
          confirmedMinutes: finalMin,
          threadTs: alert.slack_ts ?? "",
        });

        if (alert.slack_ts) {
          await sendDutyAlert(blocks, fallback, alert.slack_ts);
        }

        await supa.from("duty_alerts")
          .update({
            status: cleared ? "cleared" : "confirmed",
            confirmed_minutes: finalMin,
            ...(cleared ? { cleared_at: new Date().toISOString() } : { confirmed_at: new Date().toISOString() }),
            updated_at: new Date().toISOString(),
          })
          .eq("id", alert.id);

        if (cleared) stats.cleared++;
        else stats.confirmations++;

        console.log(`[duty-monitor] ${cleared ? "Cleared" : "Confirmed"} flight_time: ${alert.tail_number} at ${fmtDuration(finalMin)}`);
      }

      if (alert.alert_type === "rest") {
        // Check if the DP BEFORE the rest period has all legs landed
        // Parse rest key to find the matching rest period
        for (let i = 0; i < td.restPeriods.length; i++) {
          const rest = td.restPeriods[i];
          if (makeRestKey(alert.tail_number, rest) !== alert.duty_period_key) continue;

          const dpBefore = td.dutyPeriods[i];
          if (!dpBefore || !allLegsLanded(dpBefore)) continue;

          // DP before is done — compute final rest with actual times
          const dpAfter = td.dutyPeriods[i + 1];
          if (!dpAfter) continue;

          const finalRestMin = rest.minutes;
          const cleared = finalRestMin >= REST_RED_HOURS * 60;

          const { blocks, fallback } = buildConfirmationBlocks({
            tail: alert.tail_number,
            alertType: "rest",
            cleared,
            projectedMinutes: alert.projected_minutes ?? 0,
            confirmedMinutes: finalRestMin,
            threadTs: alert.slack_ts ?? "",
          });

          if (alert.slack_ts) {
            await sendDutyAlert(blocks, fallback, alert.slack_ts);
          }

          await supa.from("duty_alerts")
            .update({
              status: cleared ? "cleared" : "confirmed",
              confirmed_minutes: finalRestMin,
              ...(cleared ? { cleared_at: new Date().toISOString() } : { confirmed_at: new Date().toISOString() }),
              updated_at: new Date().toISOString(),
            })
            .eq("id", alert.id);

          if (cleared) stats.cleared++;
          else stats.confirmations++;

          console.log(`[duty-monitor] ${cleared ? "Cleared" : "Confirmed"} rest: ${alert.tail_number} at ${fmtDuration(finalRestMin)}`);
          break;
        }
      }
    }

    // 7. Expire stale projected alerts (>48h old with no confirmation)
    const staleThreshold = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    await supa.from("duty_alerts")
      .update({ status: "cleared", cleared_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq("status", "projected")
      .lt("first_detected_at", staleThreshold);

    console.log(`[duty-monitor] Done. Tails: ${stats.tails_checked}, violations: ${stats.violations}, cautions: ${stats.cautions}, confirmed: ${stats.confirmations}, cleared: ${stats.cleared}`);

    return NextResponse.json({ ok: true, ...stats });
  } catch (err) {
    console.error("[duty-monitor] Error:", err instanceof Error ? err.message : err);
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
  }
}
