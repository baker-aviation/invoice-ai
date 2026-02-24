import { Topbar } from "@/components/Topbar";
import { fetchJobs } from "@/lib/jobApi";
import JobsTable from "./JobsTable";

export default async function JobsPage() {
  const data = await fetchJobs({ limit: 200 });
  const jobs = data.jobs ?? [];

  return (
    <>
      <Topbar title="Jobs" />
      <JobsTable initialJobs={jobs} />
    </>
  );
}