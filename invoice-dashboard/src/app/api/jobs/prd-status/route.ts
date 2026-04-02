import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, isAuthed } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";

export const dynamic = "force-dynamic";

/**
 * GET /api/jobs/prd-status
 * Returns a set of application_ids that have a PRD file uploaded.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (!isAuthed(auth)) return auth.error;

  const supa = createServiceClient();

  // Get all candidates in prd_faa_review
  const { data: candidates } = await supa
    .from("job_application_parse")
    .select("id, application_id")
    .eq("pipeline_stage", "prd_faa_review")
    .is("deleted_at", null);

  if (!candidates || candidates.length === 0) {
    return NextResponse.json({ ok: true, withPrd: [] });
  }

  const appIds = candidates.map((c) => c.application_id);

  // Check which ones have PRD files (by application_id — works whether linked_parse_id is set or not)
  const { data: prdFiles } = await supa
    .from("job_application_files")
    .select("application_id")
    .in("application_id", appIds)
    .eq("file_category", "prd");

  const prdAppIds = new Set((prdFiles ?? []).map((f) => f.application_id));
  const withPrd = candidates
    .filter((c) => prdAppIds.has(c.application_id))
    .map((c) => c.application_id);

  return NextResponse.json({ ok: true, withPrd });
}
