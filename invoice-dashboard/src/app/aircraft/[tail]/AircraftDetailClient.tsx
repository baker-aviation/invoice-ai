"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import type { JetInsightDocument } from "@/lib/jetinsight/types";

type Tab = "overview" | "documents" | "mel" | "flights";

interface TrackerRow {
  tail_number: string;
  aircraft_type: string | null;
  part_135_flying: string | null;
  wb_date: string | null;
  wb_on_jet_insight: string | null;
  foreflight_wb_built: string | null;
  foreflight_subscription: string | null;
  foreflight_config_built: string | null;
  starlink_on_wb: string | null;
  validation_complete: string | null;
  beta_tested: string | null;
  go_live_approved: string | null;
  genesis_removed: string | null;
  overall_status: string | null;
  notes: string | null;
  kow_callsign: string | null;
  jet_insight_url: string | null;
}

interface MelItem {
  id: number;
  tail_number: string;
  category: string;
  mel_reference: string | null;
  description: string;
  deferred_date: string | null;
  expiration_date: string | null;
  status: string;
}

interface Flight {
  id: string;
  tail_number: string;
  departure_icao: string;
  arrival_icao: string;
  scheduled_departure: string;
  scheduled_arrival: string;
  flight_type: string | null;
  pic: string | null;
  sic: string | null;
  pax_count: number | null;
}

interface Tag {
  id: string;
  tail_number: string;
  tag: string;
  note: string | null;
  created_at: string;
}

function InfoRow({ label, value }: { label: string; value: string | null | undefined }) {
  const yesNoColor = (v: string | null | undefined) => {
    if (!v) return "";
    const lower = v.toLowerCase();
    if (lower === "yes") return "text-green-700 font-medium";
    if (lower === "no") return "text-red-600 font-medium";
    return "";
  };

  return (
    <div className="flex justify-between py-2 border-b border-gray-100 last:border-0">
      <span className="text-sm text-gray-500">{label}</span>
      <span className={`text-sm text-gray-900 ${yesNoColor(value)}`}>
        {value || "—"}
      </span>
    </div>
  );
}

