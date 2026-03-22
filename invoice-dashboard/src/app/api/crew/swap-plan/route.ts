import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, isAuthed } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";

export const dynamic = "force-dynamic";

/**
 * GET /api/crew/swap-plan?swap_date=2026-03-25
 * Returns active plan for the swap date.
 * Add &version=all to get full version history.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (!isAuthed(auth)) return auth.error;

  const swapDate = req.nextUrl.searchParams.get("swap_date");
  if (!swapDate) {
    return NextResponse.json({ error: "swap_date required" }, { status: 400 });
  }

  const supa = createServiceClient();
  const allVersions = req.nextUrl.searchParams.get("version") === "all";

  if (allVersions) {
    const { data, error } = await supa
      .from("swap_plans")
      .select("id, swap_date, version, status, total_cost, solved_count, unsolved_count, strategy, created_by, created_at, notes")
      .eq("swap_date", swapDate)
      .order("version", { ascending: false });

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ versions: data ?? [] });
  }

  // Return active plan with full plan_data
  const { data, error } = await supa
    .from("swap_plans")
    .select("*")
    .eq("swap_date", swapDate)
    .eq("status", "active")
    .maybeSingle();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ plan: null });

  // Also fetch unresolved impacts
  const { data: impacts } = await supa
    .from("swap_plan_impacts")
    .select("*")
    .eq("swap_plan_id", data.id)
    .eq("resolved", false);

  return NextResponse.json({
    plan: data,
    impacts: impacts ?? [],
    impact_summary: {
      critical: (impacts ?? []).filter((i) => i.severity === "critical").length,
      warning: (impacts ?? []).filter((i) => i.severity === "warning").length,
      info: (impacts ?? []).filter((i) => i.severity === "info").length,
      total: (impacts ?? []).length,
    },
  });
}

/**
 * POST /api/crew/swap-plan
 * Save a new plan version. Marks the previous active plan as superseded.
 */
export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (!isAuthed(auth)) return auth.error;

  const body = await req.json();
  const { swap_date, plan_data, swap_assignments, oncoming_pool, strategy, notes } = body;

  if (!swap_date || !plan_data) {
    return NextResponse.json({ error: "swap_date and plan_data required" }, { status: 400 });
  }

  const supa = createServiceClient();

  // Find current active plan to determine next version
  const { data: current } = await supa
    .from("swap_plans")
    .select("id, version")
    .eq("swap_date", swap_date)
    .eq("status", "active")
    .maybeSingle();

  const nextVersion = current ? current.version + 1 : 1;

  // Mark previous as superseded
  if (current) {
    const { error: updateErr } = await supa
      .from("swap_plans")
      .update({ status: "superseded" })
      .eq("id", current.id);

    if (updateErr) {
      return NextResponse.json({ error: updateErr.message }, { status: 500 });
    }
  }

  // Insert new active plan
  const { data: newPlan, error: insertErr } = await supa
    .from("swap_plans")
    .insert({
      swap_date,
      version: nextVersion,
      status: "active",
      plan_data,
      swap_assignments: swap_assignments ?? null,
      oncoming_pool: oncoming_pool ?? null,
      strategy: strategy ?? null,
      total_cost: plan_data.total_cost ?? null,
      solved_count: plan_data.solved_count ?? null,
      unsolved_count: plan_data.unsolved_count ?? null,
      created_by: auth.email ?? null,
      notes: notes ?? null,
    })
    .select("id, version, created_at")
    .single();

  if (insertErr) {
    return NextResponse.json({ error: insertErr.message }, { status: 500 });
  }

  // Auto-acknowledge all unacknowledged flight change alerts for this swap date.
  // Once a plan is saved, the alerts are "consumed" — future changes will create new alerts.
  await supa
    .from("swap_leg_alerts")
    .update({ acknowledged: true, acknowledged_by: auth.email, acknowledged_at: new Date().toISOString() })
    .eq("swap_date", swap_date)
    .eq("acknowledged", false);

  // Increment standby_count for crew on standby (rotation tracking)
  const crewAssignment = plan_data?.crew_assignment;
  if (crewAssignment?.standby) {
    const standbyNames = [
      ...(crewAssignment.standby.pic ?? []),
      ...(crewAssignment.standby.sic ?? []),
    ];
    for (const name of standbyNames) {
      const { data: crew } = await supa
        .from("crew_members")
        .select("id, standby_count")
        .eq("name", name)
        .maybeSingle();
      if (crew) {
        await supa
          .from("crew_members")
          .update({ standby_count: ((crew.standby_count as number) ?? 0) + 1 })
          .eq("id", crew.id);
      }
    }
  }

  return NextResponse.json({
    ok: true,
    id: newPlan.id,
    version: newPlan.version,
    created_at: newPlan.created_at,
  });
}
