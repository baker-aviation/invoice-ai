import "server-only";

import { postSlackMessage } from "@/lib/slack";
import { fmtDuration, fmtZulu } from "@/lib/dutyCalc";
import type { DutyPeriod, RestPeriod, LegInterval } from "@/lib/dutyCalc";
import { getAirportTimezone } from "@/lib/airportTimezones";

export const DUTY_ALERT_CHANNEL = "C0APKG2KBT5"; // #10-24-issues

/* ── Types ──────────────────────────────────────────── */

type SlackBlock = Record<string, unknown>;

export type FlightTimeAlertParams = {
  tail: string;
  severity: "red" | "yellow";
  flightMinutes: number;
  breachLeg: LegInterval | null;
  suggestion: string | null;
  dutyPeriod: DutyPeriod | null;
  windowStartMs?: number;
  windowEndMs?: number;
};

export type RestAlertParams = {
  tail: string;
  severity: "red" | "yellow";
  restMinutes: number;
  restPeriod: RestPeriod;
  dpBefore: DutyPeriod;
  dpAfter: DutyPeriod;
};

export type ConfirmationAlertParams = {
  tail: string;
  alertType: "flight_time" | "rest";
  cleared: boolean;
  projectedMinutes: number;
  confirmedMinutes: number;
  threadTs: string;
};

/* ── Helpers ────────────────────────────────────────── */

function fmtLegRoute(leg: LegInterval): string {
  const dep = stripK(leg.departure_icao);
  const arr = stripK(leg.arrival_icao);
  return `${dep} → ${arr}`;
}

function stripK(icao: string | null): string {
  if (!icao) return "???";
  const u = icao.toUpperCase();
  if (u.length === 4 && u.startsWith("K")) return u.slice(1);
  return u;
}

/** Format ms timestamp in an airport's local timezone, e.g. "1830 EDT". Falls back to Zulu. */
function fmtLocalTime(ms: number, icao: string | null): string {
  const tz = getAirportTimezone(icao);
  if (!tz) return fmtZulu(ms);
  const d = new Date(ms);
  const hh = d.toLocaleString("en-US", { hour: "2-digit", hour12: false, timeZone: tz }).padStart(2, "0");
  const mm = d.toLocaleString("en-US", { minute: "2-digit", timeZone: tz }).padStart(2, "0");
  const tzAbbr = d.toLocaleString("en-US", { timeZoneName: "short", timeZone: tz }).split(" ").pop() ?? "";
  return `${hh}${mm} ${tzAbbr}`;
}

/** Format ms timestamp as "Mar 30" in an airport's local timezone. Falls back to UTC. */
function fmtLocalDate(ms: number, icao: string | null): string {
  const tz = getAirportTimezone(icao) ?? "UTC";
  return new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: tz });
}

/** Get the "rest location" ICAO — last arrival of the preceding duty period. */
function restAirport(dp: DutyPeriod): string | null {
  const lastLeg = dp.legs[dp.legs.length - 1];
  return lastLeg?.arrival_icao ?? null;
}

function fmtDpLegs(dp: DutyPeriod): string {
  return dp.legs
    .map(l => `${fmtLegRoute(l)} (${fmtLocalTime(l.startMs, l.departure_icao)}-${fmtLocalTime(l.endMs, l.arrival_icao)} ${l.source === "actual" ? "actual" : l.source === "fa-estimate" ? "FA est" : "sched"})`)
    .join(" · ");
}

/* ── Block Kit builders ─────────────────────────────── */

export function buildFlightTimeBlocks(params: FlightTimeAlertParams): { blocks: SlackBlock[]; fallback: string } {
  const { tail, severity, flightMinutes, breachLeg, suggestion, dutyPeriod } = params;
  const emoji = severity === "red" ? ":rotating_light:" : ":warning:";
  const label = severity === "red" ? "10/24 Violation" : "10/24 Caution";
  const headerText = `${tail} — ${label} (Projected)`;

  const blocks: SlackBlock[] = [
    {
      type: "header",
      text: { type: "plain_text", text: `${severity === "red" ? "\u{1F6A8}" : "\u26A0\uFE0F"} ${headerText}` },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: [
          `${emoji} *PROJECTED ${severity === "red" ? "OVERAGE" : "CAUTION"}*`,
          `*${tail}* is projected to ${severity === "red" ? "exceed" : "approach"} the 10hr flight time limit in a rolling 24hr window`,
          `\n*Projected flight time:* ${fmtDuration(flightMinutes)} ${severity === "red" ? "(limit: 10h 00m)" : "(caution at 9h 00m)"}`,
          breachLeg ? `*Triggering leg:* ${fmtLegRoute(breachLeg)} (departs ${fmtLocalTime(breachLeg.startMs, breachLeg.departure_icao)})` : null,
          dutyPeriod ? `*DP legs:* ${fmtDpLegs(dutyPeriod)}` : null,
          suggestion ? `:bulb: ${suggestion}` : null,
        ].filter(Boolean).join("\n"),
      },
    },
    {
      type: "context",
      elements: [{ type: "mrkdwn", text: `Detected at ${new Date().toISOString().slice(11, 16)}Z by Baker Ops Monitor` }],
    },
  ];

  const fallback = `${label}: ${tail} projected at ${fmtDuration(flightMinutes)} flight time${breachLeg ? ` (${fmtLegRoute(breachLeg)})` : ""}`;
  return { blocks, fallback };
}

