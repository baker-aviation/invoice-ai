import { createServiceClient } from "@/lib/supabase/service";
import { ALL_GROUND_STAGES, GROUND_CATEGORIES } from "@/lib/groundPipeline";
import type { JobRow } from "@/lib/types";

// ---------------------------------------------------------------------------
// Ground pipeline query columns
// ---------------------------------------------------------------------------

const GROUND_COLUMNS =
  "id, application_id, created_at, updated_at, pipeline_stage, category, employment_type, candidate_name, email, phone, location, total_time_hours, notes, model, structured_notes, rejected_at, rejection_reason, rejection_type, deleted_at, hr_reviewed, previously_rejected, ground_qualifications, ground_evaluations, manager_review_status, manager_review_by, manager_review_at, manager_review_notes, background_check_status, background_check_at, driving_record_status, driving_record_notes, offer_status, offer_sent_at";

// ---------------------------------------------------------------------------
// Fetch ground pipeline candidates
// ---------------------------------------------------------------------------

/**
 * Fetch ALL ground candidates for the table view (no pipeline_stage filter).
 */
export async function fetchGroundTableJobs(): Promise<{ ok: boolean; count: number; jobs: JobRow[] }> {
  const supa = createServiceClient();

  const { data, error } = await supa
    .from("job_application_parse")
    .select(GROUND_COLUMNS)
    .in("category", [...GROUND_CATEGORIES])
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(2000);

  if (error) {
    console.error("[fetchGroundTableJobs] Error:", error.message);
    const { data: fallback, error: fallbackErr } = await supa
      .from("job_application_parse")
      .select("id, application_id, created_at, updated_at, pipeline_stage, category, employment_type, candidate_name, email, phone, location, notes, model, rejected_at, rejection_reason, deleted_at, hr_reviewed, offer_status, offer_sent_at")
      .in("category", [...GROUND_CATEGORIES])
      .is("deleted_at", null)
      .order("created_at", { ascending: false })
      .limit(2000);

    if (fallbackErr) throw new Error(`fetchGroundTableJobs failed: ${fallbackErr.message}`);
    return { ok: true, count: (fallback ?? []).length, jobs: (fallback ?? []) as unknown as JobRow[] };
  }

  const jobs = (data ?? []) as unknown as JobRow[];
  return { ok: true, count: jobs.length, jobs };
}

export async function fetchGroundPipelineJobs(): Promise<{ ok: boolean; count: number; jobs: JobRow[] }> {
  const supa = createServiceClient();

  const { data, error } = await supa
    .from("job_application_parse")
    .select(GROUND_COLUMNS)
    .in("category", [...GROUND_CATEGORIES])
    .in("pipeline_stage", [...ALL_GROUND_STAGES])
    .is("deleted_at", null)
    .order("updated_at", { ascending: false })
    .limit(2000);

  if (error) {
    console.error("[fetchGroundPipelineJobs] Error:", error.message);
    // Fallback: try without ground-specific columns
    const { data: fallback, error: fallbackErr } = await supa
      .from("job_application_parse")
      .select("id, application_id, created_at, updated_at, pipeline_stage, category, employment_type, candidate_name, email, phone, location, notes, model, rejected_at, rejection_reason, deleted_at, hr_reviewed, offer_status, offer_sent_at")
      .in("category", [...GROUND_CATEGORIES])
      .in("pipeline_stage", [...ALL_GROUND_STAGES])
      .is("deleted_at", null)
      .order("updated_at", { ascending: false })
      .limit(2000);

    if (fallbackErr) throw new Error(`fetchGroundPipelineJobs failed: ${fallbackErr.message}`);
    const jobs = (fallback ?? []) as unknown as JobRow[];
    return { ok: true, count: jobs.length, jobs };
  }

  const jobs = (data ?? []) as unknown as JobRow[];
  return { ok: true, count: jobs.length, jobs };
}
