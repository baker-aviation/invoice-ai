"use client";

import { useState, useEffect, useCallback } from "react";
import dynamic from "next/dynamic";
import type { Flight, MxNote, SwimFlowEvent } from "@/lib/opsApi";
import type { AdvertisedPriceRow } from "@/lib/types";
import CurrentOps from "./CurrentOps";

function TabSkeleton() {
  return <div className="flex items-center justify-center py-12 text-sm text-gray-400">Loading...</div>;
}

const OpsBoard = dynamic(() => import("./OpsBoard"), { loading: () => <TabSkeleton /> });
const DutyTracker = dynamic(() => import("./DutyTracker"), { loading: () => <TabSkeleton /> });
const CrewSwap = dynamic(() => import("./CrewSwap"), { loading: () => <TabSkeleton /> });
const InternationalOps = dynamic(() => import("./InternationalOps"), { loading: () => <TabSkeleton /> });
const SwapStatus = dynamic(() => import("./SwapStatus"), { loading: () => <TabSkeleton /> });

const TABS = ["Current Ops", "Flight Time & Rest", "NOTAMs & PPRs", "Crew Swap", "Swap Status", "International"] as const;
type Tab = (typeof TABS)[number];

const TAB_SLUGS: Record<Tab, string> = {
  "Current Ops": "",
  "Flight Time & Rest": "duty",
  "NOTAMs & PPRs": "notams",
  "Crew Swap": "crewswap",
  "Swap Status": "swapstatus",
  "International": "international",
};
const SLUG_TO_TAB: Record<string, Tab> = Object.fromEntries(
  Object.entries(TAB_SLUGS).map(([tab, slug]) => [slug, tab as Tab])
) as Record<string, Tab>;

type FboHoursEntry = { is24hr: boolean; openMinutes: number | null; closeMinutes: number | null; hours: string };

// Map tabs to ticket system sections
const TAB_TICKET_SECTIONS: Partial<Record<Tab, string>> = {
  "Current Ops": "current-ops",
  "Flight Time & Rest": "duty",
  "NOTAMs & PPRs": "notams",
  "Crew Swap": "crew-swap",
  "International": "international",
};

