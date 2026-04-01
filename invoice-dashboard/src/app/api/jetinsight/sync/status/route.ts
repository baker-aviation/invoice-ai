import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { requireAdmin } from "@/lib/api-auth";

/**
 * GET /api/jetinsight/sync/status — Recent sync runs
 */
export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req);
  if ("error" in auth) return auth.error;

  const limit = Number(req.nextUrl.searchParams.get("limit")) || 20;

  const supa = createServiceClient();
  const { data, error } = await supa
    .from("jetinsight_sync_runs")
    .select("*")
    .order("started_at", { ascending: false })
    .limit(limit);

  if (error) {
    console.error("[jetinsight/sync/status] error:", error);
    return NextResponse.json(
      { error: "Failed to fetch sync runs" },
      { status: 500 },
    );
  }

  return NextResponse.json({ runs: data });
}
