import { NextRequest, NextResponse } from "next/server";
import { verifyCronSecret, requireAdmin, isAuthed } from "@/lib/api-auth";
import { runScheduleSync } from "@/lib/jetinsight/schedule-sync";
import { runGameDayPipeline, type GameDayResult } from "@/lib/gameday/pipeline";

export const maxDuration = 120;

async function sync() {
  const result = await runScheduleSync();
  if (result.sessionExpired) {
    return NextResponse.json({
      ok: false,
      error: "Session expired — Slack DM sent",
      ...result,
    });
  }

  // Run Game Day pipeline if schedule changes were detected
  let gameDayResult: GameDayResult | null = null;
  const alertsCreated = result.changeDetection?.alerts_created ?? 0;
  if (alertsCreated > 0) {
    try {
      gameDayResult = await runGameDayPipeline();
    } catch (err) {
      console.error("[GameDay] pipeline error:", err);
    }
  }

  return NextResponse.json({ ok: true, ...result, gameday: gameDayResult });
}

/**
 * GET /api/cron/jetinsight-schedule — 10-min cron to sync flights from JetInsight JSON.
 */
export async function GET(req: NextRequest) {
  if (!verifyCronSecret(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    return await sync();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[cron/jetinsight-schedule] error:", msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}

/**
 * POST /api/cron/jetinsight-schedule — Manual trigger from dashboard (Resync JI button).
 */
export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (!isAuthed(auth)) return auth.error;

  try {
    return await sync();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[jetinsight-schedule] manual sync error:", msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
