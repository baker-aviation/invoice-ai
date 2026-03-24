import "server-only";

const INTL_DELAY_SLACK_CHANNEL = "C05M76JGKNG"; // #customs-bosses

export type IntlSlackAlert = {
  flight_id: string;
  alert_type: string;
  severity: string;
  message: string;
};

/**
 * Post international delay/diversion alerts to #customs-bosses Slack channel.
 * Used by both run-checks (polling) and the FA webhook (real-time push).
 */
export async function sendIntlAlertSlack(alerts: IntlSlackAlert[]): Promise<void> {
  if (alerts.length === 0) return;

  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) {
    console.warn("[intl/slack] SLACK_BOT_TOKEN not set — skipping Slack notification");
    return;
  }

  const blocks: Array<Record<string, unknown>> = [
    {
      type: "header",
      text: { type: "plain_text", text: `International Flight Alert${alerts.length > 1 ? "s" : ""}` },
    },
  ];

  for (const a of alerts) {
    const emoji = a.alert_type === "diversion" ? ":rotating_light:" : a.severity === "critical" ? ":warning:" : ":clock3:";
    const label = a.alert_type === "diversion" ? "DIVERTED" : "DELAYED";
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `${emoji} *${label}*\n${a.message}`,
      },
    });
  }

  blocks.push({
    type: "context",
    elements: [{ type: "mrkdwn", text: `Detected at ${new Date().toISOString().slice(11, 16)}Z by Baker Ops Monitor` }],
  });

  const fallback = alerts.map((a) => a.message).join("\n");

  try {
    const res = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        channel: INTL_DELAY_SLACK_CHANNEL,
        text: fallback,
        blocks,
      }),
    });
    const data = await res.json();
    if (!data.ok) {
      console.error("[intl/slack] Slack error:", data.error);
    } else {
      console.log(`[intl/slack] Posted ${alerts.length} delay/diversion alert(s) to #customs-bosses`);
    }
  } catch (err) {
    console.error("[intl/slack] Slack fetch error:", err instanceof Error ? err.message : err);
  }
}
