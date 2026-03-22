import { NextRequest, NextResponse } from "next/server";
import { verifyCronSecret } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";
import { parseVolunteerText, matchSlackUserToCrew } from "@/lib/volunteerParser";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * GET /api/cron/parse-volunteers
 *
 * Called by Vercel Cron at midnight UTC Monday (8pm ET Sunday).
 * Finds the latest "Volunteer Pilots" thread in #pilots, parses replies,
 * and upserts into volunteer_responses.
 *
 * Also callable via POST from /api/crew/volunteers for manual re-parsing.
 */
export async function GET(req: NextRequest) {
  if (!verifyCronSecret(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return runParser();
}

// Exported for use by the manual trigger endpoint
export async function runParser(overrideSwapDate?: string) {
  const slackToken = process.env.SLACK_BOT_TOKEN;
  if (!slackToken) {
    return NextResponse.json({ error: "SLACK_BOT_TOKEN not configured" }, { status: 503 });
  }

  const PILOTS_CHANNEL = "C04AM137PEE";
  const supa = createServiceClient();

  // Determine swap date: next Wednesday from now (or override)
  const swapDate = overrideSwapDate ?? getNextWednesday();

  // Step 1: Find the "Volunteer Pilots" thread in #pilots
  // Look at recent messages (last 7 days) for the thread starter
  const weekAgo = Math.floor((Date.now() - 7 * 86400_000) / 1000);
  const historyRes = await slackApi(slackToken, "conversations.history", {
    channel: PILOTS_CHANNEL,
    oldest: String(weekAgo),
    limit: "50",
  });

  if (!historyRes.ok) {
    return NextResponse.json(
      { error: `Slack API error: ${historyRes.error}` },
      { status: 502 },
    );
  }

  // Find the LATEST bot/workflow message containing "Volunteer Pilots"
  // conversations.history returns newest-first, but with `oldest` param it's oldest-first.
  // Reverse to search newest-first so we get this week's thread, not last week's.
  const messages = ((historyRes.messages ?? []) as SlackMessage[]).reverse();
  const volunteerThread = messages.find((m) => {
    const searchText = [
      m.text,
      // Workflow bot messages store text in blocks
      ...(m.blocks ?? []).flatMap((b: Record<string, unknown>) => {
        const elems = (b.elements ?? []) as Record<string, unknown>[];
        return elems.flatMap((e) => {
          const inner = (e.elements ?? []) as Record<string, unknown>[];
          return inner.map((el) => (el.text as string) ?? "");
        });
      }),
      // Also check attachments
      ...(m.attachments ?? []).map((a: Record<string, unknown>) => (a.text as string) ?? ""),
    ].join(" ");
    return /volunteer\s*pilot/i.test(searchText) || /volunteer.*stay late|volunteer.*start early/i.test(searchText);
  });

  if (!volunteerThread) {
    return NextResponse.json({
      ok: true,
      parsed: 0,
      matched: 0,
      unknown: 0,
      message: "No 'Volunteer Pilots' thread found in last 7 days",
    });
  }

  const threadTs = volunteerThread.ts;

  // Step 2: Fetch all thread replies
  const repliesRes = await slackApi(slackToken, "conversations.replies", {
    channel: PILOTS_CHANNEL,
    ts: threadTs,
    limit: "200",
  });

  if (!repliesRes.ok) {
    return NextResponse.json(
      { error: `Slack replies error: ${repliesRes.error}` },
      { status: 502 },
    );
  }

  const replies = ((repliesRes.messages ?? []) as SlackMessage[]).filter(
    (m) => m.ts !== threadTs, // exclude the parent message
  );

  if (replies.length === 0) {
    return NextResponse.json({
      ok: true,
      parsed: 0,
      matched: 0,
      unknown: 0,
      message: "Thread found but no replies yet",
    });
  }

  // Step 3: Load crew members for matching
  const { data: crewMembers } = await supa
    .from("crew_members")
    .select("id, name, slack_user_id")
    .eq("active", true);

  const crew = crewMembers ?? [];

  // Step 4: Parse each reply and resolve Slack user
  const rows: VolunteerRow[] = [];

  for (const reply of replies) {
    const text = reply.text ?? "";
    const userId = reply.user ?? "";
    if (!userId || !text.trim()) continue;

    // Get Slack display name for fuzzy matching
    const displayName = await getSlackDisplayName(slackToken, userId);

    const { preference, notes } = parseVolunteerText(text);
    const crewMemberId = matchSlackUserToCrew(userId, displayName, crew);

    rows.push({
      swap_date: swapDate,
      slack_user_id: userId,
      crew_member_id: crewMemberId,
      raw_text: text,
      parsed_preference: preference,
      notes,
      thread_ts: threadTs,
    });
  }

  // Step 5: Upsert into volunteer_responses
  if (rows.length > 0) {
    const { error } = await supa
      .from("volunteer_responses")
      .upsert(rows, { onConflict: "swap_date,slack_user_id" });

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
  }

  const matched = rows.filter((r) => r.crew_member_id).length;
  const unknown = rows.filter((r) => r.parsed_preference === "unknown").length;

  return NextResponse.json({
    ok: true,
    swap_date: swapDate,
    parsed: rows.length,
    matched,
    unknown,
    thread_ts: threadTs,
  });
}

// ─── Helpers ────────────────────────────────────────────────────────────────

type VolunteerRow = {
  swap_date: string;
  slack_user_id: string;
  crew_member_id: string | null;
  raw_text: string;
  parsed_preference: string;
  notes: string | null;
  thread_ts: string;
};

type SlackMessage = {
  ts: string;
  text?: string;
  user?: string;
  bot_id?: string;
  blocks?: Record<string, unknown>[];
  attachments?: Record<string, unknown>[];
};

// In-memory cache for Slack user profiles (lasts the request lifecycle)
const userNameCache = new Map<string, string>();

async function getSlackDisplayName(token: string, userId: string): Promise<string> {
  if (userNameCache.has(userId)) return userNameCache.get(userId)!;

  try {
    const res = await slackApi(token, "users.info", { user: userId });
    const user = res.user as Record<string, unknown> | undefined;
    const profile = user?.profile as Record<string, unknown> | undefined;
    const name =
      (profile?.real_name as string) ??
      (profile?.display_name as string) ??
      (user?.real_name as string) ??
      "";
    userNameCache.set(userId, name);
    return name;
  } catch {
    return "";
  }
}

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

function getNextWednesday(): string {
  const now = new Date();
  const day = now.getUTCDay();
  const daysUntilWed = (3 - day + 7) % 7 || 7; // next Wednesday, not today
  const wed = new Date(now.getTime() + daysUntilWed * 86400_000);
  return wed.toISOString().slice(0, 10);
}
