"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import type { PilotProfile, OnboardingItem } from "@/lib/types";
import type { JetInsightDocument } from "@/lib/jetinsight/types";

type Tab = "profile" | "onboarding" | "compliance" | "stats";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function InfoRow({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div className="flex justify-between py-2 border-b border-gray-100 last:border-0">
      <span className="text-sm text-gray-500">{label}</span>
      <span className="text-sm font-medium text-gray-900">{value || "—"}</span>
    </div>
  );
}

function Badge({ label, color }: { label: string; color: string }) {
  const map: Record<string, string> = {
    green: "bg-green-100 text-green-800",
    yellow: "bg-yellow-100 text-yellow-800",
    blue: "bg-blue-100 text-blue-800",
    gray: "bg-gray-100 text-gray-600",
  };
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${map[color] ?? map.gray}`}>
      {label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Checklist Item
// ---------------------------------------------------------------------------

function ChecklistItem({
  item,
  pilotId,
  onToggled,
}: {
  item: OnboardingItem;
  pilotId: number;
  onToggled: (updated: OnboardingItem, allComplete: boolean) => void;
}) {
  const [saving, setSaving] = useState(false);

  async function toggle() {
    setSaving(true);
    const res = await fetch(`/api/pilots/${pilotId}/onboarding/${item.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ completed: !item.completed }),
    });
    const data = await res.json();
    setSaving(false);
    if (data.ok) {
      onToggled(data.item, data.onboarding_complete);
    }
  }

  return (
    <div className="flex items-center gap-3 py-2 border-b border-gray-100 last:border-0">
      <button
        onClick={toggle}
        disabled={saving}
        className={`w-5 h-5 rounded border-2 flex items-center justify-center transition-colors flex-shrink-0 ${
          item.completed
            ? "bg-green-500 border-green-500 text-white"
            : "border-gray-300 hover:border-blue-400"
        } ${saving ? "opacity-50" : ""}`}
      >
        {item.completed && (
          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
          </svg>
        )}
      </button>
      <div className="flex-1 min-w-0">
        <span className={`text-sm ${item.completed ? "text-gray-400 line-through" : "text-gray-900"}`}>
          {item.item_label}
        </span>
        {item.required_for === "pic_only" && (
          <span className="ml-2 text-xs text-blue-500">(PIC only)</span>
        )}
      </div>
      {item.completed && item.completed_at && (
        <span className="text-xs text-gray-400 flex-shrink-0">
          {new Date(item.completed_at).toLocaleDateString()}
        </span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Compliance Docs Tab
// ---------------------------------------------------------------------------

function ComplianceDocsTab({ pilotId }: { pilotId: number }) {
  const [docs, setDocs] = useState<JetInsightDocument[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`/api/jetinsight/documents?entity_type=crew&entity_id=${pilotId}`)
      .then((r) => r.json())
      .then((d) => setDocs(d.documents ?? []))
      .finally(() => setLoading(false));
  }, [pilotId]);

  if (loading)
    return <p className="py-4 text-sm text-gray-500">Loading compliance documents...</p>;

  if (docs.length === 0)
    return (
      <div className="py-8 text-center text-gray-400">
        <p>No compliance documents synced yet.</p>
        <p className="mt-1 text-xs">
          Sync documents from the JetInsight tab.
        </p>
      </div>
    );

  // Group by category
  const grouped = new Map<string, JetInsightDocument[]>();
  for (const d of docs) {
    const key = d.category;
    const arr = grouped.get(key) ?? [];
    arr.push(d);
    grouped.set(key, arr);
  }

  return (
    <div className="space-y-4">
      {[...grouped.entries()].map(([category, categoryDocs]) => (
        <div key={category}>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-gray-400">
            {category}
          </h3>
          <div className="space-y-1">
            {categoryDocs.map((d) => (
              <div
                key={d.id}
                className="flex items-center justify-between rounded-md border border-gray-100 px-3 py-2"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-gray-900">
                    {d.document_name}
                  </p>
                  <div className="flex items-center gap-2 text-xs text-gray-500">
                    {d.subcategory && <span>{d.subcategory}</span>}
                    {d.aircraft_type && (
                      <span className="rounded bg-gray-100 px-1.5 py-0.5 text-xs">
                        {d.aircraft_type}
                      </span>
                    )}
                    {d.uploaded_on && (
                      <span>
                        Uploaded: {new Date(d.uploaded_on).toLocaleDateString()}
                      </span>
                    )}
                    {d.size_bytes && (
                      <span>{Math.round(d.size_bytes / 1024)} KB</span>
                    )}
                  </div>
                </div>
                {d.signed_url && (
                  <a
                    href={d.signed_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="ml-3 flex-shrink-0 rounded-md bg-blue-50 px-3 py-1 text-xs font-medium text-blue-700 hover:bg-blue-100"
                  >
                    Download
                  </a>
                )}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main Component
// ---------------------------------------------------------------------------

export default function PilotDetailClient({ pilot: initialPilot }: { pilot: PilotProfile }) {
  const [pilot, setPilot] = useState(initialPilot);
  const [activeTab, setActiveTab] = useState<Tab>("profile");
  const items = pilot.onboarding_items ?? [];
  const sicItems = items.filter((i) => i.required_for === "all");
  const picItems = items.filter((i) => i.required_for === "pic_only");

  function handleItemToggled(updated: OnboardingItem, allComplete: boolean) {
    setPilot((prev) => {
      const newItems = (prev.onboarding_items ?? []).map((i) =>
        i.id === updated.id ? updated : i,
      );
      const completed = newItems.filter((i) => i.completed).length;
      return {
        ...prev,
        onboarding_items: newItems,
        onboarding_complete: allComplete,
        available_to_fly: allComplete,
        onboarding_progress: { completed, total: newItems.length },
      };
    });
  }

  const prog = pilot.onboarding_progress ?? { completed: 0, total: 0 };
  const pct = prog.total === 0 ? 0 : Math.round((prog.completed / prog.total) * 100);

  return (
    <div className="p-4 sm:p-6 max-w-5xl">
      <Link href="/pilots" className="text-sm text-blue-600 hover:underline mb-4 inline-block">
        &larr; Back to Pilots
      </Link>

      {/* Header */}
      <div className="mb-6 flex items-center gap-3">
        <h1 className="text-xl font-bold text-gray-900">{pilot.full_name}</h1>
        <Badge label={pilot.role} color={pilot.role === "PIC" ? "blue" : "gray"} />
        {pilot.available_to_fly ? (
          <Badge label="Available" color="green" />
        ) : (
          <Badge label="Onboarding" color="yellow" />
        )}
      </div>

      {/* Tab bar */}
      <div className="mb-6 flex gap-1 rounded-lg bg-slate-100 p-1">
        {(
          [
            { key: "profile", label: "Profile" },
            { key: "onboarding", label: `Onboarding (${pct}%)` },
            { key: "compliance", label: "Compliance Docs" },
            { key: "stats", label: "Flight Stats" },
          ] as { key: Tab; label: string }[]
        ).map((t) => (
          <button
            key={t.key}
            onClick={() => setActiveTab(t.key)}
            className={`rounded-md px-4 py-2 text-sm font-medium transition-colors ${
              activeTab === t.key
                ? "bg-white text-slate-900 shadow-sm"
                : "text-slate-600 hover:text-slate-900"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Profile tab */}
      {activeTab === "profile" && (
        <div className="bg-white rounded-xl border shadow-sm p-5 max-w-lg">
          <InfoRow label="Email" value={pilot.email} />
          <InfoRow label="Phone" value={pilot.phone} />
          <InfoRow label="Employee ID" value={pilot.employee_id} />
          <InfoRow label="Hire Date" value={pilot.hire_date} />
          <InfoRow label="Home Airports" value={pilot.home_airports?.join(", ")} />
          <InfoRow label="Aircraft Types" value={pilot.aircraft_types?.join(", ")} />
          <InfoRow label="Medical Class" value={pilot.medical_class} />
          <InfoRow label="Medical Expiry" value={pilot.medical_expiry} />
          <InfoRow label="Passport Expiry" value={pilot.passport_expiry} />
        </div>
      )}

      {/* Onboarding tab */}
      {activeTab === "onboarding" && (
        <div className="bg-white rounded-xl border shadow-sm p-5 max-w-lg">
          {/* Progress bar */}
          <div className="h-2 bg-gray-200 rounded-full overflow-hidden mb-4">
            <div
              className={`h-full rounded-full transition-all ${pct === 100 ? "bg-green-500" : "bg-blue-500"}`}
              style={{ width: `${pct}%` }}
            />
          </div>

          {sicItems.length > 0 && (
            <div className="mb-4">
              <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">
                Required (All Pilots)
              </h3>
              {sicItems.map((item) => (
                <ChecklistItem
                  key={item.id}
                  item={item}
                  pilotId={pilot.id}
                  onToggled={handleItemToggled}
                />
              ))}
            </div>
          )}

          {picItems.length > 0 && (
            <div>
              <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">
                PIC Only
              </h3>
              {picItems.map((item) => (
                <ChecklistItem
                  key={item.id}
                  item={item}
                  pilotId={pilot.id}
                  onToggled={handleItemToggled}
                />
              ))}
            </div>
          )}

          {items.length === 0 && (
            <div className="text-center text-gray-400 py-4">No onboarding items.</div>
          )}
        </div>
      )}

      {/* Compliance docs tab */}
      {activeTab === "compliance" && (
        <div className="bg-white rounded-xl border shadow-sm p-5">
          <ComplianceDocsTab pilotId={pilot.id} />
        </div>
      )}

      {activeTab === "stats" && (
        <FlightStatsTab pilotId={pilot.id} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Flight Stats Tab
// ---------------------------------------------------------------------------

interface FlightStats {
  totalFlights: number;
  flightsAsPic: number;
  flightsAsSic: number;
  totalFlightHrs: number;
  picHrs: number;
  sicHrs: number;
  totalBlockHrs: number;
  totalNauticalMiles: number;
  totalPax: number;
  totalFuelBurn: number;
  aircraftTypes: string[];
  avgBurnByType: Array<{ type: string; avgBurnRate: number }>;
  dateRange: { first: string | null; last: string | null };
}

interface MonthlyData {
  month: string;
  picHrs: number;
  sicHrs: number;
  flights: number;
}

interface RecentFlight {
  date: string;
  tail: string;
  type: string;
  route: string;
  flightHrs: number;
  fuelBurn: number;
  burnRate: number;
  pax: number;
  asPic: boolean;
}

function FlightStatsTab({ pilotId }: { pilotId: number }) {
  const [stats, setStats] = useState<FlightStats | null>(null);
  const [monthly, setMonthly] = useState<MonthlyData[]>([]);
  const [recent, setRecent] = useState<RecentFlight[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`/api/pilots/${pilotId}/flight-stats`)
      .then((r) => r.json())
      .then((d) => {
        setStats(d.stats ?? null);
        setMonthly(d.monthly ?? []);
        setRecent(d.recentFlights ?? []);
      })
      .finally(() => setLoading(false));
  }, [pilotId]);

  if (loading) return <p className="py-4 text-sm text-gray-500">Loading flight stats...</p>;
  if (!stats || stats.totalFlights === 0)
    return (
      <div className="py-8 text-center text-gray-400">
        <p>No flight data available.</p>
        <p className="mt-1 text-xs">Post-flight data is imported from JetInsight CSV exports.</p>
      </div>
    );

  return (
    <div className="space-y-6">
      {/* KPI Cards */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <KpiCard label="Total Flights" value={stats.totalFlights} />
        <KpiCard label="Flight Hours" value={stats.totalFlightHrs} sub={`PIC: ${stats.picHrs} | SIC: ${stats.sicHrs}`} />
        <KpiCard label="As PIC" value={stats.flightsAsPic} />
        <KpiCard label="As SIC" value={stats.flightsAsSic} />
        <KpiCard label="Nautical Miles" value={stats.totalNauticalMiles.toLocaleString()} />
        <KpiCard label="Passengers Carried" value={stats.totalPax} />
        <KpiCard label="Total Fuel Burn" value={`${(stats.totalFuelBurn / 1000).toFixed(1)}K lbs`} />
        <KpiCard label="Aircraft Types" value={stats.aircraftTypes.join(", ") || "-"} />
      </div>

      {/* Date range */}
      {stats.dateRange.first && (
        <p className="text-xs text-gray-400">
          Data from {new Date(stats.dateRange.first).toLocaleDateString()} to{" "}
          {new Date(stats.dateRange.last!).toLocaleDateString()}
        </p>
      )}

      {/* Avg burn rate by type */}
      {stats.avgBurnByType.length > 0 && (
        <div className="rounded-xl border bg-white p-5 shadow-sm">
          <h3 className="mb-3 text-sm font-semibold uppercase tracking-wider text-gray-400">
            Avg Fuel Burn Rate
          </h3>
          <div className="flex gap-6">
            {stats.avgBurnByType.map((t) => (
              <div key={t.type}>
                <p className="text-lg font-semibold text-gray-900">
                  {t.avgBurnRate} <span className="text-sm font-normal text-gray-500">lbs/hr</span>
                </p>
                <p className="text-xs text-gray-500">{t.type}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Monthly breakdown */}
      {monthly.length > 0 && (
        <div className="rounded-xl border bg-white p-5 shadow-sm">
          <h3 className="mb-3 text-sm font-semibold uppercase tracking-wider text-gray-400">
            Monthly Breakdown
          </h3>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200 text-left text-xs text-gray-500">
                <th className="pb-2 font-medium">Month</th>
                <th className="pb-2 font-medium">Flights</th>
                <th className="pb-2 font-medium">PIC Hours</th>
                <th className="pb-2 font-medium">SIC Hours</th>
                <th className="pb-2 font-medium">Total</th>
              </tr>
            </thead>
            <tbody>
              {monthly.map((m) => (
                <tr key={m.month} className="border-b border-gray-50">
                  <td className="py-2 font-medium text-gray-900">{m.month}</td>
                  <td className="py-2 text-gray-700">{m.flights}</td>
                  <td className="py-2 text-gray-700">{m.picHrs.toFixed(1)}</td>
                  <td className="py-2 text-gray-700">{m.sicHrs.toFixed(1)}</td>
                  <td className="py-2 font-medium text-gray-900">{(m.picHrs + m.sicHrs).toFixed(1)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Recent flights */}
      {recent.length > 0 && (
        <div className="rounded-xl border bg-white p-5 shadow-sm">
          <h3 className="mb-3 text-sm font-semibold uppercase tracking-wider text-gray-400">
            Recent Flights
          </h3>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200 text-left text-xs text-gray-500">
                  <th className="pb-2 font-medium">Date</th>
                  <th className="pb-2 font-medium">Role</th>
                  <th className="pb-2 font-medium">Tail</th>
                  <th className="pb-2 font-medium">Route</th>
                  <th className="pb-2 font-medium">Hours</th>
                  <th className="pb-2 font-medium">Burn Rate</th>
                  <th className="pb-2 font-medium">Pax</th>
                </tr>
              </thead>
              <tbody>
                {recent.map((f, i) => (
                  <tr key={i} className="border-b border-gray-50">
                    <td className="py-2 text-gray-900">{new Date(f.date).toLocaleDateString()}</td>
                    <td className="py-2">
                      <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${f.asPic ? "bg-blue-100 text-blue-700" : "bg-gray-100 text-gray-600"}`}>
                        {f.asPic ? "PIC" : "SIC"}
                      </span>
                    </td>
                    <td className="py-2 text-gray-700">{f.tail}</td>
                    <td className="py-2 font-medium text-gray-900">{f.route}</td>
                    <td className="py-2 text-gray-700">{f.flightHrs?.toFixed(1) ?? "-"}</td>
                    <td className="py-2 text-gray-700">{f.burnRate ? `${Math.round(f.burnRate)} lbs/hr` : "-"}</td>
                    <td className="py-2 text-gray-500">{f.pax ?? "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function KpiCard({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-3">
      <p className="text-xs text-gray-500">{label}</p>
      <p className="mt-1 text-xl font-semibold text-gray-900">{value}</p>
      {sub && <p className="mt-0.5 text-xs text-gray-400">{sub}</p>}
    </div>
  );
}
