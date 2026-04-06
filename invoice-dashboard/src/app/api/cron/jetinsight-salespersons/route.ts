import { NextRequest, NextResponse } from "next/server";
import { verifyCronSecret } from "@/lib/api-auth";
import { syncSalespersons } from "@/lib/jetinsight/schedule-sync";

export const maxDuration = 60;

const MAX_ROUNDS = 5; // Process up to 5 × 80 = 400 trips per cron cycle

/**
 * GET /api/cron/jetinsight-salespersons — 10-min cron to scrape salesperson names
 * from JetInsight trip pages for flights missing salesperson data.
 * Loops in batches of 80 trips until the queue is clear or MAX_ROUNDS is hit.
 */
export async function GET(req: NextRequest) {
  if (!verifyCronSecret(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let totalUpdated = 0;
  const allErrors: string[] = [];

  try {
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const result = await syncSalespersons();
      totalUpdated += result.updated;
      allErrors.push(...result.errors);

      if (result.sessionExpired) {
        return NextResponse.json({
          ok: false,
          error: "Session expired — Slack DM sent",
          updated: totalUpdated,
          rounds: round + 1,
          errors: allErrors,
        });
      }

      // No more work to do
      if (result.remaining === 0) break;
    }

    return NextResponse.json({
      ok: true,
      updated: totalUpdated,
      errors: allErrors,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[cron/jetinsight-salespersons] error:", msg);
    return NextResponse.json({ ok: false, error: msg, updated: totalUpdated }, { status: 500 });
  }
}
