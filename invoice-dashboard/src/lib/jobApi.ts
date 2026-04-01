import { createServiceClient } from "@/lib/supabase/service";
import { signGcsUrl } from "@/lib/gcs";
import type { HiringStage, JobDetailResponse, JobRow, JobsListResponse } from "@/lib/types";

// ---------------------------------------------------------------------------
// Jobs list — direct Supabase query to job_application_parse
// ---------------------------------------------------------------------------

const JOB_COLUMNS =
  "id, application_id, created_at, updated_at, hiring_stage, category, employment_type, candidate_name, email, phone, location, total_time_hours, turbine_time_hours, pic_time_hours, sic_time_hours, has_citation_x, has_challenger_300_type_rating, type_ratings, has_part_135, has_part_121, soft_gate_pic_met, soft_gate_pic_status, needs_review, notes, model, info_session_data, structured_notes, rejected_at, rejection_reason, deleted_at";

const JOB_COLUMNS_WITH_STAGE =
  "id, application_id, created_at, updated_at, pipeline_stage, category, employment_type, candidate_name, email, phone, location, total_time_hours, turbine_time_hours, pic_time_hours, sic_time_hours, has_citation_x, has_challenger_300_type_rating, type_ratings, has_part_135, has_part_121, soft_gate_pic_met, soft_gate_pic_status, needs_review, notes, model, info_session_data, structured_notes, rejected_at, rejection_reason, deleted_at, offer_status, offer_sent_at, hr_reviewed, previously_rejected, rejection_type, interview_email_sent_at, interest_check_sent_at, interest_check_response, interview_email_status";

const JOB_COLUMNS_BASE =
  "id, application_id, created_at, updated_at, category, employment_type, candidate_name, email, phone, location, total_time_hours, turbine_time_hours, pic_time_hours, sic_time_hours, has_citation_x, has_challenger_300_type_rating, type_ratings, has_part_135, has_part_121, soft_gate_pic_met, soft_gate_pic_status, needs_review, notes, model, info_session_data";

async function queryJobs(
  supa: ReturnType<typeof createServiceClient>,
  columns: string,
  params: {
    limit?: number;
    category?: string;
    employment_type?: string;
    needs_review?: "true" | "false";
    soft_gate_pic_met?: "true" | "false";
    has_citation_x?: "true" | "false";
    has_challenger_300_type_rating?: "true" | "false";
  },
) {
  let query = supa
    .from("job_application_parse")
    .select(columns)
    .order("created_at", { ascending: false })
    .limit(params.limit ?? 200);

  if (params.category) query = query.eq("category", params.category);
  if (params.employment_type) query = query.eq("employment_type", params.employment_type);
  if (params.needs_review) query = query.eq("needs_review", params.needs_review === "true");
  if (params.soft_gate_pic_met) query = query.eq("soft_gate_pic_met", params.soft_gate_pic_met === "true");
  if (params.has_citation_x) query = query.eq("has_citation_x", params.has_citation_x === "true");
  if (params.has_challenger_300_type_rating) {
    query = query.eq("has_challenger_300_type_rating", params.has_challenger_300_type_rating === "true");
  }

  // Hide soft-deleted rows by default
  query = query.is("deleted_at", null);

  return query;
}

