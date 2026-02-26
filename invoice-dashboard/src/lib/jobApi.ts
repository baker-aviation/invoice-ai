import { JobDetailResponse, JobsListResponse } from "@/lib/types";

const BASE = process.env.JOB_API_BASE_URL;

function mustBase(): string {
  if (!BASE) throw new Error("Missing JOB_API_BASE_URL in .env.local");
  return BASE.replace(/\/$/, "");
}

async function throwHttpError(res: Response, url: string, label: string): Promise<never> {
  let body = "";
  try {
    body = await res.text();
  } catch {
    body = "";
  }
  const snippet = body ? body.slice(0, 800) : "(empty body)";
  throw new Error(`${label} failed: ${res.status} url=${url} body=${snippet}`);
}

export async function fetchJobs(
  params: {
    limit?: number;
    q?: string;
    category?: string;
    employment_type?: string;
    needs_review?: "true" | "false";
    soft_gate_pic_met?: "true" | "false";

    // ✅ NEW
    has_citation_x?: "true" | "false";

    // already supported
    has_challenger_300_type_rating?: "true" | "false";
  } = {}
): Promise<JobsListResponse> {
  const base = mustBase();
  const url = new URL(`${base}/api/jobs`);

  url.searchParams.set("limit", String(params.limit ?? 100));
  if (params.q) url.searchParams.set("q", params.q);
  if (params.category) url.searchParams.set("category", params.category);
  if (params.employment_type) url.searchParams.set("employment_type", params.employment_type);
  if (params.needs_review) url.searchParams.set("needs_review", params.needs_review);
  if (params.soft_gate_pic_met) url.searchParams.set("soft_gate_pic_met", params.soft_gate_pic_met);

  // ✅ NEW
  if (params.has_citation_x) url.searchParams.set("has_citation_x", params.has_citation_x);

  if (params.has_challenger_300_type_rating) {
    url.searchParams.set("has_challenger_300_type_rating", params.has_challenger_300_type_rating);
  }

  const urlStr = url.toString();
  const res = await fetch(urlStr, {
    cache: "no-store",
    headers: { Accept: "application/json" },
  });

  if (!res.ok) return throwHttpError(res, urlStr, "fetchJobs");
  return res.json();
}

export async function fetchJobDetail(applicationId: string | number): Promise<JobDetailResponse> {
  const base = mustBase();
  const urlStr = `${base}/api/jobs/${applicationId}`;

  const res = await fetch(urlStr, {
    cache: "no-store",
    headers: { Accept: "application/json" },
  });

  if (!res.ok) return throwHttpError(res, urlStr, "fetchJobDetail");
  return res.json();
}