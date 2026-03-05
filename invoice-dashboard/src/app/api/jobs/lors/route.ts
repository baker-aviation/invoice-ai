import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { signGcsUrl } from "@/lib/gcs";
import { requireAuth, requireAdmin, isRateLimited } from "@/lib/api-auth";

export const dynamic = "force-dynamic";

/**
 * GET /api/jobs/lors — list all LOR files with linked candidate info
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if ("error" in auth) return auth.error;

  const supa = createServiceClient();

  const { data: files, error } = await supa
    .from("job_application_files")
    .select("id, application_id, filename, content_type, size_bytes, created_at, gcs_bucket, gcs_key, file_category, linked_parse_id")
    .eq("file_category", "lor")
    .order("created_at", { ascending: false });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Resolve linked candidate names
  const parseIds = (files ?? [])
    .map((f) => f.linked_parse_id)
    .filter((id): id is number => id != null);

  let candidateMap: Record<number, string> = {};
  if (parseIds.length > 0) {
    const { data: candidates } = await supa
      .from("job_application_parse")
      .select("id, candidate_name, application_id")
      .in("id", parseIds);

    for (const c of candidates ?? []) {
      candidateMap[c.id] = c.candidate_name ?? "Unknown";
    }
  }

  // Sign URLs and enrich with candidate info
  const enriched = await Promise.all(
    (files ?? []).map(async (f) => {
      let signed_url: string | null = null;
      if (f.gcs_bucket && f.gcs_key) {
        signed_url = await signGcsUrl(f.gcs_bucket, f.gcs_key);
      }
      return {
        ...f,
        signed_url,
        linked_candidate_name: f.linked_parse_id ? candidateMap[f.linked_parse_id] ?? null : null,
      };
    }),
  );

  return NextResponse.json({ ok: true, count: enriched.length, files: enriched });
}

/**
 * PATCH /api/jobs/lors — link/unlink a LOR to a candidate profile
 * Body: { file_id: number, linked_parse_id: number | null }
 */
export async function PATCH(req: NextRequest) {
  const auth = await requireAdmin(req);
  if ("error" in auth) return auth.error;
  if (isRateLimited(auth.userId)) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  let body: Record<string, any>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const fileId = body.file_id;
  const linkedParseId = body.linked_parse_id ?? null;

  if (!fileId || typeof fileId !== "number") {
    return NextResponse.json({ error: "file_id is required" }, { status: 400 });
  }

  if (linkedParseId !== null && typeof linkedParseId !== "number") {
    return NextResponse.json({ error: "linked_parse_id must be a number or null" }, { status: 400 });
  }

  const supa = createServiceClient();

  const { error } = await supa
    .from("job_application_files")
    .update({ linked_parse_id: linkedParseId })
    .eq("id", fileId);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