export function buildRestBlocks(params: RestAlertParams): { blocks: SlackBlock[]; fallback: string } {
  const { tail, severity, restMinutes, restPeriod, dpBefore, dpAfter } = params;
  const restIcao = restAirport(dpBefore);
  const emoji = severity === "red" ? ":rotating_light:" : ":warning:";
  const label = severity === "red" ? "Rest Violation" : "Rest Caution";
  const headerText = `${tail} — ${label} (Projected)`;

  const blocks: SlackBlock[] = [
    {
      type: "header",
      text: { type: "plain_text", text: `${severity === "red" ? "\u{1F6A8}" : "\u26A0\uFE0F"} ${headerText}` },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: [
          `${emoji} *PROJECTED REST SHORTAGE*`,
          `*${tail}* is projected to have insufficient rest before next duty period`,
          `\n*Projected rest:* ${fmtDuration(restMinutes)} ${severity === "red" ? "(minimum required: 10h)" : "(caution below 11h)"}`,
          `*Current DP ends:* ${fmtLocalDate(dpBefore.dutyOffMs, restIcao)} ${fmtLocalTime(dpBefore.dutyOffMs, restIcao)} (est)`,
          `*Next DP begins:* ${fmtLocalDate(dpAfter.dutyOnMs, restIcao)} ${fmtLocalTime(dpAfter.dutyOnMs, restIcao)}`,
          `*Rest window:* ${fmtLocalTime(restPeriod.startMs, restIcao)} → ${fmtLocalTime(restPeriod.stopMs, restIcao)}`,
        ].filter(Boolean).join("\n"),
      },
    },
    {
      type: "context",
      elements: [{ type: "mrkdwn", text: `Detected at ${new Date().toISOString().slice(11, 16)}Z by Baker Ops Monitor` }],
    },
  ];

  const fallback = `${label}: ${tail} projected rest ${fmtDuration(restMinutes)}`;
  return { blocks, fallback };
}

export function buildConfirmationBlocks(params: ConfirmationAlertParams): { blocks: SlackBlock[]; fallback: string } {
  const { tail, alertType, cleared, projectedMinutes, confirmedMinutes } = params;

  const isFlightTime = alertType === "flight_time";
  let emoji: string;
  let label: string;
  let detail: string;

  if (cleared) {
    emoji = ":white_check_mark:";
    label = isFlightTime ? "10/24 Cleared" : "Rest Cleared";
    detail = isFlightTime
      ? `Final rolling 24hr: *${fmtDuration(confirmedMinutes)}* (under 10h limit)`
      : `Final rest: *${fmtDuration(confirmedMinutes)}* (meets 10h minimum)`;
  } else {
    emoji = ":rotating_light:";
    label = isFlightTime ? "10/24 Confirmed" : "Rest Violation Confirmed";
    detail = isFlightTime
      ? `Final rolling 24hr: *${fmtDuration(confirmedMinutes)}* (limit: 10h 00m)`
      : `Final rest: *${fmtDuration(confirmedMinutes)}* (10h required)`;
  }

  const blocks: SlackBlock[] = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: [
          `${emoji} *${tail}* — ${label}`,
          detail,
          `Originally projected: ${fmtDuration(projectedMinutes)}`,
          cleared ? "All legs in duty period have landed." : "Duty period complete — violation confirmed.",
        ].join("\n"),
      },
    },
    {
      type: "context",
      elements: [{ type: "mrkdwn", text: `Confirmed at ${new Date().toISOString().slice(11, 16)}Z by Baker Ops Monitor` }],
    },
  ];

  const fallback = `${label}: ${tail} — ${fmtDuration(confirmedMinutes)}`;
  return { blocks, fallback };
}

/* ── Send helpers ───────────────────────────────────── */

export async function sendDutyAlert(
  blocks: SlackBlock[],
  fallbackText: string,
  threadTs?: string,
): Promise<string | null> {
  const payload: Record<string, unknown> = {
    channel: DUTY_ALERT_CHANNEL,
    text: fallbackText,
    blocks,
  };
  if (threadTs) {
    payload.thread_ts = threadTs;
  }
  const resp = await postSlackMessage(payload);
  if (!resp) return null;
  if (!resp.ok) {
    console.error("[duty-monitor/slack] Error:", resp.error);
    return null;
  }
  return (resp.ts as string) ?? null;
}
