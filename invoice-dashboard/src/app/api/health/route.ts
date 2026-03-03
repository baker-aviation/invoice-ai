import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";

export const dynamic = "force-dynamic";

type PipelineCheck = {
  name: string;
  description: string;
  lastActivity: string | null;
  lastStatus: string | null;
  lastMessage: string | null;
  status: "ok" | "warning" | "error" | "unknown";
  staleMins: number;
  thresholdMins: number;
};

// Pipeline definitions: slug must match what each Python service logs
const PIPELINES: {
  slug: string;
  name: string;
  description: string;
  warnAfterMins: number;
}[] = [
  { slug: "flight-sync",       name: "Flight Sync",       description: "JetInsight ICS → flights table (every 30 min)",         warnAfterMins: 45 },
  { slug: "edct-pull",         name: "EDCT Pull",         description: "ForeFlight EDCT emails → ops_alerts (every 5 min)",     warnAfterMins: 15 },
  { slug: "notam-check",       name: "NOTAM Check",       description: "FAA NOTAM API → ops_alerts (every 30 min)",             warnAfterMins: 45 },
  { slug: "invoice-ingest",    name: "Invoice Ingest",    description: "Outlook mailbox → GCS + documents table (every 15 min)",warnAfterMins: 30 },
  { slug: "invoice-parse",     name: "Invoice Parse",     description: "PDFs → OpenAI extraction (every 15 min)",               warnAfterMins: 30 },
  { slug: "alert-generation",  name: "Alert Generation",  description: "Parsed invoices → fee alert rows (every 15 min)",       warnAfterMins: 30 },
  { slug: "slack-flush",       name: "Slack Flush",       description: "Fee alerts → Slack (every 15 min, currently paused)",   warnAfterMins: 30 },
  { slug: "fuel-price-extract",name: "Fuel Price Extract", description: "Invoice fuel prices → fuel_prices table (every 15 min)",warnAfterMins: 30 },
  { slug: "job-ingest",        name: "Job Ingest",        description: "Outlook → job applications (hourly)",                   warnAfterMins: 90 },
  { slug: "job-parse",         name: "Job Parse",         description: "Resumes → OpenAI extraction (hourly)",                  warnAfterMins: 90 },
];

/**
 * GET /api/health
 *
 * Queries the pipeline_runs table for the most recent run of each pipeline.
 * Returns a status for each: "ok" if recent, "warning" if stale, "error" if very stale or last run errored.
 */
export async function GET() {
  try {
    const supa = createServiceClient();

    // Fetch the latest run for each pipeline in a single query
    // We get the most recent runs and group client-side (simpler than DISTINCT ON via PostgREST)
    const { data: runs, error } = await supa
      .from("pipeline_runs")
      .select("pipeline, status, message, items, created_at")
      .order("created_at", { ascending: false })
      .limit(100);

    // Build a map: pipeline slug → latest run
    const latestByPipeline = new Map<string, { created_at: string; status: string; message: string | null }>();
    if (runs && !error) {
      for (const run of runs) {
        const slug = run.pipeline as string;
        if (!latestByPipeline.has(slug)) {
          latestByPipeline.set(slug, {
            created_at: run.created_at as string,
            status: run.status as string,
            message: run.message as string | null,
          });
        }
      }
    }

    const results: PipelineCheck[] = PIPELINES.map((p) => {
      const latest = latestByPipeline.get(p.slug);

      if (!latest) {
        return {
          name: p.name,
          description: p.description,
          lastActivity: null,
          lastStatus: null,
          lastMessage: null,
          status: "unknown" as const,
          staleMins: -1,
          thresholdMins: p.warnAfterMins,
        };
      }

      const staleMins = Math.round(
        (Date.now() - new Date(latest.created_at).getTime()) / 60_000,
      );

      let status: PipelineCheck["status"];
      if (latest.status === "error") {
        // Last run was an error — show as error regardless of freshness
        status = "error";
      } else if (staleMins <= p.warnAfterMins) {
        status = "ok";
      } else if (staleMins <= p.warnAfterMins * 3) {
        status = "warning";
      } else {
        status = "error";
      }

      return {
        name: p.name,
        description: p.description,
        lastActivity: latest.created_at,
        lastStatus: latest.status,
        lastMessage: latest.message,
        status,
        staleMins,
        thresholdMins: p.warnAfterMins,
      };
    });

    const overall =
      results.some((r) => r.status === "error")
        ? "error"
        : results.some((r) => r.status === "warning")
          ? "warning"
          : results.every((r) => r.status === "ok")
            ? "ok"
            : "unknown";

    return NextResponse.json({
      overall,
      checked_at: new Date().toISOString(),
      pipelines: results,
    });
  } catch (e) {
    return NextResponse.json(
      { overall: "error", error: String(e), pipelines: [] },
      { status: 500 },
    );
  }
}
