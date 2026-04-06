import { NextRequest, NextResponse } from "next/server";
import { verifyCronSecret } from "@/lib/api-auth";
import { syncSalespersons } from "@/lib/jetinsight/schedule-sync";

export const maxDuration = 300;

/**
 * GET /api/cron/jetinsight-salespersons — 10-min cron to scrape salesperson names
 * from JetInsight trip pages for flights missing salesperson data.
 * Separated from schedule sync to avoid timeout issues.
 */
export async function GET(req: NextRequest) {
  if (!verifyCronSecret(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await syncSalespersons();

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
    console.error("[cron/jetinsight-salespersons] error:", msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
