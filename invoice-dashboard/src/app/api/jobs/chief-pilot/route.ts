import { NextRequest, NextResponse } from "next/server";
import { requireChiefPilotOrAdmin, isAuthed, isRateLimited } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";

/**
 * GET /api/jobs/chief-pilot — Fetch candidates in interview_scheduled stage
 * Available to chief_pilot and admin roles.
 */
export async function GET(req: NextRequest) {
  const auth = await requireChiefPilotOrAdmin(req);
  if (!isAuthed(auth)) return auth.error;

  const supa = createServiceClient();

  const { data, error } = await supa
    .from("job_application_parse")
    .select(
      "id, application_id, candidate_name, email, phone, location, category, employment_type, " +
      "total_time_hours, turbine_time_hours, pic_time_hours, sic_time_hours, " +
      "has_citation_x, has_challenger_300_type_rating, type_ratings, " +
      "has_part_135, has_part_121, pipeline_stage, structured_notes, " +
      "prd_flags, prd_summary, prd_type_ratings, prd_certificate_type, prd_medical_class, " +
      "created_at, notes, interview_email_sent_at"
    )
    .eq("pipeline_stage", "interview_scheduled")
    .is("deleted_at", null)
    .is("rejected_at", null)
    .order("created_at", { ascending: true });

  if (error) {
    return NextResponse.json({ error: "Failed to fetch candidates" }, { status: 500 });
  }

  return NextResponse.json({ ok: true, candidates: data ?? [] });
}

/**
 * PATCH /api/jobs/chief-pilot — Save chief pilot notes for a candidate
 * Body: { application_id: number, chief_pilot_notes: string }
 */
export async function PATCH(req: NextRequest) {
  const auth = await requireChiefPilotOrAdmin(req);
  if (!isAuthed(auth)) return auth.error;

  if (await isRateLimited(auth.userId)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  let body: { application_id?: number; chief_pilot_notes?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { application_id, chief_pilot_notes } = body;
  if (!application_id || typeof application_id !== "number") {
    return NextResponse.json({ error: "application_id is required" }, { status: 400 });
  }

  const supa = createServiceClient();

  // Fetch existing structured_notes to merge
  const { data: existing } = await supa
    .from("job_application_parse")
    .select("structured_notes")
    .eq("application_id", application_id)
    .maybeSingle();

  const currentNotes = (existing?.structured_notes as Record<string, string | null>) ?? {};
  const merged = { ...currentNotes, chief_pilot_notes: chief_pilot_notes ?? null };

  const { error } = await supa
    .from("job_application_parse")
    .update({
      structured_notes: merged,
      updated_at: new Date().toISOString(),
    })
    .eq("application_id", application_id);

  if (error) {
    return NextResponse.json({ error: "Failed to save notes" }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}

/**
 * POST /api/jobs/chief-pilot — Mark interview as complete
 * Body: { application_id: number }
 * Moves candidate from interview_scheduled → interview_post
 */
export async function POST(req: NextRequest) {
  const auth = await requireChiefPilotOrAdmin(req);
  if (!isAuthed(auth)) return auth.error;

  if (await isRateLimited(auth.userId)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  let body: { application_id?: number };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { application_id } = body;
  if (!application_id || typeof application_id !== "number") {
    return NextResponse.json({ error: "application_id is required" }, { status: 400 });
  }

  const supa = createServiceClient();

  // Verify candidate is in interview_scheduled
  const { data: candidate } = await supa
    .from("job_application_parse")
    .select("pipeline_stage")
    .eq("application_id", application_id)
    .maybeSingle();

  if (!candidate) {
    return NextResponse.json({ error: "Candidate not found" }, { status: 404 });
  }

  if (candidate.pipeline_stage !== "interview_scheduled") {
    return NextResponse.json(
      { error: "Candidate is not in interview_scheduled stage" },
      { status: 400 },
    );
  }

  const { error } = await supa
    .from("job_application_parse")
    .update({
      pipeline_stage: "interview_post",
      updated_at: new Date().toISOString(),
    })
    .eq("application_id", application_id);

  if (error) {
    return NextResponse.json({ error: "Failed to update stage" }, { status: 500 });
  }

  return NextResponse.json({ ok: true, stage: "interview_post" });
}
