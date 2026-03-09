import { NextRequest, NextResponse } from "next/server";
import { requireSuperAdmin, isAuthed, isRateLimited } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";

export const dynamic = "force-dynamic";

// Map Cloud Run services → the pipeline slugs that prove they're running.
// If ANY mapped pipeline ran successfully recently, the service is "ok".
const SERVICE_PIPELINE_MAP: { name: string; pipelines: string[]; warnMins: number }[] = [
  { name: "ops-monitor", pipelines: ["flight-sync", "edct-pull", "notam-check"], warnMins: 10 },
  { name: "invoice-ingest", pipelines: ["invoice-ingest"], warnMins: 30 },
  { name: "invoice-parser", pipelines: ["invoice-parse"], warnMins: 30 },
  { name: "invoice-alerts", pipelines: ["alert-generation", "slack-flush"], warnMins: 30 },
  { name: "job-ingest", pipelines: ["job-ingest"], warnMins: 90 },
  { name: "job-parse", pipelines: ["job-parse"], warnMins: 90 },
];

// Key tables to get row counts for
const TABLE_COUNTS = [
  "flights",
  "ops_alerts",
  "parsed_invoices",
  "invoice_alerts",
  "fuel_prices",
  "fbo_advertised_prices",
  "job_applications",
  "pipeline_runs",
  "invoice_alert_rules",
];

type ServiceHealth = {
  name: string;
  status: "ok" | "warning" | "error" | "unknown";
  lastRun: string | null;
  staleMins: number;
};

type PipelineStatus = {
  slug: string;
  name: string;
  lastRun: string | null;
  lastStatus: string | null;
  lastMessage: string | null;
  staleMins: number;
  status: "ok" | "warning" | "error" | "unknown";
};

type TableCount = {
  table: string;
  count: number | null;
  error?: string;
};

type UserInfo = {
  id: string;
  email: string;
  role: string | null;
  lastSignIn: string | null;
  createdAt: string;
  isSuperAdmin: boolean;
};

const PIPELINES = [
  { slug: "flight-sync", name: "Flight Sync", warnMins: 10 },
  { slug: "edct-pull", name: "EDCT Pull", warnMins: 15 },
  { slug: "notam-check", name: "NOTAM Check", warnMins: 45 },
  { slug: "invoice-ingest", name: "Invoice Ingest", warnMins: 30 },
  { slug: "invoice-parse", name: "Invoice Parse", warnMins: 30 },
  { slug: "alert-generation", name: "Alert Generation", warnMins: 30 },
  { slug: "slack-flush", name: "Slack Flush", warnMins: 30 },
  { slug: "fuel-price-extract", name: "Fuel Price Extract", warnMins: 30 },
  { slug: "job-ingest", name: "Job Ingest", warnMins: 90 },
  { slug: "job-parse", name: "Job Parse", warnMins: 90 },
];

/**
 * GET /api/admin/super
 *
 * Super admin dashboard data — service health, pipeline status,
 * database stats, user list, and queue depths.
 * Locked to super_admin users only.
 */
