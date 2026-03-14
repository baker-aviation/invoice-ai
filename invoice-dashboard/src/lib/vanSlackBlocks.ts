/**
 * Shared Slack Block Kit builder for van schedule messages.
 * Used by both single share and bulk share endpoints.
 */

export type VanSlackItem = {
  tail: string;
  route: string;       // "TEB → PBI"
  arrivalTime: string;  // "14:30 UTC"
  status: string;       // "Scheduled" | "~Landed" | "En Route" | "DIVERTED"
  nextDep?: string;     // "Flying again 18:00 UTC → VNY"
  turnStatus?: string;  // "Quickturn" | "Done for day"
  driveTime?: string;   // "1h 30m drive"
};

const VAN_BASE_URL = process.env.VAN_BASE_URL ?? "https://www.whitelabel-ops.com";

export function buildVanSlackBlocks(
  vanName: string,
  vanId: number,
  homeAirport: string,
  date: string,
  items: VanSlackItem[],
) {
  const header = `*${vanName} (V${vanId})* — ${date}\nBase: ${homeAirport}`;

  const aircraftLines =
    items.length === 0
      ? ["_No arrivals scheduled_"]
      : items.map((item) => {
          let line = `• *${item.tail}* ${item.route} — Lands ${item.arrivalTime}`;
          if (item.status === "~Landed") line += " _(Landed)_";
          if (item.driveTime) line += ` · ${item.driveTime}`;
          if (item.nextDep) line += `\n  ↳ ${item.nextDep}`;
          return line;
        });

  const vanUrl = `${VAN_BASE_URL}/van/${vanId}`;

  return [
    {
      type: "header",
      text: { type: "plain_text", text: `🚐 AOG Van Schedule — ${date}`, emoji: true },
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: header },
    },
    { type: "divider" },
    {
      type: "section",
      text: { type: "mrkdwn", text: aircraftLines.join("\n") },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "📋 Open Van Schedule", emoji: true },
          url: vanUrl,
          action_id: `open_van_${vanId}`,
        },
      ],
    },
    {
      type: "context",
      elements: [
        { type: "mrkdwn", text: `Shared from Baker Aviation AOG Van Planner · ${items.length} aircraft` },
      ],
    },
  ];
}

export function buildVanSlackFallbackText(vanName: string, date: string): string {
  return `AOG Van Schedule: ${vanName} — ${date}`;
}
