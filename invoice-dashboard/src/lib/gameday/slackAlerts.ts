/**
 * Game Day Operations — Slack Alerts
 *
 * Posts Block Kit messages to #crew-swap when schedule changes
 * impact an active swap plan. Rate-limited to 1 message per
 * tail per 30 minutes to prevent spam during rapid sync cycles.
 */

import "server-only";
import { postSlackMessage } from "@/lib/slack";
import type { PlanImpact } from "@/lib/swapPlanImpact";

// ─── Configuration ──────────────────────────────────────────────────────────

const CREW_SWAP_CHANNEL = "C08SX2X77V1"; // #crew-swap
const RATE_LIMIT_MS = 30 * 60 * 1000; // 30 minutes

// In-memory rate limiter (reset on cold start, which is fine)
const lastAlertTime = new Map<string, number>();

// ─── Types ──────────────────────────────────────────────────────────────────

export type Suggestion = {
  type: string;
  description: string;
  estimated_cost_delta: number | null;
  crew_affected_count: number;
  auto_applicable: boolean;
};

export type ImpactWithSuggestions = PlanImpact & {
  suggestions?: Suggestion[];
};

// ─── Main function ──────────────────────────────────────────────────────────

/**
 * Post Slack alerts for new impacts. Returns count of messages sent.
 */
export async function postImpactAlerts(
  impacts: ImpactWithSuggestions[],
  swapDate: string,
): Promise<{ sent: number; rate_limited: number }> {
  let sent = 0;
  let rateLimited = 0;

  // Group by tail for consolidated messaging
  const byTail = new Map<string, ImpactWithSuggestions[]>();
  for (const impact of impacts) {
    const list = byTail.get(impact.tail_number) ?? [];
    list.push(impact);
    byTail.set(impact.tail_number, list);
  }

  const now = Date.now();

  for (const [tail, tailImpacts] of byTail) {
    // Rate limit per tail
    const rateKey = `${tail}|${swapDate}`;
    const lastSent = lastAlertTime.get(rateKey);
    if (lastSent && now - lastSent < RATE_LIMIT_MS) {
      rateLimited++;
      continue;
    }

    // Determine highest severity
    const maxSeverity = tailImpacts.some((i) => i.severity === "critical")
      ? "critical"
      : tailImpacts.some((i) => i.severity === "warning")
        ? "warning"
        : "info";

    // Don't send Slack for info-only changes
    if (maxSeverity === "info") continue;

    const emoji = maxSeverity === "critical" ? ":rotating_light:" : ":warning:";
    const severityLabel = maxSeverity === "critical" ? "CRITICAL" : "Warning";

    // Build affected crew list
    const crewLines = tailImpacts.flatMap((impact) =>
      impact.affected_crew.map(
        (c) => `*${c.name}* (${c.role} ${c.direction}) — ${c.detail}`,
      ),
    );

    // Build suggestion lines
    const suggestionLines = tailImpacts
      .flatMap((i) => i.suggestions ?? [])
      .slice(0, 3) // max 3 suggestions in Slack
      .map((s) => `> ${s.description}`);

    const blocks: Record<string, unknown>[] = [
      {
        type: "header",
        text: {
          type: "plain_text",
          text: `${emoji} Schedule Change: ${tail} [${severityLabel}]`,
          emoji: true,
        },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Swap date:* ${swapDate}\n*Affected crew:*\n${crewLines.join("\n")}`,
        },
      },
    ];

    if (suggestionLines.length > 0) {
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Suggested actions:*\n${suggestionLines.join("\n")}`,
        },
      });
    }

    blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `Detected ${new Date().toLocaleTimeString("en-US", { timeZone: "America/Chicago", hour: "numeric", minute: "2-digit" })} CT | <https://baker-ai-gamma.vercel.app/ops|View Dashboard>`,
        },
      ],
    });

    const result = await postSlackMessage({
      channel: CREW_SWAP_CHANNEL,
      text: `${emoji} Schedule change on ${tail} — ${crewLines.length} crew affected`,
      blocks,
    });

    if (result) {
      sent++;
      lastAlertTime.set(rateKey, now);
    }
  }

  return { sent, rate_limited: rateLimited };
}
