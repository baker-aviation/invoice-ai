/**
 * Game Day Operations — Commercial Delay → Impact Correlation
 *
 * Checks live FlightAware status for crew in transit and creates
 * swap_plan_impacts when delays threaten the swap plan.
 *
 * Trigger sources:
 *   - Crew flight delayed enough that buffer < 30min
 *   - Connection at risk (< 45min layover gap)
 *   - Flight cancelled
 */

import "server-only";
import { createServiceClient } from "@/lib/supabase/service";
import { generateSuggestions, type Suggestion } from "./suggestions";
import { postImpactAlerts, type ImpactWithSuggestions } from "./slackAlerts";
import type { PlanImpact } from "@/lib/swapPlanImpact";

// ─── Types ──────────────────────────────────────────────────────────────────

type CrewStatus = {
  name: string;
  role: "PIC" | "SIC";
  direction: "oncoming" | "offgoing";
  tail_number: string;
  swap_location: string;
  transport_type: string;
  flight_number: string | null;
  flight_numbers: string[];
  status: string;
  status_detail: string | null;
  live_arrival: string | null;
  delay_minutes: number | null;
  connection_at_risk: boolean;
  duty_on: string | null;
  arrival_time: string | null;
  leg_details: {
    flight_number: string;
    status: string;
    delay_minutes: number | null;
    estimated_arrival: string | null;
    actual_arrival: string | null;
  }[];
};

type PlanRow = {
  name: string;
  role: "PIC" | "SIC";
  direction: "oncoming" | "offgoing";
  tail_number: string;
  swap_location: string | null;
  travel_type: string;
  flight_number: string | null;
  available_time: string | null;
  arrival_time: string | null;
  home_airports?: string[];
};

export type CommercialDelayResult = {
  crew_checked: number;
  impacts_created: number;
  suggestions_generated: number;
  slack_sent: number;
  errors: string[];
};

// ─── Configuration ──────────────────────────────────────────────────────────

/** Minimum delay (minutes) to flag as warning */
const DELAY_WARNING_THRESHOLD = 15;
/** Delay that makes crew miss swap → critical */
const BUFFER_MINUTES = 30;
/** Dedup window — don't re-alert same crew within this period */
const DEDUP_HOURS = 2;

// ─── Main function ──────────────────────────────────────────────────────────

/**
 * Check live commercial flight status and create impacts for delays.
 * Called from the game day pipeline or a dedicated cron.
 */