export async function fetchJobs(
  params: {
    limit?: number;
    q?: string;
    category?: string;
    employment_type?: string;
    needs_review?: "true" | "false";
    soft_gate_pic_met?: "true" | "false";
    has_citation_x?: "true" | "false";
    has_challenger_300_type_rating?: "true" | "false";
  } = {},
): Promise<JobsListResponse> {
  const supa = createServiceClient();

  // Try with all columns; fall back progressively if newer columns don't exist
  let { data, error } = await queryJobs(supa, JOB_COLUMNS_WITH_STAGE, params);
  if (error) {
    console.warn("[fetchJobs] Full column query failed, trying with pipeline_stage only:", error.message);
    // Fallback: base columns + pipeline_stage (skip newer columns like offer_status etc.)
    const fallbackCols = JOB_COLUMNS_BASE + ", pipeline_stage, structured_notes, rejected_at, rejection_reason, rejection_type, deleted_at, hr_reviewed, previously_rejected, interview_email_sent_at, offer_status, offer_sent_at, interest_check_sent_at, interest_check_response, interview_email_status";
    const retry2 = await queryJobs(supa, fallbackCols, params);
    if (retry2.error) {
      console.warn("[fetchJobs] Pipeline column query also failed, using base:", retry2.error.message);
      const retry3 = await queryJobs(supa, JOB_COLUMNS_BASE, params);
      data = retry3.data;
      error = retry3.error;
    } else {
      data = retry2.data;
      error = null;
    }
  }
  if (error) throw new Error(`fetchJobs failed: ${error.message}`);

  let jobs = (data ?? []).map((row: any) => ({
    ...row,
    pipeline_stage: row.pipeline_stage ?? null,
  })) as JobRow[];

  // Text search (matches backend behavior)
  if (params.q) {
    const qLower = params.q.toLowerCase();
    jobs = jobs.filter((j) =>
      [j.candidate_name, j.email, j.phone, j.location, j.category, j.employment_type, j.soft_gate_pic_status, j.notes]
        .filter(Boolean)
        .some((f) => String(f).toLowerCase().includes(qLower)),
    );
  }

  return { ok: true, count: jobs.length, jobs };
}

// ---------------------------------------------------------------------------
// Job detail — direct Supabase query
// File URLs point to internal API route (handles GCS signing + Cloud Run)
// ---------------------------------------------------------------------------

const SAFE_ID_RE = /^[a-zA-Z0-9_-]+$/;

// ---------------------------------------------------------------------------
// Update hiring stage
// ---------------------------------------------------------------------------

