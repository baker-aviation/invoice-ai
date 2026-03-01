export const dynamic = "force-dynamic";

import { Topbar } from "@/components/Topbar";
import { fetchJobs } from "@/lib/jobApi";
import { AutoRefresh } from "@/components/AutoRefresh";
import JobsNav from "../JobsNav";
import PipelineBoard from "./PipelineBoard";

export default async function PipelinePage() {
  const data = await fetchJobs({ limit: 500 });
  const jobs = data.jobs ?? [];

  return (
    <>
      <Topbar title="Jobs" />
      <JobsNav />
      <AutoRefresh intervalSeconds={120} />
      <PipelineBoard initialJobs={jobs} />
    </>
  );
}
