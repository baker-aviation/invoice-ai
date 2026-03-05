"use client";

import { useState } from "react";
import type { Flight } from "@/lib/opsApi";
import CurrentOps from "./CurrentOps";
import OpsBoard from "./OpsBoard";

const TABS = ["Current Ops", "NOTAMs & PPRs"] as const;
type Tab = (typeof TABS)[number];

export default function OpsTabs({ flights }: { flights: Flight[] }) {
  const [tab, setTab] = useState<Tab>("Current Ops");

  return (
    <div className="px-6 py-4 space-y-4">
      {/* Tab bar */}
      <div className="flex gap-1 border-b border-gray-200">
        {TABS.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              tab === t
                ? "border-blue-600 text-blue-600"
                : "border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300"
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {tab === "Current Ops" ? (
        <CurrentOps flights={flights} />
      ) : (
        <OpsBoard initialFlights={flights} />
      )}
    </div>
  );
}
