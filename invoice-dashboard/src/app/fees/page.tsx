export const dynamic = "force-dynamic";

import { Topbar } from "@/components/Topbar";
import { AutoRefresh } from "@/components/AutoRefresh";
import FeesClient from "./FeesClient";

export default function FeesPage() {
  return (
    <>
      <Topbar title="Fee Comparison" />
      <AutoRefresh intervalSeconds={300} />
      <div className="p-6 space-y-2">
        <p className="text-sm text-gray-500">
          Pilot-reported fees by category and airport · Dec 2025 – Feb 2026
        </p>
        <FeesClient />
      </div>
    </>
  );
}
