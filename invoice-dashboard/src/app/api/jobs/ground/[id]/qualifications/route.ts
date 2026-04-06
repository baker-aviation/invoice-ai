import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, isAuthed, isRateLimited } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";

/** GET /api/jobs/ground/[id]/qualifications */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAdmin(req);
  if (!isAuthed(auth)) return auth.error;

  const { id } = await params;
  const applicationId = Number(id);
  if (!applicationId || isNaN(applicationId)) {
    return NextResponse.json({ error: "Invalid application ID" }, { status: 400 });
  }

  const supa = createServiceClient();
  const { data, error } = await supa
    .from("job_application_parse")
    .select("ground_qualifications")
    .eq("application_id", applicationId)
    .maybeSingle();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ error: "Not found" }, { status: 404 });

  return NextResponse.json({ ok: true, qualifications: data.ground_qualifications ?? {} });
}

/** PATCH /api/jobs/ground/[id]/qualifications */
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

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const supa = createServiceClient();

  // Merge with existing qualifications
  const { data: existing } = await supa
    .from("job_application_parse")
    .select("ground_qualifications")
    .eq("application_id", applicationId)
    .maybeSingle();

  const merged = { ...(existing?.ground_qualifications ?? {}), ...body };

  const { error } = await supa
    .from("job_application_parse")
    .update({
      ground_qualifications: merged,
      updated_at: new Date().toISOString(),
    })
    .eq("application_id", applicationId);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true, qualifications: merged });
}
