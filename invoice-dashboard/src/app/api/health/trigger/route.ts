import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, isAuthed, isRateLimited } from "@/lib/api-auth";
import { cloudRunFetch } from "@/lib/cloud-run-fetch";

const OPS_BASE = process.env.OPS_API_BASE_URL;
const INVOICE_BASE = process.env.INVOICE_API_BASE_URL;
const JOB_BASE = process.env.JOB_API_BASE_URL;

// Map pipeline slugs to their Cloud Run endpoints
const PIPELINE_ENDPOINTS: Record<string, { base: string | undefined; path: string }> = {
  "flight-sync":       { base: OPS_BASE,     path: "/jobs/sync_schedule" },
  "edct-pull":         { base: OPS_BASE,     path: "/jobs/pull_edct" },
  "notam-check":       { base: OPS_BASE,     path: "/jobs/check_notams" },
  "invoice-ingest":    { base: INVOICE_BASE, path: "/jobs/pull_mailbox" },
  "invoice-parse":     { base: INVOICE_BASE, path: "/jobs/parse_next" },
  "alert-generation":  { base: INVOICE_BASE, path: "/jobs/run_alerts_next" },
  "slack-flush":       { base: INVOICE_BASE, path: "/jobs/flush_alerts" },
  "job-ingest":        { base: JOB_BASE,     path: "/jobs/pull_applicants" },
  "job-parse":         { base: JOB_BASE,     path: "/jobs/parse_next" },
};

export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (!isAuthed(auth)) return auth.error;

  if (await isRateLimited(auth.userId, 3)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  const { pipeline } = await req.json().catch(() => ({ pipeline: null }));
  if (!pipeline || typeof pipeline !== "string") {
    return NextResponse.json({ error: "Missing pipeline slug" }, { status: 400 });
  }

  const endpoint = PIPELINE_ENDPOINTS[pipeline];
  if (!endpoint) {
    return NextResponse.json({ error: "Unknown pipeline" }, { status: 400 });
  }

  if (!endpoint.base) {
    return NextResponse.json({ error: "Service URL not configured" }, { status: 503 });
  }

  const url = `${endpoint.base.replace(/\/$/, "")}${endpoint.path}`;

  try {
    const res = await cloudRunFetch(url, { method: "POST", cache: "no-store" });
    const data = await res.json().catch(() => ({}));
    return NextResponse.json(data, { status: res.ok ? 200 : res.status });
  } catch {
    return NextResponse.json({ error: "Upstream unavailable" }, { status: 502 });
  }
}