export default function OpsTabs({ flights, bakerPprAirports, advertisedPrices, mxNotes = [], swimFlow = [], initialTab, fboHoursMap = {} }: { flights: Flight[]; bakerPprAirports: string[]; advertisedPrices: AdvertisedPriceRow[]; mxNotes?: MxNote[]; swimFlow?: SwimFlowEvent[]; initialTab?: string | null; fboHoursMap?: Record<string, FboHoursEntry> }) {
  const [tab, setTab] = useState<Tab>(
    (initialTab ? SLUG_TO_TAB[initialTab] : null) ?? "Current Ops"
  );
  const [scrollToTail, setScrollToTail] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);
  const [ticketCounts, setTicketCounts] = useState<Record<string, number>>({});
  const [showQuickTicket, setShowQuickTicket] = useState(false);
  const [qtTitle, setQtTitle] = useState("");
  const [qtBody, setQtBody] = useState("");
  const [qtSaving, setQtSaving] = useState(false);

  // Fetch open ticket counts per section (Ticket 12)
  const loadTicketCounts = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/tickets?status=open");
      const data = await res.json();
      const counts: Record<string, number> = {};
      for (const t of data.tickets ?? []) {
        const s = t.section ?? "general";
        counts[s] = (counts[s] ?? 0) + 1;
      }
      // Also count in_progress
      const res2 = await fetch("/api/admin/tickets?status=in_progress");
      const data2 = await res2.json();
      for (const t of data2.tickets ?? []) {
        const s = t.section ?? "general";
        counts[s] = (counts[s] ?? 0) + 1;
      }
      setTicketCounts(counts);
    } catch { /* ignore — tickets are optional */ }
  }, []);

  useEffect(() => { loadTicketCounts(); }, [loadTicketCounts]);

  // Quick ticket creation (Ticket 13)
  async function createQuickTicket() {
    if (!qtTitle.trim()) return;
    setQtSaving(true);
    const section = TAB_TICKET_SECTIONS[tab] ?? "general";
    try {
      await fetch("/api/admin/tickets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: qtTitle.trim(),
          body: qtBody.trim() || null,
          section,
          priority: 50,
          labels: [section],
        }),
      });
      setQtTitle("");
      setQtBody("");
      setShowQuickTicket(false);
      loadTicketCounts();
    } catch { /* ignore */ }
    setQtSaving(false);
  }

  function switchToDuty(tail?: string) {
    setScrollToTail(tail ?? null);
    setTab("Flight Time & Rest");
    window.history.replaceState(null, "", "/ops/duty");
  }

  async function handleResync() {
    setSyncing(true);
    setSyncMsg(null);
    try {
      // Use JetInsight JSON scraper (has PIC/SIC, trip IDs, pax count)
      const res = await fetch("/api/cron/jetinsight-schedule", { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        setSyncMsg(data.error ?? "Sync failed");
        return;
      }
      const created = data.flightsCreated ?? 0;
      const updated = data.flightsUpdated ?? 0;
      const cancelled = data.flightsCancelled ?? 0;
      setSyncMsg(`${created} new, ${updated} updated, ${cancelled} cancelled`);
      // Fire international trip detection + ops checks after sync
      // These are client-side fetches — they carry the user's auth cookie
      await fetch("/api/ops/intl/trips?auto_detect=true");
      fetch("/api/ops/intl/run-checks", { method: "POST" }).catch(() => {});
      setTimeout(() => window.location.reload(), 2000);
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
        {TABS.map((t) => {
          const section = TAB_TICKET_SECTIONS[t];
          const count = section ? (ticketCounts[section] ?? 0) : 0;
          return (
            <button
              key={t}
              onClick={() => {
                setTab(t);
                const slug = TAB_SLUGS[t];
                window.history.replaceState(null, "", slug ? `/ops/${slug}` : "/ops");
              }}
              className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors relative ${
                tab === t
                  ? "border-blue-600 text-blue-600"
                  : "border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300"
              }`}
            >
              {t}
              {count > 0 && (
                <span className="ml-1.5 inline-flex items-center justify-center min-w-[16px] h-4 px-1 text-[10px] font-bold bg-red-500 text-white rounded-full">
                  {count}
                </span>
              )}
            </button>
          );
        })}
        <div className="ml-auto flex items-center gap-2 pb-1">
          {syncMsg && <span className="text-xs text-gray-500">{syncMsg}</span>}
          <button
            onClick={() => setShowQuickTicket(!showQuickTicket)}
            className="px-2.5 py-1 text-xs font-medium text-gray-500 bg-gray-100 hover:bg-gray-200 rounded transition-colors"
            title="Report an issue for this section"
          >
            + Ticket
          </button>
          <button
            onClick={handleResync}
            disabled={syncing}
            className="px-2.5 py-1 text-xs font-medium text-gray-500 bg-gray-100 hover:bg-gray-200 rounded transition-colors disabled:opacity-50"
          >
            {syncing ? "Syncing…" : "Resync JI"}
          </button>
        </div>
      </div>

      {/* Quick Ticket Modal (Ticket 13) */}
      {showQuickTicket && (
        <div className="border border-blue-200 bg-blue-50 rounded-lg p-3 space-y-2">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-semibold text-blue-800">
              New Ticket — {TAB_TICKET_SECTIONS[tab] ?? "general"}
            </h3>
            <button onClick={() => setShowQuickTicket(false)} className="text-xs text-gray-400 hover:text-gray-600">Cancel</button>
          </div>
          <input
            value={qtTitle}
            onChange={(e) => setQtTitle(e.target.value)}
            placeholder="Issue title..."
            className="w-full text-sm border border-gray-300 rounded px-2 py-1.5 outline-none focus:border-blue-500"
            onKeyDown={(e) => e.key === "Enter" && createQuickTicket()}
          />
          <textarea
            value={qtBody}
            onChange={(e) => setQtBody(e.target.value)}
            placeholder="Description (optional)"
            rows={2}
            className="w-full text-sm border border-gray-300 rounded px-2 py-1.5 outline-none focus:border-blue-500 resize-y"
          />
          <button
            onClick={createQuickTicket}
            disabled={!qtTitle.trim() || qtSaving}
            className="px-3 py-1.5 text-xs font-medium bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
          >
            {qtSaving ? "Creating..." : "Create Ticket"}
          </button>
        </div>
      )}

      {/* Tab content */}
      {tab === "Current Ops" ? (
        <CurrentOps flights={flights} onSwitchToDuty={switchToDuty} advertisedPrices={advertisedPrices} mxNotes={mxNotes} swimFlow={swimFlow} />
      ) : tab === "Flight Time & Rest" ? (
        <DutyTracker flights={flights} scrollToTail={scrollToTail} onScrollComplete={() => setScrollToTail(null)} />
      ) : tab === "NOTAMs & PPRs" ? (
        <OpsBoard bakerPprAirports={bakerPprAirports} fboHoursMap={fboHoursMap} />
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
