import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";

/**
 * GET /api/hamilton/agents — List all known sales agent name mappings
 * PUT /api/hamilton/agents — Upsert agent name mapping { agentId, name }
 */

export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req);
  if ("error" in auth) return auth.error;

  const supa = createServiceClient();
  const { data, error } = await supa
    .from("hamilton_sales_agents")
    .select("agent_id, agent_name, updated_at")
    .order("agent_name");

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ agents: data });
}

export async function PUT(req: NextRequest) {
  const auth = await requireAdmin(req);
  if ("error" in auth) return auth.error;

  let body: { agentId?: string; name?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!body.agentId || !body.name) {
    return NextResponse.json(
      { error: "agentId and name are required" },
      { status: 400 },
    );
  }

  const supa = createServiceClient();
  const { error } = await supa.from("hamilton_sales_agents").upsert(
    {
      agent_id: body.agentId,
      agent_name: body.name,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "agent_id" },
  );

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
