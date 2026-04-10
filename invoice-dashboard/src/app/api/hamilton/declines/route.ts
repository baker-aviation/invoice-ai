import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";

/**
 * GET /api/hamilton/declines — Query declined trips from local DB
 *
 * Query params:
 *   dateFrom — filter by departure date (YYYY-MM-DD)
 *   dateTo — filter by departure date (YYYY-MM-DD)
 *   agentId — filter by sales agent UUID
 *   limit — max rows (default 500)
 */

export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req);
  if ("error" in auth) return auth.error;

  const { searchParams } = new URL(req.url);
  const dateFrom = searchParams.get("dateFrom");
  const dateTo = searchParams.get("dateTo");
  const agentId = searchParams.get("agentId");
  const limit = Math.min(Number(searchParams.get("limit") ?? 500), 2000);

  const supa = createServiceClient();

  // Get summary by agent
  let summaryQuery = supa
    .from("hamilton_declined_trips")
    .select("sales_agent_id, lowest_price");

  if (dateFrom) summaryQuery = summaryQuery.gte("departure_date", dateFrom);
  if (dateTo) summaryQuery = summaryQuery.lte("departure_date", dateTo);
  if (agentId) summaryQuery = summaryQuery.eq("sales_agent_id", agentId);

  const { data: raw, error: rawErr } = await summaryQuery;

  if (rawErr) {
    return NextResponse.json({ error: rawErr.message }, { status: 500 });
  }

  // Build agent summary
  const agentMap: Record<string, { count: number; totalValue: number }> = {};
  for (const row of raw ?? []) {
    const id = row.sales_agent_id;
    if (!agentMap[id]) agentMap[id] = { count: 0, totalValue: 0 };
    agentMap[id].count++;
    agentMap[id].totalValue += row.lowest_price ?? 0;
  }

  // Get agent name mappings
  const { data: agentRows } = await supa
    .from("hamilton_sales_agents")
    .select("agent_id, agent_name");

  const agentNames: Record<string, string> = {};
  for (const row of agentRows ?? []) {
    agentNames[row.agent_id] = row.agent_name;
  }

  const agentSummary = Object.entries(agentMap)
    .map(([id, stats]) => ({
      salesAgentId: id,
      salesAgentName: agentNames[id] ?? null,
      ...stats,
    }))
    .sort((a, b) => b.count - a.count);

  // Get individual trips
  let tripsQuery = supa
    .from("hamilton_declined_trips")
    .select("*")
    .order("departure_date", { ascending: false })
    .limit(limit);

  if (dateFrom) tripsQuery = tripsQuery.gte("departure_date", dateFrom);
  if (dateTo) tripsQuery = tripsQuery.lte("departure_date", dateTo);
  if (agentId) tripsQuery = tripsQuery.eq("sales_agent_id", agentId);

  const { data: trips, error: tripsErr } = await tripsQuery;

  if (tripsErr) {
    return NextResponse.json({ error: tripsErr.message }, { status: 500 });
  }

  return NextResponse.json({
    totalDeclines: raw?.length ?? 0,
    agentSummary,
    trips,
  });
}
