"use client";

import { useState } from "react";
import { Topbar } from "@/components/Topbar";
import ForeFlightClient from "./ForeFlightClient";
import TankeringDashboard from "./TankeringDashboard";
import DispatchFlights from "./DispatchFlights";
import CreateFlight from "./CreateFlight";
import WebhookEvents from "./WebhookEvents";
import UnifiedFuelEfficiency from "./UnifiedFuelEfficiency";
import FuelChoiceReview from "./FuelChoiceReview";

const TABS = [
  { id: "fbo", label: "FBO Fuel Check" },
  { id: "tankering", label: "Tankering Plans" },
  { id: "review", label: "Fuel Choices" },
  { id: "efficiency", label: "Fuel Efficiency" },
  { id: "dispatch", label: "Dispatch" },
  { id: "create", label: "Push Flight" },
  { id: "webhooks", label: "Webhooks" },
] as const;

type TabId = (typeof TABS)[number]["id"];

export default function FuelPlanningPage() {
  const [tab, setTab] = useState<TabId>("tankering");

  return (
    <>
      <Topbar title="Fuel Planning" />

      {/* Tab bar */}
      <div className="border-b border-gray-200 px-6 -mt-2 mb-2 overflow-x-auto">
        <nav className="flex gap-4 whitespace-nowrap min-w-0">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`shrink-0 pb-3 pt-1 text-sm font-medium border-b-2 transition-colors ${
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
      {tab === "review" && <FuelChoiceReview />}
      {tab === "efficiency" && <UnifiedFuelEfficiency />}
      {tab === "dispatch" && <DispatchFlights />}
      {tab === "create" && <CreateFlight />}
      {tab === "webhooks" && <WebhookEvents />}
    </>
  );
}
