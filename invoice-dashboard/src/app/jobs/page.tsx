export const revalidate = 60;

import { Topbar } from "@/components/Topbar";
import { fetchJobs } from "@/lib/jobApi";
import JobsTable from "./JobsTable";
import JobsNav from "./JobsNav";
import UploadButton from "./UploadButton";
import { AutoRefresh } from "@/components/AutoRefresh";

export default async function JobsPage() {
  const data = await fetchJobs({ limit: 1000, excludeGround: true });
  const jobs = data.jobs ?? [];

  return (
    <>
      <Topbar title="Jobs" />
      <div className="flex items-center justify-between pr-6">
        <JobsNav />
        <UploadButton />
      </div>
      <AutoRefresh intervalSeconds={120} />
      <JobsTable initialJobs={jobs} />
    </>
  );
}