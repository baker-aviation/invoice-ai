import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthed, isRateLimited } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";

/**
 * GET /api/jobs/[id]/offer
 * Generate an offer letter preview for a candidate.
 * [id] = application_id
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;
  if (await isRateLimited(auth.userId)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  const { id } = await params;
  const applicationId = Number(id);
  if (!applicationId || isNaN(applicationId)) {
    return NextResponse.json({ error: "Invalid application ID" }, { status: 400 });
  }

  const supa = createServiceClient();

  // Fetch candidate data
  const { data: candidate, error: candidateErr } = await supa
    .from("job_application_parse")
    .select("candidate_name, email, category")
    .eq("application_id", applicationId)
    .maybeSingle();

  if (candidateErr) {
    return NextResponse.json({ error: candidateErr.message }, { status: 500 });
  }
  if (!candidate) {
    return NextResponse.json({ error: "Candidate not found" }, { status: 404 });
  }

  // Determine role from category
  const role = candidate.category === "pilot_pic" ? "pic" : "sic";

  // Fetch the matching template
  const { data: template, error: templateErr } = await supa
    .from("offer_templates")
    .select("html_body, role")
    .eq("role", role)
    .maybeSingle();

  if (templateErr) {
    return NextResponse.json({ error: templateErr.message }, { status: 500 });
  }
  if (!template) {
    return NextResponse.json(
      { error: `No offer template found for role "${role}". Create one in Admin first.` },
      { status: 404 },
    );
  }

  // Format today's date
  const today = new Date();
  const formattedDate = today.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  // Replace merge fields
  const html = template.html_body
    .replace(/\{\{candidate_name\}\}/g, candidate.candidate_name ?? "")
    .replace(/\{\{date\}\}/g, formattedDate)
    .replace(/\{\{email\}\}/g, candidate.email ?? "");

  return NextResponse.json({
    html,
    role: template.role,
    candidate_name: candidate.candidate_name ?? "",
  });
}
