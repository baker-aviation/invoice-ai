"use client";

import { useState } from "react";
import { Topbar } from "@/components/Topbar";
import ForeFlightClient from "./ForeFlightClient";
import TankeringDashboard from "./TankeringDashboard";
import DispatchFlights from "./DispatchFlights";
import CreateFlight from "./CreateFlight";

const TABS = [
  { id: "fbo", label: "FBO Fuel Check" },
  { id: "tankering", label: "Tankering Plans" },
  { id: "dispatch", label: "Dispatch" },
  { id: "create", label: "Push Flight" },
] as const;

type TabId = (typeof TABS)[number]["id"];

export default function FuelPlanningPage() {
  const [tab, setTab] = useState<TabId>("tankering");

  return (
    <>
      <Topbar title="Fuel Planning" />

      {/* Tab bar */}
      <div className="border-b border-gray-200 px-6 -mt-2 mb-2">
        <nav className="flex gap-6">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`pb-3 pt-1 text-sm font-medium border-b-2 transition-colors ${
                tab === t.id
                  ? "border-blue-600 text-blue-600"
                  : "border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300"
              }`}
            >
              {t.label}
            </button>
          ))}
        </nav>
      </div>

      {tab === "fbo" && <ForeFlightClient />}
      {tab === "tankering" && <TankeringDashboard />}
      {tab === "dispatch" && <DispatchFlights />}
      {tab === "create" && <CreateFlight />}
    </>
  );
}
