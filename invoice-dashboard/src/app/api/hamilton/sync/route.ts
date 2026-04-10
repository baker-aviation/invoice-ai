import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api-auth";
import { syncDeclines } from "@/lib/hamilton/scraper";

export const maxDuration = 120;

/**
 * POST /api/hamilton/sync — Manually trigger a Hamilton decline sync
 *
 * Body: { dateFrom?: string } — YYYY-MM-DD, defaults to 7 days ago
 */
export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if ("error" in auth) return auth.error;

  let dateFrom: string;
  try {
    const body = await req.json().catch(() => ({}));
    dateFrom =
      body.dateFrom ??
      new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
        .toISOString()
        .split("T")[0];
  } catch {
    dateFrom = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
      .toISOString()
      .split("T")[0];
  }

  const test = new URL(req.url).searchParams.get("test");

  try {
    if (test) {
      const { fetchDeclinedTrips } = await import("@/lib/hamilton/scraper");
      const { trips, total, sessionExpired } = await fetchDeclinedTrips(dateFrom, 1);
      return NextResponse.json({
        test: true,
        sessionExpired,
        total,
        firstTrip: trips[0]
          ? {
              id: trips[0].id,
              displayCode: trips[0].displayCode,
              salesAgentId: trips[0].salesAgentId,
              lowestPrice: trips[0].lowestPrice,
            }
          : null,
      });
    }

    const result = await syncDeclines(dateFrom);
    return NextResponse.json(result);
  } catch (err: unknown) {
    console.error("[hamilton/sync] error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 },
    );
  }
}
