import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, isAuthed, isRateLimited } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";
import { PIPELINE_STAGES } from "@/lib/types";

/**
 * GET /api/jobs/next-in-stage?stage=tims_review&exclude=123
 * Returns the next candidate in the given pipeline stage (by created_at desc),
 * excluding the specified application_id.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (!isAuthed(auth)) return auth.error;
  if (await isRateLimited(auth.userId))
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });

  const stage = req.nextUrl.searchParams.get("stage");
  const exclude = req.nextUrl.searchParams.get("exclude");

  if (!stage || !(PIPELINE_STAGES as readonly string[]).includes(stage)) {
    return NextResponse.json({ error: "Invalid stage" }, { status: 400 });
  }

  const supa = createServiceClient();

  let query = supa
    .from("job_application_parse")
    .select("application_id")
    .eq("pipeline_stage", stage)
    .is("deleted_at", null)
    .is("rejected_at", null)
    .order("created_at", { ascending: false })
    .limit(1);

  if (exclude) {
    query = query.neq("application_id", Number(exclude));
  }

  const { data, error } = await query.maybeSingle();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({
    application_id: data?.application_id ?? null,
  });
}
