import { NextRequest, NextResponse } from "next/server";
import { verifyCronSecret } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";

export const dynamic = "force-dynamic";

/**
 * GET /api/cron/hiring-onboarding-archive
 *
 * Moves candidates from "hired" → "onboarding" after 7 days.
 * The "onboarding" stage is hidden from the pipeline board, keeping
 * the hired column clean while preserving the records.
 *
 * Run daily via Cloud Scheduler.
 */
export async function GET(req: NextRequest) {
  if (!verifyCronSecret(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supa = createServiceClient();
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  // Find candidates in "hired" stage whose updated_at is older than 7 days
  const { data: candidates, error: fetchErr } = await supa
    .from("job_application_parse")
    .select("application_id, candidate_name, updated_at")
    .eq("pipeline_stage", "hired")
    .is("deleted_at", null)
    .lt("updated_at", sevenDaysAgo);

  if (fetchErr) {
    console.error("[onboarding-archive] Fetch error:", fetchErr);
    return NextResponse.json({ error: "Failed to fetch hired candidates" }, { status: 500 });
  }

  if (!candidates || candidates.length === 0) {
    return NextResponse.json({ ok: true, archived: 0, message: "No candidates to archive" });
  }

  const appIds = candidates.map((c) => c.application_id);
  const now = new Date().toISOString();

  const { error: updateErr } = await supa
    .from("job_application_parse")
    .update({ pipeline_stage: "onboarding", updated_at: now })
    .in("application_id", appIds);

  if (updateErr) {
    console.error("[onboarding-archive] Update error:", updateErr);
    return NextResponse.json({ error: "Failed to archive candidates" }, { status: 500 });
  }

  console.log(
    `[onboarding-archive] Archived ${candidates.length} candidate(s):`,
    candidates.map((c) => c.candidate_name).join(", "),
  );

  return NextResponse.json({
    ok: true,
    archived: candidates.length,
    candidates: candidates.map((c) => ({
      application_id: c.application_id,
      name: c.candidate_name,
    })),
  });
}
