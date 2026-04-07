export const revalidate = 60;

import { Topbar } from "@/components/Topbar";
import { fetchGroundTableJobs } from "@/lib/groundJobApi";
import GroundTable from "./GroundTable";
import JobsNav from "../JobsNav";
import { AutoRefresh } from "@/components/AutoRefresh";

export default async function GroundTablePage() {
  const data = await fetchGroundTableJobs();
  const jobs = data.jobs ?? [];

  return (
    <>
      <Topbar title="Jobs" />
      <div className="flex items-center justify-between pr-6">
        <JobsNav />
      </div>
      <AutoRefresh intervalSeconds={120} />
      <GroundTable initialJobs={jobs} />
    </>
  );
}
