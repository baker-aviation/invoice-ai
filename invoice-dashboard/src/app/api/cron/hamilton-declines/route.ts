import { NextRequest, NextResponse } from "next/server";
import { syncDeclines } from "@/lib/hamilton/scraper";
import { verifyCronSecret } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";

export const maxDuration = 120;

/**
 * POST /api/cron/hamilton-declines — Sync declined trips from Hamilton
 *
 * Runs every 10 minutes. Fetches 1 page (200 trips) per run, tracking
 * the cursor in hamilton_config so it picks up where it left off.
 * When it reaches the last page, resets to page 0 for a fresh sweep.
 */
export async function POST(req: NextRequest) {
  if (!verifyCronSecret(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supa = createServiceClient();

  // Read cursor state
  const { data: cursorRow } = await supa
    .from("hamilton_config")
    .select("config_value")
    .eq("config_key", "sync_cursor")
    .single();

  let cursor = { page: 0, dateFrom: "" };
  if (cursorRow?.config_value) {
    try {
      cursor = JSON.parse(cursorRow.config_value);
    } catch { /* start fresh */ }
  }

  // Default dateFrom: 30 days ago
  if (!cursor.dateFrom) {
    cursor.dateFrom = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
      .toISOString()
      .split("T")[0];
  }

  try {
    const result = await syncDeclines(cursor.dateFrom, cursor.page);

    // Calculate next cursor
    const totalPages = Math.ceil(result.totalDeclines / 200);
    const nextPage = result.nextPage;
    const reachedEnd = nextPage >= totalPages || result.tripsUpserted === 0;

    // If we reached the end, reset to page 0 with fresh date
    const nextCursor = reachedEnd
      ? {
          page: 0,
          dateFrom: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
            .toISOString()
            .split("T")[0],
        }
      : { page: nextPage, dateFrom: cursor.dateFrom };

    // Save cursor
    await supa.from("hamilton_config").upsert(
      {
        config_key: "sync_cursor",
        config_value: JSON.stringify(nextCursor),
        updated_at: new Date().toISOString(),
      },
      { onConflict: "config_key" },
    );

    console.log(
      `[hamilton-declines] Page ${cursor.page}: ${result.tripsUpserted} upserted, ` +
        `${result.totalDeclines} total, next=${nextCursor.page}` +
        (reachedEnd ? " (CYCLE COMPLETE)" : "") +
        (result.sessionExpired ? " (SESSION EXPIRED)" : ""),
    );

    return NextResponse.json({
      ...result,
      cursor: nextCursor,
      cycleComplete: reachedEnd,
    });
  } catch (err: unknown) {
    console.error("[hamilton-declines] sync error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 },
    );
  }
}
