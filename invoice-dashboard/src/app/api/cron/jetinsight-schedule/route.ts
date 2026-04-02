import { NextRequest, NextResponse } from "next/server";
import { verifyCronSecret } from "@/lib/api-auth";
import { runScheduleSync } from "@/lib/jetinsight/schedule-sync";

export const maxDuration = 60;

/**
 * GET /api/cron/jetinsight-schedule — 10-min cron to enrich flights from JetInsight JSON
 */
export async function GET(req: NextRequest) {
  if (!verifyCronSecret(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await runScheduleSync();

    if (result.sessionExpired) {
      return NextResponse.json({
        ok: false,
        error: "Session expired — Slack DM sent",
        ...result,
      });
    }

    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[cron/jetinsight-schedule] error:", msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
