export const dynamic = "force-dynamic";

import { Topbar } from "@/components/Topbar";
import { AutoRefresh } from "@/components/AutoRefresh";
import JobsNav from "../JobsNav";
import GroundPipelineBoard from "./GroundPipelineBoard";
import { fetchGroundPipelineJobs } from "@/lib/groundJobApi";

export default async function GroundPipelinePage() {
  const data = await fetchGroundPipelineJobs();
  const jobs = data.jobs ?? [];

  return (
    <>
      <Topbar title="Jobs — Ground Pipeline" />
      <JobsNav />
      <AutoRefresh intervalSeconds={120} />
      <GroundPipelineBoard initialJobs={jobs} />
    </>
  );
}
