"use client";

import { useState } from "react";
import type { Flight, MxNote, SwimFlowEvent } from "@/lib/opsApi";
import type { AllRwysClosedAlert } from "@/lib/runwayData";
import type { AdvertisedPriceRow } from "@/lib/types";
import CurrentOps from "./CurrentOps";
import OpsBoard from "./OpsBoard";
import DutyTracker from "./DutyTracker";
import CrewSwap from "./CrewSwap";
import InternationalOps from "./InternationalOps";
import SwapStatus from "./SwapStatus";

const TABS = ["Current Ops", "Flight Time & Rest", "NOTAMs & PPRs", "Crew Swap", "Swap Status", "International"] as const;
type Tab = (typeof TABS)[number];

export default function OpsTabs({ flights, bakerPprAirports, advertisedPrices, mxNotes = [], swimFlow = [], suppressedRunwayNotamIds = [], allRunwaysClosedAlerts = [] }: { flights: Flight[]; bakerPprAirports: string[]; advertisedPrices: AdvertisedPriceRow[]; mxNotes?: MxNote[]; swimFlow?: SwimFlowEvent[]; suppressedRunwayNotamIds?: string[]; allRunwaysClosedAlerts?: AllRwysClosedAlert[] }) {
  const [tab, setTab] = useState<Tab>("Current Ops");
  const [scrollToTail, setScrollToTail] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);

  function switchToDuty(tail?: string) {
    setScrollToTail(tail ?? null);
    setTab("Flight Time & Rest");
  }

  async function handleResync() {
    setSyncing(true);
    setSyncMsg(null);
    try {
      const res = await fetch("/api/ops/sync-schedule", { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        setSyncMsg(data.error ?? "Sync failed");
        return;
      }
      const upserted = data.upserted ?? 0;
      const skipped = data.skipped ?? 0;
      setSyncMsg(`${upserted} upserted, ${skipped} skipped`);
      // Fire international ops checks after sync (non-blocking)
      fetch("/api/ops/intl/run-checks", { method: "POST" }).catch(() => {});
      setTimeout(() => window.location.reload(), 1500);
    } catch (err) {
      setSyncMsg(err instanceof Error ? err.message : "Network error");
    } finally {
      setSyncing(false);
    }
  }

  return (
    <div className="px-3 py-4 space-y-4">
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
        <div className="ml-auto flex items-center gap-2 pb-1">
          {syncMsg && <span className="text-xs text-gray-500">{syncMsg}</span>}
          <button
            onClick={handleResync}
            disabled={syncing}
            className="px-2.5 py-1 text-xs font-medium text-gray-500 bg-gray-100 hover:bg-gray-200 rounded transition-colors disabled:opacity-50"
          >
            {syncing ? "Syncing…" : "Resync JI"}
          </button>
        </div>
      </div>

      {/* Tab content */}
      {tab === "Current Ops" ? (
        <CurrentOps flights={flights} onSwitchToDuty={switchToDuty} advertisedPrices={advertisedPrices} mxNotes={mxNotes} swimFlow={swimFlow} />
      ) : tab === "Flight Time & Rest" ? (
        <DutyTracker flights={flights} scrollToTail={scrollToTail} onScrollComplete={() => setScrollToTail(null)} />
      ) : tab === "NOTAMs & PPRs" ? (
        <OpsBoard initialFlights={flights} bakerPprAirports={bakerPprAirports} suppressedRunwayNotamIds={suppressedRunwayNotamIds} allRunwaysClosedAlerts={allRunwaysClosedAlerts} />
      ) : tab === "Crew Swap" ? (
        <CrewSwap flights={flights} />
      ) : tab === "Swap Status" ? (
        <SwapStatus />
      ) : (
        <InternationalOps flights={flights} />
      )}
    </div>
  );
}
