export const dynamic = "force-dynamic";

import { Topbar } from "@/components/Topbar";
import JobsNav from "../JobsNav";
import LorsTable from "./LorsTable";
import { createServiceClient } from "@/lib/supabase/service";
import { signGcsUrl } from "@/lib/gcs";

async function fetchLors() {
  const supa = createServiceClient();

  const { data: files, error } = await supa
    .from("job_application_files")
    .select("id, application_id, filename, content_type, size_bytes, created_at, gcs_bucket, gcs_key, file_category, linked_parse_id")
    .eq("file_category", "lor")
    .order("created_at", { ascending: false });

  if (error) throw new Error(error.message);

  // Resolve linked candidate names
  const parseIds = (files ?? [])
    .map((f: any) => f.linked_parse_id)
    .filter((id: any): id is number => id != null);

  let candidateMap: Record<number, { name: string; applicationId: number }> = {};
  if (parseIds.length > 0) {
    const { data: candidates } = await supa
      .from("job_application_parse")
      .select("id, candidate_name, application_id")
      .in("id", parseIds);

    for (const c of candidates ?? []) {
      candidateMap[c.id] = {
        name: c.candidate_name ?? "Unknown",
        applicationId: c.application_id,
      };
    }
  }

  // Also fetch all candidates for the attach dropdown
  const { data: allCandidates } = await supa
    .from("job_application_parse")
    .select("id, candidate_name, application_id")
    .order("created_at", { ascending: false })
    .limit(500);

  // Sign URLs
  const enriched = await Promise.all(
    (files ?? []).map(async (f: any) => {
      let signed_url: string | null = null;
      if (f.gcs_bucket && f.gcs_key) {
        signed_url = await signGcsUrl(f.gcs_bucket, f.gcs_key);
      }
      const linked = f.linked_parse_id ? candidateMap[f.linked_parse_id] : null;
      return {
        ...f,
        signed_url,
        linked_candidate_name: linked?.name ?? null,
        linked_application_id: linked?.applicationId ?? null,
      };
    }),
  );

  return {
    files: enriched,
    candidates: (allCandidates ?? []).map((c: any) => ({
      id: c.id,
      name: c.candidate_name ?? "Unknown",
      applicationId: c.application_id,
    })),
  };
}

export default async function LorsPage() {
  const { files, candidates } = await fetchLors();

  return (
    <>
      <Topbar title="Jobs" />
      <JobsNav />
      <LorsTable initialFiles={files} candidates={candidates} />
    </>
  );
}
