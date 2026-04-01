"use client";

import { useState } from "react";
import Link from "next/link";

interface AircraftRow {
  tail_number: string;
  aircraft_type: string | null;
  overall_status: string | null;
  kow_callsign: string | null;
  notes: string | null;
  ics_enabled: boolean;
  last_sync_ok: boolean | null;
  doc_count: number;
}

export default function AircraftListClient({
  aircraft,
}: {
  aircraft: AircraftRow[];
}) {
  const [search, setSearch] = useState("");

  const filtered = aircraft.filter(
    (a) =>
      a.tail_number.toLowerCase().includes(search.toLowerCase()) ||
      a.aircraft_type?.toLowerCase().includes(search.toLowerCase()) ||
      a.kow_callsign?.toLowerCase().includes(search.toLowerCase()),
  );

  const statusColor = (s: string | null) => {
    if (!s) return "bg-gray-100 text-gray-600";
    const lower = s.toLowerCase();
    if (lower.includes("configured") || lower.includes("validated"))
      return "bg-green-100 text-green-700";
    if (lower.includes("not started"))
      return "bg-yellow-100 text-yellow-700";
    return "bg-blue-100 text-blue-700";
  };

  return (
    <div className="mt-4">
      <div className="mb-4 flex items-center justify-between">
        <p className="text-sm text-gray-500">{filtered.length} aircraft</p>
        <input
          type="text"
          placeholder="Search tail, type, or callsign..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="rounded-md border border-gray-300 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
        />
      </div>

      <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-200 text-left text-xs text-gray-500">
              <th className="px-4 py-3 font-medium">Tail</th>
              <th className="px-4 py-3 font-medium">Type</th>
              <th className="px-4 py-3 font-medium">Callsign</th>
              <th className="px-4 py-3 font-medium">Status</th>
              <th className="px-4 py-3 font-medium">ICS Feed</th>
              <th className="px-4 py-3 font-medium">JI Docs</th>
              <th className="px-4 py-3 font-medium">Notes</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((a) => (
              <tr
                key={a.tail_number}
                className="border-b border-gray-50 hover:bg-gray-50"
              >
                <td className="px-4 py-2.5">
                  <Link
                    href={`/aircraft/${a.tail_number}`}
                    className="font-medium text-blue-600 hover:text-blue-800"
                  >
                    {a.tail_number}
                  </Link>
                </td>
                <td className="px-4 py-2.5 text-gray-700">
                  {a.aircraft_type ?? "-"}
                </td>
                <td className="px-4 py-2.5 text-gray-700">
                  {a.kow_callsign ?? "-"}
                </td>
                <td className="px-4 py-2.5">
                  {a.overall_status ? (
                    <span
                      className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${statusColor(a.overall_status)}`}
                    >
                      {a.overall_status}
                    </span>
                  ) : (
                    <span className="text-gray-400">-</span>
                  )}
                </td>
                <td className="px-4 py-2.5">
                  {a.ics_enabled ? (
                    <span
                      className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${
                        a.last_sync_ok === false
                          ? "bg-red-100 text-red-700"
                          : "bg-green-100 text-green-700"
                      }`}
                    >
                      {a.last_sync_ok === false ? "Error" : "Active"}
                    </span>
                  ) : (
                    <span className="text-gray-400">-</span>
                  )}
                </td>
                <td className="px-4 py-2.5 text-gray-700">
                  {a.doc_count > 0 ? a.doc_count : "-"}
                </td>
                <td className="px-4 py-2.5 text-gray-500 max-w-[200px] truncate">
                  {a.notes ?? "-"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
