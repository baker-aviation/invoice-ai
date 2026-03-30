import "server-only";

import { postSlackMessage } from "@/lib/slack";
import { fmtDuration, fmtZulu, fmtDateShort } from "@/lib/dutyCalc";
import type { DutyPeriod, RestPeriod, LegInterval } from "@/lib/dutyCalc";

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

function fmtDpLegs(dp: DutyPeriod): string {
  return dp.legs
    .map(l => `${fmtLegRoute(l)} (${fmtZulu(l.startMs)}-${fmtZulu(l.endMs)} ${l.source === "actual" ? "actual" : l.source === "fa-estimate" ? "FA est" : "sched"})`)
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
          breachLeg ? `*Triggering leg:* ${fmtLegRoute(breachLeg)} (departs ${fmtZulu(breachLeg.startMs)})` : null,
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
          `*Current DP ends:* ${fmtDateShort(dpBefore.dutyOffMs)} ${fmtZulu(dpBefore.dutyOffMs)} (est)`,
          `*Next DP begins:* ${fmtDateShort(dpAfter.dutyOnMs)} ${fmtZulu(dpAfter.dutyOnMs)}`,
          `*Rest window:* ${fmtZulu(restPeriod.startMs)} → ${fmtZulu(restPeriod.stopMs)}`,
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
