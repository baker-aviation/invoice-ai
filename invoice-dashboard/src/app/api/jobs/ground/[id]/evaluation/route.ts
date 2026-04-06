import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, isAuthed, isRateLimited } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";

const VALID_EVAL_TYPES = ["technical_assessment", "sales_exercise", "practical_test"];

/**
 * PATCH /api/jobs/ground/[id]/evaluation
 * Body: { type: string, score?: number, notes?: string, passed?: boolean }
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAdmin(req);
  if (!isAuthed(auth)) return auth.error;
  if (await isRateLimited(auth.userId)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  const { id } = await params;
  const applicationId = Number(id);
  if (!applicationId || isNaN(applicationId)) {
    return NextResponse.json({ error: "Invalid application ID" }, { status: 400 });
  }

  let body: { type?: string; score?: number; notes?: string; passed?: boolean };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { type, score, notes, passed } = body;
  if (!type || !VALID_EVAL_TYPES.includes(type)) {
    return NextResponse.json({ error: `type must be one of: ${VALID_EVAL_TYPES.join(", ")}` }, { status: 400 });
  }

  const supa = createServiceClient();

  // Merge with existing evaluations
  const { data: existing } = await supa
    .from("job_application_parse")
    .select("ground_evaluations")
    .eq("application_id", applicationId)
    .maybeSingle();

  if (!existing) {
    return NextResponse.json({ error: "Application not found" }, { status: 404 });
  }

  const evaluations = existing.ground_evaluations ?? {};
  evaluations[type] = {
    ...(evaluations[type] ?? {}),
    score: score ?? evaluations[type]?.score ?? null,
    notes: notes ?? evaluations[type]?.notes ?? null,
    passed: passed ?? evaluations[type]?.passed ?? null,
    completed_at: new Date().toISOString(),
    evaluated_by: auth.email,
  };

  const { error } = await supa
    .from("job_application_parse")
    .update({
      ground_evaluations: evaluations,
      updated_at: new Date().toISOString(),
    })
    .eq("application_id", applicationId);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true, evaluations });
}
