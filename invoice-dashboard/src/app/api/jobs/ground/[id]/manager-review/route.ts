import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, isAuthed, isRateLimited } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";
import { postSlackMessage } from "@/lib/slack";

/**
 * PATCH /api/jobs/ground/[id]/manager-review
 * Body: { decision: "approved" | "rejected", notes?: string }
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

  let body: { decision?: string; notes?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { decision, notes } = body;
  if (decision !== "approved" && decision !== "rejected") {
    return NextResponse.json({ error: 'decision must be "approved" or "rejected"' }, { status: 400 });
  }

  const supa = createServiceClient();

  const { data: candidate } = await supa
    .from("job_application_parse")
    .select("candidate_name, category, pipeline_stage")
    .eq("application_id", applicationId)
    .maybeSingle();

  if (!candidate) {
    return NextResponse.json({ error: "Application not found" }, { status: 404 });
  }

  const now = new Date().toISOString();
  const { error: updateErr } = await supa
    .from("job_application_parse")
    .update({
      manager_review_status: decision,
      manager_review_by: auth.email,
      manager_review_at: now,
      manager_review_notes: notes ?? null,
      updated_at: now,
    })
    .eq("application_id", applicationId);

  if (updateErr) {
    return NextResponse.json({ error: "Database operation failed" }, { status: 500 });
  }

  // Slack notification
  try {
    const emoji = decision === "approved" ? ":white_check_mark:" : ":x:";
    await postSlackMessage({
      channel: process.env.SLACK_HIRING_CHANNEL_ID || "C0AQ54QT98B",
      text: `[Ground] ${emoji} Manager ${decision} ${candidate.candidate_name ?? "Unknown"} (${candidate.category ?? "unknown role"})${notes ? ` — ${notes}` : ""}`,
    });
  } catch {}

  return NextResponse.json({ ok: true, decision, reviewedBy: auth.email });
}
