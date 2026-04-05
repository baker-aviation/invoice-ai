/**
 * Shared Slack Block Kit builder for van schedule messages.
 * Used by both single share and bulk share endpoints.
 *
 * Sends a header message, then one message per aircraft so drivers
 * can reply in-thread to each specific aircraft.
 */

export type VanSlackItem = {
  tail: string;
  airport: string;       // "BCT"
  fbo?: string | null;   // "Atlantic Aviation"
  arrivalTime: string;   // "14:30 ET"
  status: string;        // "Scheduled" | "~Landed" | "En Route" | "DIVERTED"
  nextDep?: string;      // "Flying again 18:00 ET → VNY"
  turnStatus?: string;   // "Quickturn" | "Done for day"
  driveTime?: string;    // "1h 30m drive"
  route?: string;        // deprecated, kept for compat
  mxNotes?: string[];    // MX note descriptions for this aircraft
};

const VAN_BASE_URL = process.env.VAN_BASE_URL ?? "https://www.whitelabel-ops.com";

/** Header message blocks — posted first, subsequent aircraft messages are threaded under it. */
export function buildVanSlackHeaderBlocks(
  vanName: string,
  vanId: number,
  homeAirport: string,
  date: string,
  itemCount: number,
) {
  const vanUrl = `${VAN_BASE_URL}/van/${vanId}`;
  return [
    {
      type: "header",
      text: { type: "plain_text", text: `🚐 Schedule Update for Today — ${date}`, emoji: true },
    },
    {
      type: "context",
      elements: [{ type: "mrkdwn", text: "✨ *New Van Schedule Style* — each aircraft now has its own thread for details & conversation" }],
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: `*${vanName} (V${vanId})* — ${date}\nBase: ${homeAirport}\n${itemCount} aircraft assigned` },
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
  ];
}

/** Per-aircraft button block — posted as a top-level message. Thread holds the details. */
export function buildAircraftButtonBlock(item: VanSlackItem) {
  const airport = item.airport ?? item.route?.split("→").pop()?.trim() ?? "?";
  const fboLabel = item.fbo ? ` ${item.fbo.toUpperCase()}` : "";

  let statusEmoji = "⏳";
  if (item.status === "~Landed" || item.status === "Landed") statusEmoji = "✅";
  else if (item.status.startsWith("En Route")) statusEmoji = "✈️";
  else if (item.status === "DIVERTED") statusEmoji = "🔴";

  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `${statusEmoji} *${item.tail}  ${airport}${fboLabel}*\n_Click for details_`,
      },
    },
  ];
}

/** Per-aircraft detail blocks — posted as a thread reply under the button. */
export function buildAircraftDetailBlocks(item: VanSlackItem) {
  const airport = item.airport ?? item.route?.split("→").pop()?.trim() ?? "?";
  const fboLabel = item.fbo ? ` · ${item.fbo}` : "";

  let body = `*${item.tail}* → ${airport}${fboLabel}\n`;
  body += `Arrival: ${item.arrivalTime}`;
  if (item.status !== "Scheduled") body += ` _(${item.status})_`;
  if (item.driveTime) body += `\nDrive: ${item.driveTime}`;
  if (item.turnStatus) body += `\nTurn: ${item.turnStatus}`;
  if (item.nextDep) body += `\n↳ _${item.nextDep}_`;

  const blocks: Record<string, unknown>[] = [
    {
      type: "section",
      text: { type: "mrkdwn", text: body },
    },
  ];

  if (item.mxNotes && item.mxNotes.length > 0) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `🔧 *MX Notes:*\n${item.mxNotes.map((n) => `• ${n}`).join("\n")}` },
    });
  }

  return blocks;
}

export function buildVanSlackFallbackText(vanName: string, date: string): string {
  return `Schedule Update for Today: ${vanName} — ${date}`;
}

export function buildAircraftFallbackText(item: VanSlackItem): string {
  return `${item.tail} → ${item.airport} — ${item.arrivalTime}`;
}

// ── Change summary blocks (for Update Vans) ──

export type VanChangeDiff = {
  added: { tail: string; airport: string }[];
  removed: { tail: string; airport: string }[];
  newOrder: { tail: string; airport: string }[];
  note?: string;
};

/** Format an added item in the same style as a regular aircraft block. */
function formatAddedItem(a: { tail: string; airport: string }, items?: VanSlackItem[]): string {
  const match = items?.find((i) => i.tail === a.tail);
  if (!match) return `➕ Added: *${a.tail}* @ ${a.airport}`;

  const fboLabel = match.fbo ? ` · ${match.fbo}` : "";
  let line = `➕ *${match.tail}* → ${match.airport}${fboLabel}`;
  line += `\nArrival: ${match.arrivalTime}`;
  if (match.driveTime) line += `\nDrive: ${match.driveTime}`;
  if (match.turnStatus) line += `\nTurn: ${match.turnStatus}`;
  if (match.nextDep) line += `\n↳ _${match.nextDep}_`;
  return line;
}

/** Change summary header — posted as a single message to the van's Slack channel. */
export function buildVanChangeBlocks(
  vanName: string,
  vanId: number,
  date: string,
  diff: VanChangeDiff,
  items?: VanSlackItem[],
) {
  const vanUrl = `${VAN_BASE_URL}/van/${vanId}`;
  const lines: string[] = [];

  if (diff.added.length > 0) {
    lines.push(diff.added.map((a) => formatAddedItem(a, items)).join("\n\n"));
  }
  if (diff.removed.length > 0) {
    lines.push(diff.removed.map((r) => `➖ Removed: *${r.tail}* @ ${r.airport}`).join("\n"));
  }
  if (diff.newOrder.length > 0) {
    lines.push(`📋 New order: ${diff.newOrder.map((o) => `${o.tail} → ${o.airport}`).join(", ")}`);
  }
  if (diff.note) {
    lines.push(`📝 Note: ${diff.note}`);
  }

  return [
    {
      type: "header",
      text: { type: "plain_text", text: `🔄 ${vanName} (V${vanId}) — Schedule Update`, emoji: true },
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: lines.join("\n\n") || "_No changes_" },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "📋 Open Van Schedule", emoji: true },
          url: vanUrl,
          action_id: `open_van_update_${vanId}`,
        },
      ],
    },
  ];
}

export function buildVanChangeFallbackText(vanName: string, date: string): string {
  return `Schedule Update: ${vanName} — ${date}`;
}
