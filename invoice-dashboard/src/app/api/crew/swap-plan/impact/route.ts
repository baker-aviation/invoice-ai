import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, isAuthed } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";
import { analyzeAlertImpact, type PlanImpact } from "@/lib/swapPlanImpact";

export const dynamic = "force-dynamic";

/**
 * POST /api/crew/swap-plan/impact
 * Body: { swap_date: "2026-03-25" }
 * Runs impact analysis: cross-references unacknowledged alerts against the active plan.
 * Upserts results into swap_plan_impacts.
 */
export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (!isAuthed(auth)) return auth.error;

  const body = await req.json();
  const { swap_date } = body;
  if (!swap_date) {
    return NextResponse.json({ error: "swap_date required" }, { status: 400 });
  }

  const supa = createServiceClient();

  // Load active plan
  const { data: plan, error: planErr } = await supa
    .from("swap_plans")
    .select("id, plan_data, created_at")
    .eq("swap_date", swap_date)
    .eq("status", "active")
    .maybeSingle();

  if (planErr) return NextResponse.json({ error: planErr.message }, { status: 500 });
  if (!plan) return NextResponse.json({ error: "No active plan for this date" }, { status: 404 });

  // Load unacknowledged alerts that were detected AFTER the plan was saved.
  // Alerts from before the plan was created are stale — the plan already accounts for them.
  const { data: alerts, error: alertErr } = await supa
    .from("swap_leg_alerts")
    .select("*")
    .eq("swap_date", swap_date)
    .eq("acknowledged", false)
    .gt("detected_at", plan.created_at as string);

  if (alertErr) return NextResponse.json({ error: alertErr.message }, { status: 500 });
  if (!alerts || alerts.length === 0) {
    return NextResponse.json({ impacts: [], summary: { critical: 0, warning: 0, info: 0, total: 0 } });
  }

  // Run impact analysis
  const planRows = (plan.plan_data as { rows?: unknown[] })?.rows ?? [];
  const impacts: PlanImpact[] = [];

  for (const alert of alerts) {
    const impact = analyzeAlertImpact(
      planRows as Parameters<typeof analyzeAlertImpact>[0],
      {
        id: alert.id,
        tail_number: alert.tail_number,
        change_type: alert.change_type,
        old_value: alert.old_value,
        new_value: alert.new_value,
      },
    );
    if (impact) impacts.push(impact);
  }

  // Upsert impacts
  if (impacts.length > 0) {
    const rows = impacts.map((imp) => ({
      swap_plan_id: plan.id,
      alert_id: imp.alert_id,
      tail_number: imp.tail_number,
      affected_crew: imp.affected_crew,
      severity: imp.severity,
      resolved: false,
    }));

    const { error: upsertErr } = await supa
      .from("swap_plan_impacts")
      .upsert(rows, { onConflict: "swap_plan_id,alert_id" });

    if (upsertErr) {
      return NextResponse.json({ error: upsertErr.message }, { status: 500 });
    }
  }

  return NextResponse.json({
    impacts,
    summary: {
      critical: impacts.filter((i) => i.severity === "critical").length,
      warning: impacts.filter((i) => i.severity === "warning").length,
      info: impacts.filter((i) => i.severity === "info").length,
      total: impacts.length,
    },
  });
}

/**
 * PATCH /api/crew/swap-plan/impact
 * Body: { id: "uuid" } — mark impact as resolved
 */
export async function PATCH(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (!isAuthed(auth)) return auth.error;

  const body = await req.json();
  if (!body.id) {
    return NextResponse.json({ error: "id required" }, { status: 400 });
  }

  const supa = createServiceClient();
  const { error } = await supa
    .from("swap_plan_impacts")
    .update({ resolved: true })
    .eq("id", body.id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
