import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthed } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";

export const dynamic = "force-dynamic";

/**
 * GET /api/integrations/hasdata-stats
 *
 * Returns HasData API usage stats:
 *   - totals (today, 7d, 30d)
 *   - success rate
 *   - top callers
 *   - recent calls
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;

  const supa = createServiceClient();
  const now = new Date();
  const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const monthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();

  const [todayRes, weekRes, monthRes, recentRes] = await Promise.all([
    supa
      .from("hasdata_api_log")
      .select("http_ok, result_count, caller, latency_ms", { count: "exact" })
      .gte("called_at", dayAgo),
    supa
      .from("hasdata_api_log")
      .select("id", { count: "exact", head: true })
      .gte("called_at", weekAgo),
    supa
      .from("hasdata_api_log")
      .select("id", { count: "exact", head: true })
      .gte("called_at", monthAgo),
    supa
      .from("hasdata_api_log")
      .select("called_at, endpoint, origin, destination, flight_date, caller, http_ok, result_count, latency_ms, error")
      .order("called_at", { ascending: false })
      .limit(50),
  ]);

  const todayRows = todayRes.data ?? [];
  const todayCount = todayRes.count ?? 0;
  const successfulToday = todayRows.filter((r) => r.http_ok).length;
  const successRate = todayCount > 0 ? successfulToday / todayCount : null;

  const callerCounts: Record<string, number> = {};
  for (const r of todayRows) {
    const key = r.caller ?? "(unknown)";
    callerCounts[key] = (callerCounts[key] ?? 0) + 1;
  }
  const topCallers = Object.entries(callerCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([caller, count]) => ({ caller, count }));

  const avgLatency = todayRows.length
    ? Math.round(todayRows.reduce((sum, r) => sum + (r.latency_ms ?? 0), 0) / todayRows.length)
    : null;

  return NextResponse.json({
    totals: {
      today: todayCount,
      last7d: weekRes.count ?? 0,
      last30d: monthRes.count ?? 0,
    },
    successRateToday: successRate,
    avgLatencyMsToday: avgLatency,
    topCallersToday: topCallers,
    recent: recentRes.data ?? [],
  });
}
