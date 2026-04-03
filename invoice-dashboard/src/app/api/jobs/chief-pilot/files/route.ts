import { NextRequest, NextResponse } from "next/server";
import { requireChiefPilotOrAdmin, isAuthed } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";
import { signGcsUrl } from "@/lib/gcs";

/**
 * GET /api/jobs/chief-pilot/files?application_id=123
 * Returns files with signed URLs for a candidate. Available to chief_pilot and admin.
 */
export async function GET(req: NextRequest) {
  const auth = await requireChiefPilotOrAdmin(req);
  if (!isAuthed(auth)) return auth.error;

  const applicationId = Number(req.nextUrl.searchParams.get("application_id"));
  if (!applicationId || isNaN(applicationId)) {
    return NextResponse.json({ error: "application_id is required" }, { status: 400 });
  }

  const supa = createServiceClient();

  // Verify this candidate is in interview_scheduled (or admin can see any)
  if (auth.role === "chief_pilot") {
    const { data: candidate } = await supa
      .from("job_application_parse")
      .select("pipeline_stage")
      .eq("application_id", applicationId)
      .maybeSingle();

    if (!candidate || candidate.pipeline_stage !== "interview_scheduled") {
      return NextResponse.json({ error: "Candidate not found" }, { status: 404 });
    }
  }

  const { data: fileRows } = await supa
    .from("job_application_files")
    .select("id, filename, content_type, size_bytes, created_at, gcs_bucket, gcs_key, file_category")
    .eq("application_id", applicationId)
    .order("created_at", { ascending: true });

  const files = await Promise.all(
    (fileRows ?? []).map(async (f) => {
      let signed_url: string | null = null;
      if (f.gcs_bucket && f.gcs_key) {
        signed_url = await signGcsUrl(f.gcs_bucket as string, f.gcs_key as string);
      }
      if (!signed_url) signed_url = `/api/files/${f.id}`;
      return {
        id: f.id,
        filename: f.filename,
        content_type: f.content_type,
        size_bytes: f.size_bytes,
        created_at: f.created_at,
        signed_url,
        file_category: f.file_category ?? null,
      };
    }),
  );

  return NextResponse.json({ ok: true, files });
}
