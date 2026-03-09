import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, isRateLimited } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";

/**
 * GET /api/admin/trip-notifications/summary-log
 *
 * Returns recent daily evening summary send history.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req);
  if ("error" in auth) return auth.error;
  if (isRateLimited(auth.userId, 10)) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const supa = createServiceClient();

  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await supa
    .from("salesperson_summary_sent")
    .select("id, salesperson_name, summary_date, leg_count, sent_at")
    .gte("sent_at", since)
    .order("sent_at", { ascending: false })
    .limit(100);

  if (error) {
    return NextResponse.json({ error: "Failed to query summary log", detail: error.message }, { status: 500 });
  }

  return NextResponse.json({ summaries: data ?? [] });
}