export async function checkCommercialDelays(): Promise<CommercialDelayResult> {
  const result: CommercialDelayResult = {
    crew_checked: 0,
    impacts_created: 0,
    suggestions_generated: 0,
    slack_sent: 0,
    errors: [],
  };

  const supa = createServiceClient();

  // 1. Get active swap plans
  const { data: plans } = await supa
    .from("swap_plans")
    .select("id, swap_date, plan_data")
    .eq("status", "active");

  if (!plans?.length) return result;

  // 2. Fetch live swap status from our own API
  const baseUrl = process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : process.env.NEXTAUTH_URL ?? "http://localhost:3000";
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  let statusData: { oncoming: CrewStatus[]; offgoing: CrewStatus[]; swap_date: string } | null = null;
  try {
    const res = await fetch(`${baseUrl}/api/crew/swap-status?live=true`, {
      headers: serviceKey ? { "x-service-key": serviceKey } : {},
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) {
      result.errors.push(`swap-status HTTP ${res.status}`);
      return result;
    }
    statusData = await res.json();
  } catch (err) {
    result.errors.push(`swap-status fetch: ${err instanceof Error ? err.message : String(err)}`);
    return result;
  }

  if (!statusData) return result;

  const allCrew = [...(statusData.oncoming ?? []), ...(statusData.offgoing ?? [])];
  const commercialCrew = allCrew.filter(
    (c) => c.transport_type === "commercial" && c.flight_numbers?.length > 0,
  );
  result.crew_checked = commercialCrew.length;

  if (commercialCrew.length === 0) return result;

  // 3. Match swap_date to a plan
  const matchingPlan = plans.find((p) => p.swap_date === statusData!.swap_date);
  if (!matchingPlan) return result;

  const planData = matchingPlan.plan_data as Record<string, unknown> | null;
  const planRows = (planData?.rows as PlanRow[]) ?? [];

  // 4. Check existing recent impacts to avoid duplicates
  const cutoff = new Date(Date.now() - DEDUP_HOURS * 60 * 60 * 1000).toISOString();
  const { data: recentImpacts } = await supa
    .from("swap_plan_impacts")
    .select("tail_number, affected_crew, created_at")
    .eq("swap_plan_id", matchingPlan.id)
    .gte("created_at", cutoff);

  const recentKeys = new Set(
    (recentImpacts ?? []).flatMap((imp) => {
      const crew = imp.affected_crew as { name: string }[];
      return crew.map((c) => `${imp.tail_number}|${c.name}`);
    }),
  );

  // 5. Analyze each commercial crew member for delay impacts
  const newImpacts: (PlanImpact & { suggestions?: Suggestion[] })[] = [];

  for (const crew of commercialCrew) {
    // Only oncoming matters for "will they make the swap" — offgoing delays are informational
    if (crew.direction !== "oncoming") continue;

    const issues: string[] = [];
    let severity: "critical" | "warning" | "info" = "info";

    // Check: flight cancelled
    if (crew.status === "cancelled") {
      issues.push("Commercial flight cancelled");
      severity = "critical";
    }

    // Check: connection at risk
    if (crew.connection_at_risk) {
      issues.push(`Connection at risk — ${crew.status_detail ?? "tight layover"}`);
      if (severity !== "critical") severity = "warning";
    }

    // Check: delay threatens buffer
    if (crew.delay_minutes && crew.delay_minutes >= DELAY_WARNING_THRESHOLD) {
      // Find the plan row to get the swap deadline (duty_on or next leg departure)
      const planRow = planRows.find(
        (r) => r.name === crew.name && r.direction === "oncoming",
      );

      if (planRow?.available_time) {
        // Compare live arrival vs planned arrival
        const liveArrival = crew.live_arrival
          ? new Date(crew.live_arrival).getTime()
          : null;
        const plannedAvailable = new Date(planRow.available_time).getTime();

        if (liveArrival && liveArrival > plannedAvailable) {
          const lateBy = Math.round((liveArrival - plannedAvailable) / 60_000);
          issues.push(`Delayed +${crew.delay_minutes}min — arrives ${lateBy}min after planned time`);
          severity = "critical";
        } else if (crew.delay_minutes >= DELAY_WARNING_THRESHOLD) {
          issues.push(`Delayed +${crew.delay_minutes}min — buffer reduced but may still work`);
          if (severity !== "critical") severity = "warning";
        }
      } else {
        // No planned time to compare — flag the delay anyway
        issues.push(`Delayed +${crew.delay_minutes}min`);
        if (severity !== "critical") severity = "warning";
      }
    }

    if (issues.length === 0 || severity === "info") continue;

    // Dedup check
    const dedupKey = `${crew.tail_number}|${crew.name}`;
    if (recentKeys.has(dedupKey)) continue;

    newImpacts.push({
      alert_id: `delay-${crew.name}-${Date.now()}`, // synthetic alert ID
      tail_number: crew.tail_number,
      severity,
      affected_crew: [
        {
          name: crew.name,
          role: crew.role,
          direction: crew.direction,
          detail: issues.join("; "),
        },
      ],
    });
  }

  if (newImpacts.length === 0) return result;

  // 6. Generate suggestions for new impacts
  const actionableImpacts = newImpacts.filter(
    (i) => i.severity === "critical" || i.severity === "warning",
  );

  if (actionableImpacts.length > 0) {
    try {
      const suggestionMap = await generateSuggestions(
        actionableImpacts,
        statusData.swap_date,
        planRows as Parameters<typeof generateSuggestions>[2],
      );
      for (const impact of newImpacts) {
        impact.suggestions = suggestionMap.get(impact.alert_id);
        result.suggestions_generated += (impact.suggestions?.length ?? 0);
      }
    } catch (err) {
      result.errors.push(`Suggestions: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // 7. Insert impacts into swap_plan_impacts
  for (const impact of newImpacts) {
    const { error } = await supa.from("swap_plan_impacts").insert({
      swap_plan_id: matchingPlan.id,
      alert_id: impact.alert_id,
      tail_number: impact.tail_number,
      affected_crew: impact.affected_crew,
      severity: impact.severity,
      suggestions: impact.suggestions?.length ? impact.suggestions : null,
      resolved: false,
    });

    if (error) {
      // alert_id uniqueness might conflict — skip silently (dedup)
      if (error.code !== "23505") {
        result.errors.push(`Insert impact: ${error.message}`);
      }
    } else {
      result.impacts_created++;
    }
  }

  // 8. Post Slack alerts
  if (newImpacts.length > 0) {
    try {
      const impactsWithSuggestions: ImpactWithSuggestions[] = newImpacts.map((i) => ({
        ...i,
        suggestions: i.suggestions,
      }));
      const slackResult = await postImpactAlerts(impactsWithSuggestions, statusData.swap_date);
      result.slack_sent = slackResult.sent;
    } catch (err) {
      result.errors.push(`Slack: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return result;
}