export async function updateHiringStage(
  id: number,
  stage: HiringStage,
): Promise<void> {
  const supa = createServiceClient();
  const { error } = await supa
    .from("job_application_parse")
    .update({ hiring_stage: stage, updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw new Error(`updateHiringStage failed: ${error.message}`);
}

// ---------------------------------------------------------------------------
// Create a manual candidate (no email/parse pipeline needed)
// ---------------------------------------------------------------------------

export async function createCandidate(fields: {
  candidate_name: string;
  email?: string;
  phone?: string;
  location?: string;
  category?: string;
  notes?: string;
  hiring_stage?: HiringStage;
}): Promise<JobRow> {
  const supa = createServiceClient();
  const now = new Date().toISOString();
  const { data, error } = await supa
    .from("job_application_parse")
    .insert({
      candidate_name: fields.candidate_name,
      email: fields.email || null,
      phone: fields.phone || null,
      location: fields.location || null,
      category: fields.category || null,
      notes: fields.notes || null,
      hiring_stage: fields.hiring_stage ?? null,
      created_at: now,
      updated_at: now,
    })
    .select(JOB_COLUMNS)
    .single();
  if (error) throw new Error(`createCandidate failed: ${error.message}`);
  return data as JobRow;
}

// ---------------------------------------------------------------------------
// Job detail — still proxies to Cloud Run (needs signed file URLs from GCS)
// ---------------------------------------------------------------------------

export async function fetchJobDetail(applicationId: string | number): Promise<JobDetailResponse> {
  const id = String(applicationId);
  if (!SAFE_ID_RE.test(id)) {
    throw new Error("Invalid application ID");
  }

  const supa = createServiceClient();

  // Fetch job parse data — try with pipeline_stage, fall back if column missing
  let jobRow: any = null;
  let jobErr: any = null;

  const first = await supa
    .from("job_application_parse")
    .select(JOB_COLUMNS_WITH_STAGE)
    .eq("application_id", Number(id))
    .limit(1)
    .maybeSingle();

  if (first.error) {
    // Fallback: base columns + pipeline_stage (skip newest columns)
    const fallbackCols = JOB_COLUMNS_BASE + ", pipeline_stage, structured_notes, rejected_at, rejection_reason, rejection_type, deleted_at, hr_reviewed, previously_rejected, interview_email_sent_at, offer_status, offer_sent_at, interest_check_sent_at, interest_check_response, interview_email_status";
    const retry2 = await supa
      .from("job_application_parse")
      .select(fallbackCols)
      .eq("application_id", Number(id))
      .limit(1)
      .maybeSingle();
    if (retry2.error) {
      const retry3 = await supa
        .from("job_application_parse")
        .select(JOB_COLUMNS_BASE)
        .eq("application_id", Number(id))
        .limit(1)
        .maybeSingle();
      jobRow = retry3.data;
      jobErr = retry3.error;
    } else {
      jobRow = retry2.data;
    }
  } else {
    jobRow = first.data;
  }

  if (jobErr) throw new Error(`fetchJobDetail failed: ${jobErr.message}`);
  if (!jobRow) throw new Error("Job application not found");
  // Leave pipeline_stage as-is (may be null for candidates not yet in pipeline)

  // Fetch file metadata from Supabase (include GCS location for signing)
  const { data: fileRows } = await supa
    .from("job_application_files")
    .select("id, filename, content_type, size_bytes, created_at, gcs_bucket, gcs_key, file_category")
    .eq("application_id", Number(id))
    .order("created_at", { ascending: true });

  // Sign URLs server-side so they work in iframes (no redirect)
  const files = await Promise.all(
    (fileRows ?? []).map(async (f) => {
      let signed_url: string | null = null;
      if (f.gcs_bucket && f.gcs_key) {
        signed_url = await signGcsUrl(f.gcs_bucket as string, f.gcs_key as string);
      }
      // Fallback to internal API route
      if (!signed_url) signed_url = `/api/files/${f.id}`;
      return {
        id: f.id,
        filename: f.filename,
        content_type: f.content_type,
        size_bytes: f.size_bytes,
        created_at: f.created_at,
        signed_url,
      };
    }),
  );

  return { ok: true, job: jobRow as JobRow, files };
}

// ---------------------------------------------------------------------------
// Linked LORs — files linked to this candidate's parse row
// ---------------------------------------------------------------------------

export async function fetchLinkedLors(parseId: number | null | undefined): Promise<any[]> {
  if (!parseId) return [];

  const supa = createServiceClient();

  const { data: lorFiles } = await supa
    .from("job_application_files")
    .select("id, filename, content_type, size_bytes, created_at, gcs_bucket, gcs_key, file_category, linked_parse_id")
    .eq("linked_parse_id", parseId)
    .eq("file_category", "lor")
    .order("created_at", { ascending: true });

  if (!lorFiles || lorFiles.length === 0) return [];

  return Promise.all(
    lorFiles.map(async (f) => {
      let signed_url: string | null = null;
      if (f.gcs_bucket && f.gcs_key) {
        signed_url = await signGcsUrl(f.gcs_bucket as string, f.gcs_key as string);
      }
      if (!signed_url) signed_url = `/api/files/${f.id}`;
      return {
        id: f.id,
        filename: f.filename,
        content_type: f.content_type,
        size_bytes: f.size_bytes,
        created_at: f.created_at,
        signed_url,
      };
    }),
  );
}

// ---------------------------------------------------------------------------
// Previously rejected applications by email
// ---------------------------------------------------------------------------

export async function fetchPreviousRejections(
  fields: { email?: string | null; phone?: string | null; candidate_name?: string | null },
  excludeId: number,
): Promise<{ id: number; application_id: number; rejected_at: string; rejection_reason: string | null }[]> {
  const { email, phone, candidate_name } = fields;
  if (!email && !phone && !candidate_name) return [];

  const supa = createServiceClient();

  // Build OR conditions for matching on email, phone, or name
  const orClauses: string[] = [];
  if (email) orClauses.push(`email.eq.${email}`);
  if (phone) orClauses.push(`phone.eq.${phone}`);
  if (candidate_name) orClauses.push(`candidate_name.eq.${candidate_name}`);

  const { data, error } = await supa
    .from("job_application_parse")
    .select("id, application_id, rejected_at, rejection_reason, candidate_name, email, phone")
    .or(orClauses.join(","))
    .not("rejected_at", "is", null)
    .is("deleted_at", null)
    .neq("id", excludeId);
  if (error) return [];
  return (data ?? []) as any;
}