export async function GET(req: NextRequest) {
  const auth = await requireSuperAdmin(req);
  if (!isAuthed(auth)) return auth.error;
  if (isRateLimited(auth.userId, 10)) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const supa = createServiceClient();

  // Run all queries in parallel
  const [pipelineData, tableCounts, userData, queueData, faData] = await Promise.all([
    // 1. Pipeline status from pipeline_runs
    supa
      .from("pipeline_runs")
      .select("pipeline, status, message, created_at")
      .order("created_at", { ascending: false })
      .limit(100)
      .then(({ data }) => data ?? []),

    // 3. Table row counts
    Promise.all(
      TABLE_COUNTS.map(async (table): Promise<TableCount> => {
        try {
          const { count, error } = await supa
            .from(table)
            .select("*", { count: "exact", head: true });
          return { table, count: count ?? 0, error: error?.message };
        } catch {
          return { table, count: null, error: "Query failed" };
        }
      }),
    ),

    // 4. User list
    supa.auth.admin.listUsers({ perPage: 100 }).then(({ data }) =>
      (data?.users ?? []).map((u): UserInfo => ({
        id: u.id,
        email: u.email ?? "",
        role: (u.app_metadata?.role as string) ?? null,
        lastSignIn: u.last_sign_in_at ?? null,
        createdAt: u.created_at,
        isSuperAdmin: !!u.app_metadata?.super_admin,
      })),
    ),

    // 5. Queue depths — docs pending parse, alerts pending send
    Promise.all([
      supa
        .from("parsed_invoices")
        .select("*", { count: "exact", head: true })
        .is("vendor_name", null)
        .then(({ count }) => ({ queue: "pending_parse", count: count ?? 0 })),
      supa
        .from("invoice_alerts")
        .select("*", { count: "exact", head: true })
        .is("sent_at", null)
        .then(({ count }) => ({ queue: "pending_alerts", count: count ?? 0 })),
      supa
        .from("ops_alerts")
        .select("*", { count: "exact", head: true })
        .is("acknowledged_at", null)
        .then(({ count }) => ({ queue: "unacked_ops_alerts", count: count ?? 0 })),
    ]),

    // 6. FlightAware API check
    fetch(`${req.nextUrl.origin}/api/aircraft/flights`, { cache: "no-store" })
      .then((r) => r.json())
      .then((json) => ({
        status: json.count > 0 ? "ok" : json.error ? "error" : "unknown",
        count: json.count ?? 0,
        cached: json.cached ?? false,
        error: json.error ?? null,
      }))
      .catch(() => ({ status: "error", count: 0, cached: false, error: "Failed" })),
  ]);

  // Process pipeline data
  const latestByPipeline = new Map<string, { created_at: string; status: string; message: string | null }>();
  for (const run of pipelineData) {
    const slug = run.pipeline as string;
    if (!latestByPipeline.has(slug)) {
      latestByPipeline.set(slug, {
        created_at: run.created_at as string,
        status: run.status as string,
        message: run.message as string | null,
      });
    }
  }

  const pipelines: PipelineStatus[] = PIPELINES.map((p) => {
    const latest = latestByPipeline.get(p.slug);
    if (!latest) {
      return { slug: p.slug, name: p.name, lastRun: null, lastStatus: null, lastMessage: null, staleMins: -1, status: "unknown" as const };
    }
    const staleMins = Math.round((Date.now() - new Date(latest.created_at).getTime()) / 60_000);
    let status: PipelineStatus["status"];
    if (latest.status === "error") status = "error";
    else if (staleMins <= p.warnMins) status = "ok";
    else if (staleMins <= p.warnMins * 3) status = "warning";
    else status = "error";
    return { slug: p.slug, name: p.name, lastRun: latest.created_at, lastStatus: latest.status, lastMessage: latest.message, staleMins, status };
  });

  // Derive Cloud Run service health from their pipeline runs
  const serviceResults: ServiceHealth[] = SERVICE_PIPELINE_MAP.map((svc) => {
    // Find the most recent successful run across all pipelines for this service
    let bestRun: { created_at: string; status: string } | null = null;
    for (const slug of svc.pipelines) {
      const latest = latestByPipeline.get(slug);
      if (!latest) continue;
      if (!bestRun || new Date(latest.created_at) > new Date(bestRun.created_at)) {
        bestRun = latest;
      }
    }
    if (!bestRun) {
      return { name: svc.name, status: "unknown" as const, lastRun: null, staleMins: -1 };
    }
    const staleMins = Math.round((Date.now() - new Date(bestRun.created_at).getTime()) / 60_000);
    let status: ServiceHealth["status"];
    if (bestRun.status === "error") status = "error";
    else if (staleMins <= svc.warnMins) status = "ok";
    else if (staleMins <= svc.warnMins * 3) status = "warning";
    else status = "error";
    return { name: svc.name, status, lastRun: bestRun.created_at, staleMins };
  });

  return NextResponse.json({
    checked_at: new Date().toISOString(),
    services: serviceResults,
    pipelines,
    tables: tableCounts,
    users: userData,
    queues: queueData,
    flightaware: faData,
  });
}
