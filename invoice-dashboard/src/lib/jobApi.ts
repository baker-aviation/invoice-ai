import { createServiceClient } from "@/lib/supabase/service";
import type { HiringStage, JobDetailResponse, JobRow, JobsListResponse } from "@/lib/types";

// ---------------------------------------------------------------------------
// Jobs list — direct Supabase query to job_application_parse
// ---------------------------------------------------------------------------

const JOB_COLUMNS =
  "id, application_id, created_at, updated_at, hiring_stage, category, employment_type, candidate_name, email, phone, location, total_time_hours, turbine_time_hours, pic_time_hours, sic_time_hours, has_citation_x, has_challenger_300_type_rating, type_ratings, soft_gate_pic_met, soft_gate_pic_status, needs_review, notes, model";

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
      hiring_stage: fields.hiring_stage ?? "new",
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
  const base = mustBase();
  const urlStr = `${base}/api/jobs/${applicationId}`;

  const res = await fetch(urlStr, {
    cache: "no-store",
    headers: { Accept: "application/json" },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`fetchJobDetail failed: ${res.status} url=${urlStr} body=${body.slice(0, 800)}`);
  }
  return res.json();
}
