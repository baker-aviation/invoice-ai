import { NextRequest, NextResponse } from "next/server";
import { requireSuperAdmin, isAuthed, isRateLimited } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";
import { cloudRunFetch } from "@/lib/cloud-run-fetch";

export const dynamic = "force-dynamic";

// Derive Cloud Run URL from service name — all services share the same hash
const CLOUD_RUN_HASH = "hrzd5jf3da-uc";
function serviceUrl(name: string): string {
  return `https://${name}-${CLOUD_RUN_HASH}.a.run.app`;
}

// Cloud Run services with their health endpoints
// Note: /healthz is intercepted by Cloud Run GFE → 404. Use /debug/* or /docs instead.
const SERVICES = [
  { name: "ops-monitor", base: serviceUrl("ops-monitor"), healthPath: "/debug/ics_status" },
  { name: "invoice-ingest", base: serviceUrl("invoice-ingest"), healthPath: "/docs" },
  { name: "invoice-parser", base: serviceUrl("invoice-parser"), healthPath: "/health" },
  { name: "invoice-alerts", base: serviceUrl("invoice-alerts"), healthPath: "/health" },
  { name: "job-ingest", base: serviceUrl("job-ingest"), healthPath: "/_health" },
  { name: "job-parse", base: serviceUrl("job-parse"), healthPath: "/_health" },
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
  status: "ok" | "error" | "unconfigured";
  latencyMs: number | null;
  error?: string;
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
  { slug: "flight-sync", name: "Flight Sync", warnMins: 45 },
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
  const [serviceResults, pipelineData, tableCounts, userData, queueData, faData] = await Promise.all([
    // 1. Service health checks
    Promise.all(
      SERVICES.map(async (svc): Promise<ServiceHealth> => {
        if (!svc.base) return { name: svc.name, status: "unconfigured", latencyMs: null };
        const url = `${svc.base.replace(/\/$/, "")}${svc.healthPath}`;
        const start = Date.now();
        try {
          const res = await cloudRunFetch(url, {
            method: "GET",
            signal: AbortSignal.timeout(10000),
          });
          const latencyMs = Date.now() - start;
          if (res.ok) {
            return { name: svc.name, status: "ok", latencyMs };
          }
          const body = await res.text().catch(() => "");
          return {
            name: svc.name,
            status: "error",
            latencyMs,
            error: `HTTP ${res.status}: ${body.slice(0, 120)}`,
          };
        } catch (e) {
          return {
            name: svc.name,
            status: "error",
            latencyMs: Date.now() - start,
            error: e instanceof Error ? e.message : "Unknown error",
          };
        }
      }),
    ),

    // 2. Pipeline status from pipeline_runs
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
