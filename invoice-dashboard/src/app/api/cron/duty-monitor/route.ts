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
  buildLiveUpdateBlocks,
  buildConfirmationBlocks,
  sendDutyAlert,
} from "@/lib/dutyAlertSlack";
import type { AlertPhase } from "@/lib/dutyAlertSlack";

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
  alert_phase: string | null;
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

/** Floor ms to the nearest 1-hour boundary for stable dedup keys.
 *  Using floor (not round) so a few-minute drift never crosses a boundary. */
function floorToHour(ms: number): number {
  const ONE_HOUR = 60 * 60 * 1000;
  return Math.floor(ms / ONE_HOUR) * ONE_HOUR;
}

function makeFlightTimeKey(tail: string, dp: DutyPeriod): string {
  return `${tail}|ft|${floorToHour(dp.dutyOnMs)}`;
}

function makeRestKey(tail: string, rest: RestPeriod): string {
  return `${tail}|rest|${floorToHour(rest.startMs)}|${floorToHour(rest.stopMs)}`;
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

/** Determine alert phase from leg data sources.
 *  "scheduled" if ALL legs are from ICS schedule; "actual" if any have live/FA data. */
function detectPhase(...dps: (DutyPeriod | undefined)[]): AlertPhase {
  for (const dp of dps) {
    if (!dp) continue;
    for (const leg of dp.legs) {
      if (leg.source === "actual" || leg.source === "fa-estimate") return "actual";
    }
  }
  return "scheduled";
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

    // 5. Detect violations / cautions and send alerts (3-stage lifecycle)
    // Stage 1: "Scheduled" — warning from schedule data only
    // Stage 2: "Actual"    — live update when fleet is moving (thread reply)
    // Stage 3: "Final"     — confirmation when all legs land (handled in step 6)
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

        const keyDp = breachDp ?? td.dutyPeriods[0];
        if (keyDp) {
          const dpKey = makeFlightTimeKey(tail, keyDp);
          const existing = existingMap.get(`${tail}|${alertType}|${dpKey}`);
          const phase = detectPhase(breachDp ?? keyDp);

          if (!existing) {
            // New alert — insert first, send only if insert succeeds
            const { data: inserted, error: insertErr } = await supa.from("duty_alerts").insert({
              tail_number: tail,
              alert_type: alertType,
              severity,
              duty_period_key: dpKey,
              status: "projected",
              alert_phase: phase,
              projected_minutes: effectiveFlightMin,
              breach_leg: breachLeg ? fmtLegRoute(breachLeg) : null,
              suggestion: td.suggestion,
              slack_channel: "C0APKG2KBT5",
            }).select("id").single();

            if (inserted) {
              const { blocks, fallback } = buildFlightTimeBlocks({
                tail, severity, flightMinutes: effectiveFlightMin,
                breachLeg, suggestion: td.suggestion, dutyPeriod: breachDp, phase,
              });
              const slackTs = await sendDutyAlert(blocks, fallback);
              if (slackTs) await supa.from("duty_alerts").update({ slack_ts: slackTs }).eq("id", inserted.id);

              if (severity === "red") stats.violations++;
              else stats.cautions++;
              console.log(`[duty-monitor] New ${severity} flight_time (${phase}): ${tail} at ${fmtDuration(effectiveFlightMin)}`);
            } else {
              console.log(`[duty-monitor] Dedup caught flight_time for ${tail}: ${insertErr?.message ?? "conflict"}`);
            }
          } else if (existing.alert_phase === "scheduled" && phase === "actual") {
            // Phase upgrade: scheduled → actual. Send ONE live update as thread reply.
            const { blocks, fallback } = buildLiveUpdateBlocks({
              tail, alertType, severity,
              currentMinutes: effectiveFlightMin,
              previousMinutes: existing.projected_minutes ?? effectiveFlightMin,
            });
            if (existing.slack_ts) await sendDutyAlert(blocks, fallback, existing.slack_ts);

            await supa.from("duty_alerts").update({
              alert_phase: "actual",
              projected_minutes: effectiveFlightMin,
              severity,
              updated_at: new Date().toISOString(),
            }).eq("id", existing.id);

            console.log(`[duty-monitor] Phase upgrade flight_time (scheduled→actual): ${tail} at ${fmtDuration(effectiveFlightMin)}`);
          }
          // Otherwise: same phase, already alerted — skip
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
        const phase = detectPhase(dpBefore, dpAfter);

        if (!existing) {
          // New alert — insert first, send only if insert succeeds
          const { data: inserted, error: insertErr } = await supa.from("duty_alerts").insert({
            tail_number: tail,
            alert_type: alertType,
            severity,
            duty_period_key: restKey,
            status: "projected",
            alert_phase: phase,
            projected_minutes: rest.minutes,
            slack_channel: "C0APKG2KBT5",
          }).select("id").single();

          if (inserted) {
            const { blocks, fallback } = buildRestBlocks({
              tail, severity, restMinutes: rest.minutes,
              restPeriod: rest, dpBefore, dpAfter, phase,
            });
            const slackTs = await sendDutyAlert(blocks, fallback);
            if (slackTs) await supa.from("duty_alerts").update({ slack_ts: slackTs }).eq("id", inserted.id);

            if (severity === "red") stats.violations++;
            else stats.cautions++;
            console.log(`[duty-monitor] New ${severity} rest (${phase}): ${tail} at ${fmtDuration(rest.minutes)}`);
          } else {
            console.log(`[duty-monitor] Dedup caught rest for ${tail}: ${insertErr?.message ?? "conflict"}`);
          }
        } else if (existing.alert_phase === "scheduled" && phase === "actual") {
          // Phase upgrade: scheduled → actual. Send ONE live update as thread reply.
          const { blocks, fallback } = buildLiveUpdateBlocks({
            tail, alertType, severity,
            currentMinutes: rest.minutes,
            previousMinutes: existing.projected_minutes ?? rest.minutes,
          });
          if (existing.slack_ts) await sendDutyAlert(blocks, fallback, existing.slack_ts);

          await supa.from("duty_alerts").update({
            alert_phase: "actual",
            projected_minutes: rest.minutes,
            severity,
            updated_at: new Date().toISOString(),
          }).eq("id", existing.id);

          console.log(`[duty-monitor] Phase upgrade rest (scheduled→actual): ${tail} at ${fmtDuration(rest.minutes)}`);
        }
        // Otherwise: same phase, already alerted — skip
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
