import { Topbar } from "@/components/Topbar";
import { fetchJobs } from "@/lib/jobApi";
import JobsTable from "./JobsTable";
import { AutoRefresh } from "@/components/AutoRefresh";

export default async function JobsPage() {
  const data = await fetchJobs({ limit: 200 });
  const jobs = data.jobs ?? [];

  return (
    <>
      <Topbar title="Jobs" />
      <AutoRefresh intervalSeconds={120} />
      <JobsTable initialJobs={jobs} />
    </>
  );
}