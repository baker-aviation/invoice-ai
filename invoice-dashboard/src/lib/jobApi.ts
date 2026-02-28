import { createServiceClient } from "@/lib/supabase/service";
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
// Job detail — still proxies to Cloud Run (needs signed file URLs from GCS)
// ---------------------------------------------------------------------------

const BASE = process.env.JOB_API_BASE_URL;

function mustBase(): string {
  if (!BASE) throw new Error("Missing JOB_API_BASE_URL in .env.local");
  return BASE.replace(/\/$/, "");
}

const SAFE_ID_RE = /^[a-zA-Z0-9_-]+$/;

export async function fetchJobDetail(applicationId: string | number): Promise<JobDetailResponse> {
  const id = String(applicationId);
  if (!SAFE_ID_RE.test(id)) {
    throw new Error("Invalid application ID");
  }
  const base = mustBase();

  const res = await fetch(`${base}/api/jobs/${encodeURIComponent(id)}`, {
    cache: "no-store",
    headers: { Accept: "application/json" },
  });

  if (!res.ok) {
    throw new Error(`fetchJobDetail failed: ${res.status}`);
  }
  return res.json();
}
