export const dynamic = "force-dynamic";

import { Topbar } from "@/components/Topbar";
import { fetchJobs } from "@/lib/jobApi";
import JobsTable from "./JobsTable";
import JobsNav from "./JobsNav";
import UploadButton from "./UploadButton";
import { AutoRefresh } from "@/components/AutoRefresh";

export default async function JobsPage() {
  const data = await fetchJobs({ limit: 200 });
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