import { createServiceClient } from "@/lib/supabase/service";
import { signGcsUrl } from "@/lib/gcs";
import type { JobDetailResponse, JobRow, JobsListResponse } from "@/lib/types";

// ---------------------------------------------------------------------------
// Jobs list — direct Supabase query to job_application_parse
// ---------------------------------------------------------------------------

const JOB_COLUMNS =
  "id, application_id, created_at, updated_at, category, employment_type, candidate_name, email, phone, location, total_time_hours, turbine_time_hours, pic_time_hours, sic_time_hours, has_citation_x, has_challenger_300_type_rating, type_ratings, soft_gate_pic_met, soft_gate_pic_status, needs_review, notes, model";

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
  const limit = params.limit ?? 200;

  let query = supa
    .from("job_application_parse")
    .select(JOB_COLUMNS)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (params.category) query = query.eq("category", params.category);
  if (params.employment_type) query = query.eq("employment_type", params.employment_type);
  if (params.needs_review) query = query.eq("needs_review", params.needs_review === "true");
  if (params.soft_gate_pic_met) query = query.eq("soft_gate_pic_met", params.soft_gate_pic_met === "true");
  if (params.has_citation_x) query = query.eq("has_citation_x", params.has_citation_x === "true");
  if (params.has_challenger_300_type_rating) {
    query = query.eq("has_challenger_300_type_rating", params.has_challenger_300_type_rating === "true");
  }

  const { data, error } = await query;
  if (error) throw new Error(`fetchJobs failed: ${error.message}`);

  let jobs = (data ?? []) as JobRow[];

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

export async function fetchJobDetail(applicationId: string | number): Promise<JobDetailResponse> {
  const id = String(applicationId);
  if (!SAFE_ID_RE.test(id)) {
    throw new Error("Invalid application ID");
  }

  const supa = createServiceClient();

  // Fetch job parse data
  const { data: job, error: jobErr } = await supa
    .from("job_application_parse")
    .select(JOB_COLUMNS)
    .eq("application_id", Number(id))
    .limit(1)
    .maybeSingle();

  if (jobErr) throw new Error(`fetchJobDetail failed: ${jobErr.message}`);
  if (!job) throw new Error("Job application not found");

  // Fetch file metadata from Supabase (include GCS location for signing)
  const { data: fileRows } = await supa
    .from("job_application_files")
    .select("id, filename, content_type, size_bytes, created_at, gcs_bucket, gcs_key")
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

  return { ok: true, job: job as JobRow, files };
}
