export const dynamic = "force-dynamic";

import { Topbar } from "@/components/Topbar";
import JobsNav from "../JobsNav";
import RejectedTable from "../rejected/RejectedTable";
import { createServiceClient } from "@/lib/supabase/service";
import { GROUND_CATEGORIES } from "@/lib/groundPipeline";

async function fetchGroundRejected() {
  const supa = createServiceClient();

  const { data, error } = await supa
    .from("job_application_parse")
    .select(
      "id, application_id, candidate_name, email, phone, location, category, rejected_at, rejection_reason, rejection_type, pipeline_stage, created_at"
    )
    .not("rejected_at", "is", null)
    .in("category", [...GROUND_CATEGORIES])
    .is("deleted_at", null)
    .order("rejected_at", { ascending: false });

  if (error) throw new Error(error.message);
  return (data ?? []) as any[];
}

export default async function GroundRejectedPage() {
  const jobs = await fetchGroundRejected();

  return (
    <>
      <Topbar title="Jobs" />
      <JobsNav />
      <RejectedTable initialJobs={jobs} />
    </>
  );
}
