export const dynamic = "force-dynamic";

import { Topbar } from "@/components/Topbar";
import { fetchJobs } from "@/lib/jobApi";
import PipelineBoard from "./PipelineBoard";

export default async function PipelinePage() {
  const data = await fetchJobs({ limit: 500 });
  const jobs = data.jobs ?? [];

  return (
    <>
      <Topbar title="Hiring Pipeline" />
      <PipelineBoard initialJobs={jobs} />
    </>
  );
}
