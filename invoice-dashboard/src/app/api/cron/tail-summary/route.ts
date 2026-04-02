import { NextRequest, NextResponse } from "next/server";
import { verifyCronSecret } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";
import { postSlackMessage } from "@/lib/slack";
import Anthropic from "@anthropic-ai/sdk";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const SUMMARY_CHANNEL = "C0AQJHJ3KQA"; // #tail-summary
const CHARLIE_DM = "D0AK75CPPJM";

/* ── Slack channel reader ─────────────────────────────── */

interface SlackMessage {
  user?: string;
  text?: string;
  ts?: string;
  subtype?: string;
  bot_id?: string;
  username?: string;
  files?: { name?: string }[];
}

async function readChannelHistory(
  channelId: string,
  oldest: string,
): Promise<SlackMessage[]> {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) return [];

  const messages: SlackMessage[] = [];
  let cursor: string | undefined;

  do {
    const params = new URLSearchParams({
      channel: channelId,
      oldest,
      limit: "200",
    });
    if (cursor) params.set("cursor", cursor);

    const res = await fetch(
      `https://slack.com/api/conversations.history?${params}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    const data = await res.json();

    if (!data.ok) {
      console.error(`[tail-summary] Failed to read ${channelId}: ${data.error}`);
      break;
    }

    messages.push(...(data.messages ?? []));
    cursor = data.response_metadata?.next_cursor;
  } while (cursor);

  return messages;
}

/* ── Slack user name resolver ─────────────────────────── */

const userCache = new Map<string, string>();

async function resolveUserName(userId: string): Promise<string> {
  if (userCache.has(userId)) return userCache.get(userId)!;

  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) return userId;

  try {
    const res = await fetch(
      `https://slack.com/api/users.info?user=${userId}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    const data = await res.json();
    const name =
      data.user?.profile?.display_name ||
      data.user?.real_name ||
      data.user?.name ||
      userId;
    userCache.set(userId, name);
    return name;
  } catch {
    return userId;
  }
}

/* ── Message filtering & formatting ───────────────────── */

const SKIP_SUBTYPES = new Set([
  "channel_join",
  "channel_leave",
  "channel_topic",
  "channel_purpose",
  "channel_name",
]);

function isSkippable(msg: SlackMessage): boolean {
  if (msg.subtype && SKIP_SUBTYPES.has(msg.subtype)) return true;
  // Skip the daily MX pics bot
  if (msg.username?.includes("MX Pics Request")) return true;
  if (msg.bot_id && msg.text?.includes("Required Daily Pics")) return true;
  return false;
}

async function formatMessages(
  messages: SlackMessage[],
): Promise<string> {
  const relevant = messages.filter((m) => !isSkippable(m));
  // Chronological order (oldest first)
  relevant.reverse();

  const lines: string[] = [];
  for (const msg of relevant) {
    const who = msg.user ? await resolveUserName(msg.user) : (msg.username ?? "bot");
    const time = msg.ts
      ? new Date(Number(msg.ts) * 1000).toLocaleTimeString("en-US", {
          timeZone: "America/New_York",
          hour: "numeric",
          minute: "2-digit",
          hour12: true,
        })
      : "";
    const fileNote =
      msg.files && msg.files.length > 0
        ? ` [${msg.files.length} file(s) attached]`
        : "";
    lines.push(`[${time}] ${who}: ${msg.text ?? ""}${fileNote}`);
  }
  return lines.join("\n");
}

/* ── Anthropic summarization ──────────────────────────── */

interface TailSummaryItem {
  tail: string;
  bullets: string[];
}

async function summarizeTails(
  tailMessages: Map<string, string>,
): Promise<TailSummaryItem[]> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");

  const anthropic = new Anthropic({ apiKey });

  // Build the input block
  const inputParts: string[] = [];
  for (const [tail, transcript] of tailMessages) {
    if (!transcript.trim()) continue;
    inputParts.push(`=== ${tail} ===\n${transcript}`);
  }

  if (inputParts.length === 0) return [];

  const response = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 2048,
    system: `You are an aviation ops analyst for Baker Aviation. You review daily Slack transcripts from aircraft tail number channels and extract ONLY operationally noteworthy items.

INCLUDE:
- MX (maintenance) issues, squawks, MEL items, parts needed
- Diversions, alternates, weather delays
- EDCT delays and their impact
- Duty day concerns, crew rest issues
- Part 91 flights, DAAP flights
- Customs/CBP issues or delays
- Significant fuel issues (truck delays, shortages, abnormal prices)
- Passenger complaints or broker escalations
- Safety concerns
- Anything unusual or out of the ordinary

EXCLUDE (routine ops — skip these):
- Normal fuel stops and standard prices
- "Good morning", "copy", "thanks", casual banter, jokes
- Standard pax loaded/cranking engines/OTG updates
- MX daily pics bot messages
- Pillow/blanket/cabin supply counts
- Normal permit/handling confirmations
- Channel join/leave messages

Return valid JSON only. Format:
[{"tail":"N102VR","bullets":["Short description of noteworthy item"]}]

If a tail had NOTHING noteworthy, omit it entirely. Keep bullets concise (one sentence max). Do not editorialize or add commentary.`,
    messages: [
      {
        role: "user",
        content: `Here are today's transcripts from Baker Aviation tail channels. Extract only noteworthy operational items.\n\n${inputParts.join("\n\n")}`,
      },
    ],
  });

  const text =
    response.content[0].type === "text" ? response.content[0].text : "";

  try {
    // Extract JSON from response (handle markdown code fences)
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return [];
    return JSON.parse(jsonMatch[0]) as TailSummaryItem[];
  } catch (err) {
    console.error("[tail-summary] Failed to parse Haiku response:", text);
    return [];
  }
}

