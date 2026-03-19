import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthed, isRateLimited } from "@/lib/api-auth";
import { buildVanSlackHeaderBlocks, buildAircraftSlackBlocks, buildVanSlackFallbackText, buildAircraftFallbackText, buildVanChangeBlocks, buildVanChangeFallbackText, type VanSlackItem, type VanChangeDiff } from "@/lib/vanSlackBlocks";

/**
 * POST /api/vans/share-slack-bulk
 *
 * Posts all van schedules to Slack in one call.
 * Each van posts to its mapped channel (falls back to SLACK_VAN_DEFAULT_CHANNEL).
 *
 * Body: { date: string, vans: [{ vanName, vanId, homeAirport, items }] }
 */

// Van ID → Slack channel mapping
const VAN_CHANNEL_MAP: Record<number, string> = {
  1:  "C0926JC8J72", // aog-fl-opf-pbi-vans (South FL East)
  2:  "C0926JC8J72", // aog-fl-opf-pbi-vans (South FL East)
  3:  "C0AG76ULCDV", // aog-fl-apf-van (South FL West)
  4:  "C0926JG5X1N", // aog-ny-van (NY/NJ TEB)
  5:  "C0926JG5X1N", // aog-ny-van (NY/NJ HPN)
  6:  "C0ADV5DDLT0", // aog-ma-bed-bos-van
  7:  "C091J8J83D0", // aog-ca-socal-van
  8:  "C0AF75FTGKF", // aog-ca-sfo-van
  9:  "C091W2Y516Z", // aog-tx-van (Dallas/FW)
  10: "C0AH8V2BL6Q", // aog-tx-hou-van
  11: "C0AG51CUNFP", // aog-il-chicago-van
  12: "C093F0L5CGZ", // aog-nc-buy-van
  13: "C0AJ4PGRYUR", // aog-dc-iad-van
  14: "C0AG4GR5UUU", // aog-co-van
  15: "C09RS21Q2QL", // aog-az-van
  16: "C0AH5S11SHE", // aog-ut-slc-van
};

type BulkVan = {
  vanName: string;
  vanId: number;
  homeAirport: string;
  channel?: string; // per-van channel override
  items: VanSlackItem[];
  diff?: VanChangeDiff; // provided when mode === "update"
};

type BulkBody = {
  date: string;
  vans: BulkVan[];
  test?: boolean; // when true, send all to default test channel
  mode?: "morning" | "update"; // "morning" = full summary (default), "update" = change diff only
};

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;

  if (await isRateLimited(auth.userId, 10)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) {
    return NextResponse.json(
      { error: "SLACK_BOT_TOKEN not configured — add it to Vercel env vars" },
      { status: 503 },
    );
  }

  const defaultChannel = process.env.SLACK_VAN_DEFAULT_CHANNEL ?? "C0AH20JU68J";

  let body: BulkBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { date, vans, mode = "morning" } = body;
  if (!date || !Array.isArray(vans) || vans.length === 0) {
    return NextResponse.json({ error: "Missing date or vans array" }, { status: 400 });
  }

  const results: { vanId: number; ok: boolean; error?: string }[] = [];

  const isTest = body.test === true;

  const postMessage = async (payload: Record<string, unknown>) => {
    const res = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    return res.json();
  };

  for (const van of vans) {
    const channel = isTest ? defaultChannel : (van.channel ?? VAN_CHANNEL_MAP[van.vanId] ?? defaultChannel);

    try {
      // ── Update mode: post change summary only ──
      if (mode === "update" && van.diff) {
        const changeData = await postMessage({
          channel,
          text: buildVanChangeFallbackText(van.vanName, date),
          blocks: buildVanChangeBlocks(van.vanName, van.vanId, date, van.diff),
        });
        results.push({ vanId: van.vanId, ok: changeData.ok, error: changeData.ok ? undefined : (changeData.error ?? "Slack API error") });
        continue;
      }

      // ── Morning mode (default): full schedule summary ──
      if (van.items.length === 0) {
        // No aircraft assigned — send a simple "check in" message
        const noAcData = await postMessage({
          channel,
          text: `No Aircraft schedule for ${date} — Check in for tasking`,
          blocks: [
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: `*${van.vanName} (V${van.vanId})* — ${date}\n✅ No Aircraft scheduled. Check in for tasking.`,
              },
            },
          ],
        });
        results.push({ vanId: van.vanId, ok: noAcData.ok, error: noAcData.ok ? undefined : (noAcData.error ?? "Slack API error") });
        continue;
      }

      // 1) Header message
      const headerData = await postMessage({
        channel,
        text: buildVanSlackFallbackText(van.vanName, date),
        blocks: buildVanSlackHeaderBlocks(van.vanName, van.vanId, van.homeAirport, date, van.items.length),
      });
      if (!headerData.ok) {
        results.push({ vanId: van.vanId, ok: false, error: headerData.error ?? "Slack API error" });
        continue;
      }

      // 2) Each aircraft as its own top-level message
      for (const item of van.items) {
        await postMessage({
          channel,
          text: buildAircraftFallbackText(item),
          blocks: buildAircraftSlackBlocks(item),
        });
      }

      results.push({ vanId: van.vanId, ok: true });
    } catch (err) {
      results.push({ vanId: van.vanId, ok: false, error: "Slack API request failed" });
    }
  }

  const allOk = results.every((r) => r.ok);
  return NextResponse.json({ ok: allOk, results });
}
