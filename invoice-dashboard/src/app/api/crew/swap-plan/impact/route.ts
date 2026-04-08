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

  // Run impact analysis — deduplicate per tail (multiple alerts for same tail → one impact)
  const planRows = (plan.plan_data as { rows?: unknown[] })?.rows ?? [];
  const rawImpacts: PlanImpact[] = [];

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
    if (impact) rawImpacts.push(impact);
  }

  // Merge impacts by tail_number — keep highest severity, combine affected crew
  const impactsByTail = new Map<string, PlanImpact>();
  for (const imp of rawImpacts) {
    const existing = impactsByTail.get(imp.tail_number);
    if (!existing) {
      impactsByTail.set(imp.tail_number, { ...imp });
    } else {
      // Merge: upgrade severity if needed
      const severityRank = { critical: 3, warning: 2, info: 1 };
      if (severityRank[imp.severity] > severityRank[existing.severity]) {
        existing.severity = imp.severity;
      }
      // Merge affected crew (dedupe by name)
      const existingNames = new Set(existing.affected_crew.map((c) => c.name));
      for (const c of imp.affected_crew) {
        if (!existingNames.has(c.name)) {
          existing.affected_crew.push(c);
          existingNames.add(c.name);
        }
      }
    }
  }
  const impacts = Array.from(impactsByTail.values());

  // Upsert impacts (use first alert_id per tail as the key)
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
 * Body: { id: "uuid", resolution_type?, resolution_note?, resolved_by? }
 * Mark impact as resolved with optional resolution details.
 */
export async function PATCH(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (!isAuthed(auth)) return auth.error;

  const body = await req.json();
  if (!body.id) {
    return NextResponse.json({ error: "id required" }, { status: 400 });
  }

  const supa = createServiceClient();
  const updateData: Record<string, unknown> = {
    resolved: true,
    resolved_at: new Date().toISOString(),
  };

  if (body.resolution_type) updateData.resolution_type = body.resolution_type;
  if (body.resolution_note) updateData.resolution_note = body.resolution_note;
  if (body.resolved_by) updateData.resolved_by = body.resolved_by;

  const { error } = await supa
    .from("swap_plan_impacts")
    .update(updateData)
    .eq("id", body.id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}

/**
 * GET /api/crew/swap-plan/impact?swap_date=2026-04-09
 * Returns all impacts (resolved and unresolved) for a swap date's active plan.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (!isAuthed(auth)) return auth.error;

  const swapDate = req.nextUrl.searchParams.get("swap_date");
  if (!swapDate) {
    return NextResponse.json({ error: "swap_date required" }, { status: 400 });
  }

  const supa = createServiceClient();

  // Find active plan
  const { data: plan } = await supa
    .from("swap_plans")
    .select("id")
    .eq("swap_date", swapDate)
    .eq("status", "active")
    .maybeSingle();

  if (!plan) {
    return NextResponse.json({ impacts: [], summary: { critical: 0, warning: 0, info: 0, total: 0, resolved: 0 } });
  }

  // Get all impacts for this plan
  const { data: impacts, error } = await supa
    .from("swap_plan_impacts")
    .select("*, swap_leg_alerts!inner(change_type, old_value, new_value, detected_at)")
    .eq("swap_plan_id", plan.id)
    .order("created_at", { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const all = impacts ?? [];
  const unresolved = all.filter((i) => !i.resolved);

  return NextResponse.json({
    impacts: all,
    summary: {
      critical: unresolved.filter((i) => i.severity === "critical").length,
      warning: unresolved.filter((i) => i.severity === "warning").length,
      info: unresolved.filter((i) => i.severity === "info").length,
      total: all.length,
      resolved: all.filter((i) => i.resolved).length,
    },
  });
}