/* ── Slack message builder ────────────────────────────── */

function buildSummaryBlocks(
  items: TailSummaryItem[],
  typeMap: Map<string, string>,
): any[] {
  const today = new Date().toLocaleDateString("en-US", {
    timeZone: "America/New_York",
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  const blocks: any[] = [
    {
      type: "header",
      text: { type: "plain_text", text: `Tail Summary — ${today}`, emoji: true },
    },
    { type: "divider" },
  ];

  // Group items by aircraft type
  const groups = new Map<string, TailSummaryItem[]>();
  for (const item of items) {
    const type = typeMap.get(item.tail) ?? "Unknown";
    const list = groups.get(type) ?? [];
    list.push(item);
    groups.set(type, list);
  }

  // Sort groups: Challenger first, Citation X second, then alpha
  const sortedTypes = [...groups.keys()].sort((a, b) => {
    if (a.toLowerCase().includes("challenger") && !b.toLowerCase().includes("challenger")) return -1;
    if (!a.toLowerCase().includes("challenger") && b.toLowerCase().includes("challenger")) return 1;
    return a.localeCompare(b);
  });

  for (const type of sortedTypes) {
    const typeItems = groups.get(type)!;
    // Sort tails alphanumerically within each group
    typeItems.sort((a, b) => a.tail.localeCompare(b.tail));

    let text = `*${type}*\n`;
    for (const item of typeItems) {
      text += `\n  *${item.tail}*\n`;
      for (const bullet of item.bullets) {
        text += `    \u2022 ${bullet}\n`;
      }
    }

    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text },
    });
  }

  if (items.length === 0) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: "_All quiet across the fleet today._" },
    });
  }

  blocks.push({
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text: `_Generated at ${new Date().toLocaleString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit", hour12: true })} ET_`,
      },
    ],
  });

  return blocks;
}

/* ── Main Handler ─────────────────────────────────────── */

export async function GET(req: NextRequest) {
  if (!verifyCronSecret(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supa = createServiceClient();

  try {
    // 1. Load all aircraft with their types and channel IDs
    const { data: aircraft } = await supa
      .from("aircraft_tracker")
      .select("tail_number, aircraft_type, slack_channel_id")
      .order("tail_number");

    const allAircraft = aircraft ?? [];
    const withChannel = allAircraft.filter((a) => a.slack_channel_id);
    const missingChannel = allAircraft.filter((a) => !a.slack_channel_id);

    // 2. Build type lookup
    const typeMap = new Map<string, string>();
    for (const a of allAircraft) {
      if (a.aircraft_type) typeMap.set(a.tail_number, a.aircraft_type);
    }

    // 3. Read last 24h of messages from each tail channel (parallel with concurrency limit)
    const oldest = String(Math.floor((Date.now() - 24 * 60 * 60 * 1000) / 1000));
    const CONCURRENCY = 10;
    const tailMessages = new Map<string, string>();

    for (let i = 0; i < withChannel.length; i += CONCURRENCY) {
      const batch = withChannel.slice(i, i + CONCURRENCY);
      const results = await Promise.all(
        batch.map(async (a) => {
          const msgs = await readChannelHistory(a.slack_channel_id, oldest);
          const formatted = await formatMessages(msgs);
          return { tail: a.tail_number, text: formatted };
        }),
      );
      for (const r of results) {
        if (r.text.trim()) tailMessages.set(r.tail, r.text);
      }
    }

    console.log(`[tail-summary] Read ${tailMessages.size} channels with messages out of ${withChannel.length} total`);

    // 4. Summarize with Haiku
    const items = await summarizeTails(tailMessages);

    console.log(`[tail-summary] ${items.length} tails with noteworthy items`);

    // 5. Post summary to #tail-summary
    const blocks = buildSummaryBlocks(items, typeMap);
    await postSlackMessage({
      channel: SUMMARY_CHANNEL,
      text: `Tail Summary — ${new Date().toLocaleDateString("en-US", { timeZone: "America/New_York" })}`,
      blocks,
    });

    // 6. DM Charlie about tails missing channel IDs
    if (missingChannel.length > 0) {
      const tailList = missingChannel.map((a) => a.tail_number).join(", ");
      await postSlackMessage({
        channel: CHARLIE_DM,
        text: `Heads up — ${missingChannel.length} tail(s) in Aircraft Tracker are missing Slack channel IDs and won't appear in the daily summary:\n${tailList}\n\nAdd the channel ID in Super Admin > Aircraft Tracker.`,
      });
    }

    return NextResponse.json({
      ok: true,
      channels_read: tailMessages.size,
      noteworthy_tails: items.length,
      missing_channels: missingChannel.length,
    });
  } catch (err) {
    console.error("[tail-summary] Error:", err instanceof Error ? err.message : err);
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
  }
}
