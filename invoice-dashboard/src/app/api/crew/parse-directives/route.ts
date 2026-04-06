import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, isAuthed } from "@/lib/api-auth";
import Anthropic from "@anthropic-ai/sdk";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

// ─── Types ──────────────────────────────────────────────────────────────────

type SlackMessage = {
  ts: string;
  text?: string;
  user?: string;
  reply_count?: number;
  thread_ts?: string;
};

type DirectiveConstraint =
  | { type: "force_tail"; crew_name: string; tail: string; reason?: string }
  | { type: "force_pair"; crew_a: string; crew_b: string; reason?: string }
  | { type: "force_fleet"; crew_name: string; aircraft_type: string; reason?: string };

// ─── Slack helpers (same pattern as parse-volunteers) ───────────────────────

async function slackApi(
  token: string,
  method: string,
  params: Record<string, string>,
): Promise<Record<string, unknown>> {
  const qs = new URLSearchParams(params);
  const res = await fetch(`https://slack.com/api/${method}?${qs}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10000),
  });
  return res.json() as Promise<Record<string, unknown>>;
}

// In-memory cache for Slack user profiles (lasts the request lifecycle)
const userNameCache = new Map<string, string>();

async function resolveSlackUser(token: string, userId: string): Promise<string> {
  if (userNameCache.has(userId)) return userNameCache.get(userId)!;
  try {
    const res = await slackApi(token, "users.info", { user: userId });
    const user = res.user as Record<string, unknown> | undefined;
    const profile = user?.profile as Record<string, unknown> | undefined;
    const name =
      (profile?.real_name as string) ??
      (profile?.display_name as string) ??
      (user?.real_name as string) ??
      userId;
    userNameCache.set(userId, name);
    return name;
  } catch {
    userNameCache.set(userId, userId);
    return userId;
  }
}

async function resolveUserMentions(token: string, text: string): Promise<string> {
  const mentionRegex = /<@(U[A-Z0-9]+)>/g;
  const matches = [...text.matchAll(mentionRegex)];
  if (matches.length === 0) return text;

  let resolved = text;
  // Resolve all unique user IDs
  const uniqueIds = [...new Set(matches.map((m) => m[1]))];
  await Promise.all(uniqueIds.map((id) => resolveSlackUser(token, id)));

  for (const id of uniqueIds) {
    const name = userNameCache.get(id) ?? id;
    resolved = resolved.replaceAll(`<@${id}>`, name);
  }
  return resolved;
}

// ─── Main handler ───────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (!isAuthed(auth)) return auth.error;

  const slackToken = process.env.SLACK_BOT_TOKEN;
  if (!slackToken) {
    return NextResponse.json({ error: "SLACK_BOT_TOKEN not configured" }, { status: 503 });
  }

  let body: { swap_date?: string; lookback_hours?: number };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const swapDate = body.swap_date;
  if (!swapDate || !/^\d{4}-\d{2}-\d{2}$/.test(swapDate)) {
    return NextResponse.json({ error: "swap_date required (YYYY-MM-DD)" }, { status: 400 });
  }

  const lookbackHours = body.lookback_hours ?? 72;
  const SWAP_CHAT_CHANNEL = "C093LK6FGDS";

  try {
    // Step 1: Fetch recent messages from swap chat channel
    const oldestTs = String(Math.floor(Date.now() / 1000) - lookbackHours * 3600);

    const historyRes = await slackApi(slackToken, "conversations.history", {
      channel: SWAP_CHAT_CHANNEL,
      oldest: oldestTs,
      limit: "200",
    });

    if (!historyRes.ok) {
      return NextResponse.json(
        { error: `Slack API error: ${historyRes.error}`, directives: [], message_count: 0, channel: SWAP_CHAT_CHANNEL },
        { status: 502 },
      );
    }

    const messages = (historyRes.messages ?? []) as SlackMessage[];

    // Step 2: Fetch thread replies for messages with replies
    const threadsToFetch = messages.filter((m) => (m.reply_count ?? 0) > 0);
    const threadReplies: SlackMessage[] = [];

    await Promise.all(
      threadsToFetch.map(async (m) => {
        try {
          const repliesRes = await slackApi(slackToken, "conversations.replies", {
            channel: SWAP_CHAT_CHANNEL,
            ts: m.ts,
            limit: "100",
          });
          if (repliesRes.ok) {
            const replies = (repliesRes.messages ?? []) as SlackMessage[];
            // Exclude the parent message (already in messages array)
            threadReplies.push(...replies.filter((r) => r.ts !== m.ts));
          }
        } catch {
          // Skip failed thread fetches
        }
      }),
    );

    // Step 3: Combine all messages, resolve user mentions
    const allMessages = [...messages, ...threadReplies];
    const messageCount = allMessages.length;

    if (messageCount === 0) {
      return NextResponse.json({
        directives: [],
        message_count: 0,
        channel: SWAP_CHAT_CHANNEL,
      });
    }

    // Sort by timestamp and build text block
    allMessages.sort((a, b) => parseFloat(a.ts) - parseFloat(b.ts));

    const messageLines: string[] = [];
    for (const msg of allMessages) {
      if (!msg.text?.trim()) continue;
      const resolvedText = await resolveUserMentions(slackToken, msg.text);
      const time = new Date(parseFloat(msg.ts) * 1000).toISOString().slice(0, 16).replace("T", " ");
      const userName = msg.user ? await resolveSlackUser(slackToken, msg.user) : "unknown";
      messageLines.push(`[${time}] ${userName}: ${resolvedText}`);
    }

    const messageBlock = messageLines.join("\n");

    if (!messageBlock.trim()) {
      return NextResponse.json({
        directives: [],
        message_count: messageCount,
        channel: SWAP_CHAT_CHANNEL,
      });
    }

    // Step 4: Send to Claude for directive extraction
    const anthropic = new Anthropic();

    const systemPrompt = `You are analyzing Slack messages from a crew swap planning channel at an aviation company.
Extract any directives about crew assignments. Look for patterns like:
- "Send [crew] to [tail/airport]" → force_tail
- "[Crew A] with [Crew B]" or "[Crew A] needs to go out with [Crew B]" → force_pair
- "Put [crew] on CL/CX/Challenger/Citation" → force_fleet
- "[Crew] to [tail number like N###XX]" → force_tail

Return a JSON array of constraints. Each constraint should have:
- type: "force_tail" | "force_pair" | "force_fleet"
- The relevant fields (crew_name, tail, crew_a, crew_b, aircraft_type)
- reason: brief quote from the message that triggered this

Only extract CLEAR directives. Ignore casual discussion, questions, or hypotheticals.
If no directives are found, return an empty array.

Return ONLY valid JSON, no markdown or explanation.`;

    const aiResponse = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 2048,
      system: systemPrompt,
      messages: [
        {
          role: "user",
          content: `Here are the recent Slack messages from the crew swap chat (swap date: ${swapDate}):\n\n${messageBlock}`,
        },
      ],
    });

    // Extract text from response
    const responseText = aiResponse.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("");

    // Step 5: Parse and validate the AI response
    let directives: DirectiveConstraint[] = [];
    try {
      const parsed = JSON.parse(responseText);
      if (Array.isArray(parsed)) {
        directives = parsed.filter((item): item is DirectiveConstraint => {
          if (!item || typeof item !== "object" || !item.type) return false;
          if (item.type === "force_tail") {
            return typeof item.crew_name === "string" && typeof item.tail === "string";
          }
          if (item.type === "force_pair") {
            return typeof item.crew_a === "string" && typeof item.crew_b === "string";
          }
          if (item.type === "force_fleet") {
            return typeof item.crew_name === "string" && typeof item.aircraft_type === "string";
          }
          return false;
        });
      }
    } catch {
      console.error("[parse-directives] Failed to parse AI response:", responseText.slice(0, 500));
      // Return empty directives rather than failing entirely
    }

    return NextResponse.json({
      directives,
      message_count: messageCount,
      channel: SWAP_CHAT_CHANNEL,
    });
  } catch (e) {
    console.error("[parse-directives] Error:", e);
    return NextResponse.json(
      {
        error: e instanceof Error ? e.message : "Failed to parse directives",
        directives: [],
        message_count: 0,
        channel: SWAP_CHAT_CHANNEL,
      },
      { status: 500 },
    );
  }
}