export default function AircraftDetailClient({
  tail,
  tracker,
  melItems,
  flights,
  tags,
}: {
  tail: string;
  tracker: TrackerRow | null;
  melItems: MelItem[];
  flights: Flight[];
  tags: Tag[];
}) {
  const [activeTab, setActiveTab] = useState<Tab>("overview");

  const tabs: { key: Tab; label: string }[] = [
    { key: "overview", label: "Overview" },
    { key: "documents", label: "Documents" },
    { key: "mel", label: `MEL (${melItems.length})` },
    { key: "flights", label: `Flights (${flights.length})` },
  ];

  return (
    <div className="p-4 sm:p-6 max-w-5xl">
      <Link
        href="/aircraft"
        className="text-sm text-blue-600 hover:underline mb-4 inline-block"
      >
        &larr; Back to Aircraft
      </Link>

      {/* Header */}
      <div className="mb-6 flex items-center gap-3">
        <h1 className="text-xl font-bold text-gray-900">{tail}</h1>
        {tracker?.aircraft_type && (
          <span className="rounded-full bg-blue-100 px-2.5 py-0.5 text-xs font-medium text-blue-800">
            {tracker.aircraft_type}
          </span>
        )}
        {tracker?.overall_status && (
          <span
            className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${
              tracker.overall_status.toLowerCase().includes("configured")
                ? "bg-green-100 text-green-700"
                : "bg-yellow-100 text-yellow-700"
            }`}
          >
            {tracker.overall_status}
          </span>
        )}
        {tracker?.kow_callsign && (
          <span className="text-sm text-gray-500">
            ({tracker.kow_callsign})
          </span>
        )}
      </div>

      {/* Tags */}
      {tags.length > 0 && (
        <div className="mb-4 flex flex-wrap gap-2">
          {tags.map((t) => (
            <span
              key={t.id}
              className="inline-flex items-center rounded-full bg-gray-100 px-2.5 py-0.5 text-xs font-medium text-gray-700"
              title={t.note ?? undefined}
            >
              {t.tag}
            </span>
          ))}
        </div>
      )}

      {/* Tab bar */}
      <div className="mb-6 flex gap-1 rounded-lg bg-slate-100 p-1">
        {tabs.map((t) => (
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

      {activeTab === "overview" && <OverviewTab tracker={tracker} />}
      {activeTab === "documents" && <DocumentsTab tail={tail} />}
      {activeTab === "mel" && <MelTab items={melItems} />}
      {activeTab === "flights" && <FlightsTab flights={flights} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

function OverviewTab({ tracker }: { tracker: TrackerRow | null }) {
  if (!tracker)
    return (
      <p className="text-sm text-gray-500">
        No tracker data for this aircraft.
      </p>
    );

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
      <div className="rounded-xl border bg-white p-5 shadow-sm">
        <h3 className="mb-3 text-sm font-semibold text-gray-400 uppercase tracking-wider">
          Configuration
        </h3>
        <InfoRow label="Part 135 Flying" value={tracker.part_135_flying} />
        <InfoRow label="W&B Date" value={tracker.wb_date} />
        <InfoRow label="W&B on JetInsight" value={tracker.wb_on_jet_insight} />
        <InfoRow label="ForeFlight W&B Built" value={tracker.foreflight_wb_built} />
        <InfoRow label="ForeFlight Subscription" value={tracker.foreflight_subscription} />
        <InfoRow label="ForeFlight Config Built" value={tracker.foreflight_config_built} />
        <InfoRow label="Starlink on W&B" value={tracker.starlink_on_wb} />
      </div>

      <div className="rounded-xl border bg-white p-5 shadow-sm">
        <h3 className="mb-3 text-sm font-semibold text-gray-400 uppercase tracking-wider">
          Validation
        </h3>
        <InfoRow label="Validation Complete" value={tracker.validation_complete} />
        <InfoRow label="Beta Tested" value={tracker.beta_tested} />
        <InfoRow label="Go Live Approved" value={tracker.go_live_approved} />
        <InfoRow label="Genesis Removed" value={tracker.genesis_removed} />
        {tracker.jet_insight_url && (
          <div className="mt-3">
            <a
              href={tracker.jet_insight_url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm text-blue-600 hover:underline"
            >
              Open in JetInsight
            </a>
          </div>
        )}
        {tracker.notes && (
          <div className="mt-3 rounded-md bg-gray-50 p-3">
            <p className="text-xs text-gray-400 mb-1">Notes</p>
            <p className="text-sm text-gray-700">{tracker.notes}</p>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Documents (from JetInsight sync)
// ---------------------------------------------------------------------------

function DocumentsTab({ tail }: { tail: string }) {
  const [docs, setDocs] = useState<JetInsightDocument[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(
      `/api/jetinsight/documents?entity_type=aircraft&entity_id=${encodeURIComponent(tail)}`,
    )
      .then((r) => r.json())
      .then((d) => setDocs(d.documents ?? []))
      .finally(() => setLoading(false));
  }, [tail]);

  if (loading) return <p className="text-sm text-gray-500">Loading...</p>;
  if (docs.length === 0)
    return (
      <div className="py-8 text-center text-gray-400">
        <p>No documents synced yet.</p>
        <p className="mt-1 text-xs">Sync documents from the JetInsight tab.</p>
      </div>
    );

  const grouped = new Map<string, JetInsightDocument[]>();
  for (const d of docs) {
    const arr = grouped.get(d.category) ?? [];
    arr.push(d);
    grouped.set(d.category, arr);
  }

  return (
    <div className="space-y-4">
      {[...grouped.entries()].map(([category, categoryDocs]) => (
        <div key={category} className="rounded-xl border bg-white p-5 shadow-sm">
          <h3 className="mb-3 text-sm font-semibold text-gray-400 uppercase tracking-wider">
            {category}
          </h3>
          <div className="space-y-1">
            {categoryDocs.map((d) => (
              <div
                key={d.id}
                className="flex items-center justify-between rounded-md px-3 py-2 hover:bg-gray-50"
              >
                <div>
                  <p className="text-sm font-medium text-gray-900">
                    {d.document_name}
                  </p>
                  <div className="flex gap-2 text-xs text-gray-500">
                    {d.version_label && <span>v{d.version_label}</span>}
                    {d.uploaded_on && (
                      <span>
                        Uploaded:{" "}
                        {new Date(d.uploaded_on).toLocaleDateString()}
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
                    className="rounded-md bg-blue-50 px-3 py-1 text-xs font-medium text-blue-700 hover:bg-blue-100"
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
// MEL Items
// ---------------------------------------------------------------------------

function MelTab({ items }: { items: MelItem[] }) {
  if (items.length === 0)
    return (
      <p className="py-8 text-center text-sm text-gray-400">
        No open MEL items.
      </p>
    );

  const catColor = (cat: string) => {
    switch (cat) {
      case "A": return "bg-red-100 text-red-700";
      case "B": return "bg-yellow-100 text-yellow-700";
      case "C": return "bg-blue-100 text-blue-700";
      case "D": return "bg-gray-100 text-gray-700";
      default: return "bg-gray-100 text-gray-600";
    }
  };

  return (
    <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-gray-200 text-left text-xs text-gray-500">
            <th className="px-4 py-3 font-medium">Cat</th>
            <th className="px-4 py-3 font-medium">Reference</th>
            <th className="px-4 py-3 font-medium">Description</th>
            <th className="px-4 py-3 font-medium">Deferred</th>
            <th className="px-4 py-3 font-medium">Expires</th>
          </tr>
        </thead>
        <tbody>
          {items.map((m) => (
            <tr key={m.id} className="border-b border-gray-50">
              <td className="px-4 py-2">
                <span
                  className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${catColor(m.category)}`}
                >
                  {m.category}
                </span>
              </td>
              <td className="px-4 py-2 text-gray-700">
                {m.mel_reference ?? "-"}
              </td>
              <td className="px-4 py-2 text-gray-900">{m.description}</td>
              <td className="px-4 py-2 text-gray-500">
                {m.deferred_date
                  ? new Date(m.deferred_date).toLocaleDateString()
                  : "-"}
              </td>
              <td className="px-4 py-2">
                {m.expiration_date ? (
                  <span
                    className={
                      new Date(m.expiration_date) < new Date()
                        ? "font-medium text-red-600"
                        : "text-gray-700"
                    }
                  >
                    {new Date(m.expiration_date).toLocaleDateString()}
                  </span>
                ) : (
                  <span className="text-gray-400">-</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Flights
// ---------------------------------------------------------------------------

function FlightsTab({ flights }: { flights: Flight[] }) {
  if (flights.length === 0)
    return (
      <p className="py-8 text-center text-sm text-gray-400">
        No recent flights.
      </p>
    );

  return (
    <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-gray-200 text-left text-xs text-gray-500">
            <th className="px-4 py-3 font-medium">Date</th>
            <th className="px-4 py-3 font-medium">Route</th>
            <th className="px-4 py-3 font-medium">Type</th>
            <th className="px-4 py-3 font-medium">PIC</th>
            <th className="px-4 py-3 font-medium">SIC</th>
            <th className="px-4 py-3 font-medium">Pax</th>
          </tr>
        </thead>
        <tbody>
          {flights.map((f) => (
            <tr key={f.id} className="border-b border-gray-50">
              <td className="px-4 py-2 text-gray-900">
                {new Date(f.scheduled_departure).toLocaleDateString()}
              </td>
              <td className="px-4 py-2 font-medium text-gray-900">
                {f.departure_icao} → {f.arrival_icao}
              </td>
              <td className="px-4 py-2 text-gray-700">
                {f.flight_type ?? "-"}
              </td>
              <td className="px-4 py-2 text-gray-700">{f.pic ?? "-"}</td>
              <td className="px-4 py-2 text-gray-700">{f.sic ?? "-"}</td>
              <td className="px-4 py-2 text-gray-500">
                {f.pax_count ?? "-"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
