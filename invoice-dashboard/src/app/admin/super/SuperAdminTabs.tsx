"use client";

import { useState } from "react";
import SuperAdminDashboard from "./SuperAdminDashboard";
import AircraftTracker from "./AircraftTracker";
import VideoTranscribe from "./VideoTranscribe";

type Tab = "system" | "aircraft-tracker" | "video-transcribe";

const TABS: { key: Tab; label: string }[] = [
  { key: "system", label: "System" },
  { key: "aircraft-tracker", label: "Aircraft Tracker" },
  { key: "video-transcribe", label: "Video Transcribe" },
];

export default function SuperAdminTabs() {
  const [activeTab, setActiveTab] = useState<Tab>("system");

  return (
    <div>
      {/* Tab bar */}
      <div className="flex gap-1 border-b border-zinc-700 mb-6 px-6 pt-4">
        {TABS.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={`px-4 py-2 text-sm font-medium rounded-t-lg transition-colors ${
              activeTab === tab.key
                ? "bg-zinc-800 text-white border border-zinc-700 border-b-zinc-900"
                : "text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/50"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {activeTab === "system" && <SuperAdminDashboard />}
      {activeTab === "aircraft-tracker" && <AircraftTracker />}
      {activeTab === "video-transcribe" && <VideoTranscribe />}
    </div>
  );
}
