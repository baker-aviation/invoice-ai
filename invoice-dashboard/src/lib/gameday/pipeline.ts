/**
 * Game Day Operations — Pipeline
 *
 * Orchestrates: impact analysis → suggestion generation → Slack alerts.
 * Called from the jetinsight-schedule cron when new swap_leg_alerts are detected.
 */

import "server-only";
import { createServiceClient } from "@/lib/supabase/service";
import { analyzeAlertImpact, type PlanImpact } from "@/lib/swapPlanImpact";
import { generateSuggestions, type Suggestion } from "./suggestions";
import { postImpactAlerts, type ImpactWithSuggestions } from "./slackAlerts";

// ─── Types ──────────────────────────────────────────────────────────────────

export type GameDayResult = {
  swap_dates_checked: string[];
  impacts_found: number;
  impacts_critical: number;
  impacts_warning: number;
  suggestions_generated: number;
  slack_sent: number;
  slack_rate_limited: number;
  errors: string[];
};

// ─── Pipeline ───────────────────────────────────────────────────────────────

/**
 * Full game day pipeline:
 * 1. Find all active swap plans
 * 2. For each, get unacknowledged alerts
 * 3. Run impact analysis
 * 4. Generate suggestions for critical/warning impacts
 * 5. Upsert to swap_plan_impacts
 * 6. Post Slack alerts
 */
export async function runGameDayPipeline(): Promise<GameDayResult> {
  const result: GameDayResult = {
    swap_dates_checked: [],
    impacts_found: 0,
    impacts_critical: 0,
    impacts_warning: 0,
    suggestions_generated: 0,
    slack_sent: 0,
    slack_rate_limited: 0,
    errors: [],
  };

  const supa = createServiceClient();

  // 1. Get all active swap plans
  const { data: plans } = await supa
    .from("swap_plans")
    .select("id, swap_date, plan_data")
    .eq("status", "active");

  if (!plans || plans.length === 0) return result;

  for (const plan of plans) {
    const swapDate = plan.swap_date as string;
    result.swap_dates_checked.push(swapDate);

    // 2. Get unacknowledged alerts for this date, only NEW ones (after plan creation)
    const { data: alerts } = await supa
      .from("swap_leg_alerts")
      .select("*")
      .eq("swap_date", swapDate)
      .eq("acknowledged", false);

    if (!alerts || alerts.length === 0) continue;

    // 3. Extract crew rows from plan_data
    const planData = plan.plan_data as Record<string, unknown> | null;
    const planRows = extractPlanRows(planData);
    if (planRows.length === 0) continue;

    // 4. Run impact analysis for each alert
    const impacts: PlanImpact[] = [];
    for (const alert of alerts) {
      const impact = analyzeAlertImpact(planRows, {
        id: alert.id,
        tail_number: alert.tail_number,
        change_type: alert.change_type as "added" | "cancelled" | "time_change" | "airport_change",
        old_value: alert.old_value as Record<string, unknown> | null,
        new_value: alert.new_value as Record<string, unknown> | null,
      });
      if (impact) impacts.push(impact);
    }

    result.impacts_found += impacts.length;
    result.impacts_critical += impacts.filter((i) => i.severity === "critical").length;
    result.impacts_warning += impacts.filter((i) => i.severity === "warning").length;

    if (impacts.length === 0) continue;

    // 5. Generate suggestions for critical/warning impacts
    const actionableImpacts = impacts.filter(
      (i) => i.severity === "critical" || i.severity === "warning",
    );

    let suggestionMap = new Map<string, Suggestion[]>();
    if (actionableImpacts.length > 0) {
      try {
        suggestionMap = await generateSuggestions(
          actionableImpacts,
          swapDate,
          planRows as Parameters<typeof generateSuggestions>[2],
        );
        for (const suggs of suggestionMap.values()) {
          result.suggestions_generated += suggs.length;
        }
      } catch (err) {
        result.errors.push(
          `Suggestions: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // 6. Upsert impacts to swap_plan_impacts (with suggestions)
    for (const impact of impacts) {
      const suggestions = suggestionMap.get(impact.alert_id) ?? [];
      const { error } = await supa.from("swap_plan_impacts").upsert(
        {
          swap_plan_id: plan.id,
          alert_id: impact.alert_id,
          tail_number: impact.tail_number,
          affected_crew: impact.affected_crew,
          severity: impact.severity,
          suggestions: suggestions.length > 0 ? suggestions : null,
          resolved: false,
        },
        { onConflict: "swap_plan_id,alert_id" },
      );
      if (error) {
        result.errors.push(`Upsert impact: ${error.message}`);
      }
    }

    // 7. Post Slack alerts
    try {
      const impactsWithSuggestions: ImpactWithSuggestions[] = impacts.map((i) => ({
        ...i,
        suggestions: suggestionMap.get(i.alert_id),
      }));

      const slackResult = await postImpactAlerts(impactsWithSuggestions, swapDate);
      result.slack_sent += slackResult.sent;
      result.slack_rate_limited += slackResult.rate_limited;
    } catch (err) {
      result.errors.push(
        `Slack: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return result;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

type CrewSwapRow = {
  name: string;
  role: "PIC" | "SIC";
  direction: "oncoming" | "offgoing";
  tail_number: string;
  swap_location: string | null;
  travel_type: string;
  flight_number?: string | null;
  departure_time: string | null;
  arrival_time: string | null;
  available_time: string | null;
};

/**
 * Extract crew swap rows from the saved plan_data JSONB.
 * The plan_data stores the full optimizer output.
 */
function extractPlanRows(planData: Record<string, unknown> | null): CrewSwapRow[] {
  if (!planData) return [];

  // plan_data.rows is the primary location
  const rows = planData.rows as CrewSwapRow[] | undefined;
  if (Array.isArray(rows)) return rows;

  // Fallback: check swap_assignments
  const assignments = planData.swap_assignments as Record<string, Record<string, unknown>> | undefined;
  if (!assignments) return [];

  const result: CrewSwapRow[] = [];
  for (const [tail, assignment] of Object.entries(assignments)) {
    for (const dir of ["oncoming", "offgoing"] as const) {
      for (const role of ["pic", "sic"] as const) {
        const name = assignment[`${dir}_${role}`] as string | null;
        if (!name) continue;
        result.push({
          name,
          role: role.toUpperCase() as "PIC" | "SIC",
          direction: dir,
          tail_number: tail,
          swap_location: null,
          travel_type: "unknown",
          departure_time: null,
          arrival_time: null,
          available_time: null,
        });
      }
    }
  }
  return result;
}
