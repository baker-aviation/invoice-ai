import { Topbar } from "@/components/Topbar";

export default function JobApplicationsPage() {
  return (
    <>
      <Topbar title="Job Applications" />
      <div className="p-6">
        <div className="rounded-xl border bg-white p-6 shadow-sm">
          <div className="text-lg font-semibold">Coming soon</div>
          <div className="text-sm text-gray-600 mt-1">
            This page is notional for now — button is wired.
          </div>
        </div>
      </div>
    </>
  );
}