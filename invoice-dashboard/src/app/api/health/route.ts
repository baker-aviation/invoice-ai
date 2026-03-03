import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";

export const dynamic = "force-dynamic";

type PipelineCheck = {
  name: string;
  description: string;
  lastActivity: string | null;
  status: "ok" | "warning" | "error" | "unknown";
  staleMins: number;
  thresholdMins: number;
};

/**
 * GET /api/health
 *
 * Queries Supabase for the most recent activity timestamp in each pipeline.
 * Returns a status for each: "ok" if recent, "warning" if stale, "error" if very stale.
 */
export async function GET() {
  try {
    const supa = createServiceClient();

    // Define pipelines with their staleness thresholds (minutes)
    const checks: {
      name: string;
      description: string;
      warnAfterMins: number;
      query: () => Promise<string | null>;
    }[] = [
      {
        name: "Flight Sync",
        description: "JetInsight ICS → flights table (every 30 min)",
        warnAfterMins: 45,
        query: async () => {
          const { data } = await supa
            .from("flights")
            .select("updated_at")
            .order("updated_at", { ascending: false })
            .limit(1)
            .single();
          return data?.updated_at ?? null;
        },
      },
      {
        name: "EDCT Pull",
        description: "ForeFlight EDCT emails → ops_alerts (every 5 min)",
        warnAfterMins: 15,
        query: async () => {
          const { data } = await supa
            .from("ops_alerts")
            .select("created_at")
            .eq("alert_type", "edct")
            .order("created_at", { ascending: false })
            .limit(1)
            .single();
          return data?.created_at ?? null;
        },
      },
      {
        name: "NOTAM Check",
        description: "FAA NOTAM API → ops_alerts (every 30 min)",
        warnAfterMins: 45,
        query: async () => {
          const { data } = await supa
            .from("ops_alerts")
            .select("created_at")
            .eq("alert_type", "notam")
            .order("created_at", { ascending: false })
            .limit(1)
            .single();
          return data?.created_at ?? null;
        },
      },
      {
        name: "Invoice Ingest",
        description: "Outlook mailbox → GCS + documents table (every 15 min)",
        warnAfterMins: 30,
        query: async () => {
          const { data } = await supa
            .from("documents")
            .select("created_at")
            .order("created_at", { ascending: false })
            .limit(1)
            .single();
          return data?.created_at ?? null;
        },
      },
      {
        name: "Invoice Parse",
        description: "PDFs → OpenAI extraction (every 15 min)",
        warnAfterMins: 30,
        query: async () => {
          const { data } = await supa
            .from("documents")
            .select("updated_at")
            .eq("status", "parsed")
            .order("updated_at", { ascending: false })
            .limit(1)
            .single();
          return data?.updated_at ?? null;
        },
      },
      {
        name: "Alert Generation",
        description: "Parsed invoices → fee alert rows (every 15 min)",
        warnAfterMins: 30,
        query: async () => {
          const { data } = await supa
            .from("invoice_alerts")
            .select("created_at")
            .order("created_at", { ascending: false })
            .limit(1)
            .single();
          return data?.created_at ?? null;
        },
      },
      {
        name: "Slack Flush",
        description: "Fee alerts → Slack (every 15 min)",
        warnAfterMins: 30,
        query: async () => {
          const { data } = await supa
            .from("invoice_alerts")
            .select("updated_at")
            .eq("slack_status", "sent")
            .order("updated_at", { ascending: false })
            .limit(1)
            .single();
          return data?.updated_at ?? null;
        },
      },
      {
        name: "Job Ingest",
        description: "Outlook → job applications (hourly)",
        warnAfterMins: 90,
        query: async () => {
          const { data } = await supa
            .from("job_applications")
            .select("created_at")
            .order("created_at", { ascending: false })
            .limit(1)
            .single();
          return data?.created_at ?? null;
        },
      },
      {
        name: "Job Parse",
        description: "Resumes → OpenAI extraction (hourly)",
        warnAfterMins: 90,
        query: async () => {
          const { data } = await supa
            .from("job_application_parse")
            .select("created_at")
            .order("created_at", { ascending: false })
            .limit(1)
            .single();
          return data?.created_at ?? null;
        },
      },
    ];

    const results: PipelineCheck[] = await Promise.all(
      checks.map(async (c) => {
        try {
          const lastActivity = await c.query();
          const staleMins = lastActivity
            ? Math.round((Date.now() - new Date(lastActivity).getTime()) / 60_000)
            : -1;

          let status: PipelineCheck["status"] = "unknown";
          if (lastActivity) {
            if (staleMins <= c.warnAfterMins) status = "ok";
            else if (staleMins <= c.warnAfterMins * 3) status = "warning";
            else status = "error";
          }

          return {
            name: c.name,
            description: c.description,
            lastActivity,
            status,
            staleMins,
            thresholdMins: c.warnAfterMins,
          };
        } catch {
          return {
            name: c.name,
            description: c.description,
            lastActivity: null,
            status: "unknown" as const,
            staleMins: -1,
            thresholdMins: c.warnAfterMins,
          };
        }
      }),
    );

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
