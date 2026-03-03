"use client";

import { useState, useEffect } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";

type Notam = {
  id: string;
  alert_type: string;
  severity: string;
  airport_icao: string | null;
  subject: string | null;
  body: string | null;
  created_at: string;
  acknowledged_at: string | null;
};

const TYPE_LABELS: Record<string, string> = {
  NOTAM_RUNWAY: "RWY",
  NOTAM_AERODROME: "AD",
  NOTAM_AD_RESTRICTED: "AD",
  NOTAM_PPR: "PPR",
  NOTAM_TFR: "TFR",
  NOTAM_OTHER: "Other",
};

const TYPE_COLORS: Record<string, string> = {
  NOTAM_RUNWAY: "bg-red-100 text-red-800 border-red-200",
  NOTAM_AERODROME: "bg-amber-100 text-amber-800 border-amber-200",
  NOTAM_AD_RESTRICTED: "bg-amber-100 text-amber-800 border-amber-200",
  NOTAM_PPR: "bg-blue-100 text-blue-800 border-blue-200",
  NOTAM_TFR: "bg-purple-100 text-purple-800 border-purple-200",
  NOTAM_OTHER: "bg-gray-100 text-gray-700 border-gray-200",
};

const PRIORITY_TYPES = new Set([
  "NOTAM_RUNWAY", "NOTAM_AERODROME", "NOTAM_AD_RESTRICTED", "NOTAM_PPR", "NOTAM_TFR",
]);

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString("en-US", {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
    hour12: false, timeZone: "UTC",
  }) + "Z";
}

export default function AirportNotamsPage() {
  const params = useParams();
  const icao = (params.icao as string)?.toUpperCase() ?? "";

  const [notams, setNotams] = useState<Notam[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    if (!icao) return;
    fetch(`/api/ops/airport/${icao}/notams`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        setNotams(data.notams ?? []);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [icao]);

  const priorityNotams = notams.filter((n) => PRIORITY_TYPES.has(n.alert_type));
  const otherNotams = notams.filter((n) => !PRIORITY_TYPES.has(n.alert_type));
  const activeNotams = notams.filter((n) => !n.acknowledged_at);

  return (
    <div className="p-4 sm:p-6 max-w-4xl mx-auto bg-gray-50 min-h-screen">
      {/* Header */}
      <div className="flex items-center gap-3 mb-6">
        <Link
          href="/ops"
          className="text-sm text-gray-500 hover:text-gray-800 transition-colors"
        >
          &larr; Ops
        </Link>
        <div className="w-px h-5 bg-gray-300" />
        <h1 className="text-xl font-bold text-slate-900 font-mono">{icao}</h1>
        <span className="text-sm text-gray-500">NOTAMs</span>
        <span className="text-xs bg-slate-100 text-slate-600 rounded-full px-2 py-0.5">
          {activeNotams.length} active
        </span>
      </div>

      {loading && (
        <div className="text-sm text-gray-400 py-12 text-center">Loading NOTAMs…</div>
      )}

      {error && (
        <div className="mb-4 px-4 py-2 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
          {error}
        </div>
      )}

      {!loading && notams.length === 0 && (
        <div className="text-sm text-gray-400 py-12 text-center border border-dashed border-gray-300 rounded-lg">
          No NOTAMs found for {icao} in the last 30 days.
        </div>
      )}

      {!loading && notams.length > 0 && (
        <div className="space-y-6">
          {/* Priority NOTAMs: RWY, AD, PPR, TFR */}
          {priorityNotams.length > 0 && (
            <div>
              <h2 className="text-sm font-semibold text-slate-700 mb-2">
                RWY / AD / PPR / TFR
              </h2>
              <div className="space-y-2">
                {priorityNotams.map((n) => (
                  <NotamCard key={n.id} notam={n} />
                ))}
              </div>
            </div>
          )}

          {/* Other NOTAMs */}
          {otherNotams.length > 0 && (
            <div>
              <div className="flex items-center gap-2 mb-2">
                <h2 className="text-sm font-semibold text-slate-700">
                  Other NOTAMs
                </h2>
                <span className="text-xs text-gray-400">{otherNotams.length}</span>
                {otherNotams.length > 5 && (
                  <button
                    type="button"
                    onClick={() => setShowAll((v) => !v)}
                    className="text-xs text-blue-600 hover:text-blue-800"
                  >
                    {showAll ? "Show less" : "Show all"}
                  </button>
                )}
              </div>
              <div className="space-y-2">
                {(showAll ? otherNotams : otherNotams.slice(0, 5)).map((n) => (
                  <NotamCard key={n.id} notam={n} />
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function NotamCard({ notam }: { notam: Notam }) {
  const [expanded, setExpanded] = useState(false);
  const typeLabel = TYPE_LABELS[notam.alert_type] ?? notam.alert_type;
  const typeColor = TYPE_COLORS[notam.alert_type] ?? TYPE_COLORS.NOTAM_OTHER;
  const isDismissed = !!notam.acknowledged_at;

  return (
    <div
      className={`rounded-lg border bg-white shadow-sm overflow-hidden ${
        isDismissed ? "opacity-50" : ""
      }`}
    >
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full px-4 py-2.5 flex items-center gap-2.5 text-left hover:bg-gray-50 transition-colors"
      >
        <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-xs font-mono font-semibold border ${typeColor}`}>
          {typeLabel}
        </span>
        {notam.subject && (
          <span className="text-sm text-gray-800 font-mono truncate">{notam.subject}</span>
        )}
        <span className="ml-auto text-xs text-gray-400 shrink-0">{fmtDate(notam.created_at)}</span>
        {isDismissed && (
          <span className="text-xs text-gray-400 bg-gray-100 rounded px-1.5 py-0.5">Dismissed</span>
        )}
        <span className="text-gray-400 text-xs shrink-0">{expanded ? "▲" : "▼"}</span>
      </button>
      {expanded && notam.body && (
        <div className="px-4 pb-3 pt-1 border-t border-gray-100">
          <pre className="whitespace-pre-wrap font-sans text-xs text-gray-700 bg-gray-50 border rounded p-3 max-h-48 overflow-y-auto">
            {notam.body}
          </pre>
        </div>
      )}
    </div>
  );
}
