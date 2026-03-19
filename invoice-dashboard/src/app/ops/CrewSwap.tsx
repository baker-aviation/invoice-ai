"use client";

import { useEffect, useMemo, useState, useCallback, useRef } from "react";
import { toPng } from "html-to-image";
import * as XLSX from "xlsx";
import type { Flight } from "@/lib/opsApi";

// ─── Types ──────────────────────────────────────────────────────────────────

type CrewMember = {
  id: string;
  name: string;
  role: "PIC" | "SIC";
  home_airports: string[];
  aircraft_types: string[];
  is_checkairman: boolean;
  is_skillbridge: boolean;
  priority: number;
  active: boolean;
  notes: string | null;
};

type SwapAssignment = {
  oncoming_pic: string | null;
  oncoming_sic: string | null;
  offgoing_pic: string | null;
  offgoing_sic: string | null;
};

type OncomingPoolEntry = {
  name: string;
  aircraft_type: string;
  home_airports: string[];
  is_checkairman: boolean;
  is_skillbridge: boolean;
  early_volunteer: boolean;
  late_volunteer: boolean;
  standby_volunteer: boolean;
  notes: string | null;
};

type OncomingPool = {
  pic: OncomingPoolEntry[];
  sic: OncomingPoolEntry[];
};

type RosterUploadResult = {
  ok: boolean;
  total_parsed: number;
  unique_crew: number;
  upserted: number;
  errors?: string[];
  summary: Record<string, number>;
  swap_assignments?: Record<string, SwapAssignment>;
  oncoming_pool?: OncomingPool;
};

type RouteStatus = {
  swap_date: string;
  total_routes: number;
  crew_count: number;
  destination_count: number;
  last_computed: string | null;
  is_stale: boolean;
};

type VolunteerResponse = {
  id: string;
  swap_date: string;
  slack_user_id: string;
  crew_member_id: string | null;
  raw_text: string;
  parsed_preference: "early" | "late" | "standby" | "early_and_late" | "unknown";
  notes: string | null;
  crew_members?: { id: string; name: string; role: string; home_airports: string[] } | null;
};

type SwapPointData = {
  tail: string;
  swap_points: { icao: string; time: string; position: string; isAdjacentLive: boolean }[];
  overnight_airport: string | null;
  aircraft_type: string;
  wednesday_legs: { dep: string; arr: string; type: string | null; dep_time: string; arr_time: string | null }[];
  recent_crew: { pic: string[]; sic: string[] } | null;
};

type SwapAlert = {
  id: string;
  tail_number: string;
  change_type: string;
  old_value: Record<string, unknown> | null;
  new_value: Record<string, unknown> | null;
  swap_date: string;
  detected_at: string;
  acknowledged: boolean;
};

type SavedPlan = {
  id: string;
  swap_date: string;
  version: number;
  status: string;
  plan_data: SwapPlanResult;
  swap_assignments: Record<string, SwapAssignment> | null;
  oncoming_pool: OncomingPool | null;
  strategy: string | null;
  total_cost: number | null;
  solved_count: number | null;
  unsolved_count: number | null;
  created_by: string | null;
  created_at: string;
  notes: string | null;
};

type PlanImpact = {
  id: string;
  alert_id: string;
  tail_number: string;
  affected_crew: { name: string; role: string; direction: string; detail: string }[];
  severity: "critical" | "warning" | "info";
  resolved: boolean;
};

type PlanVersion = {
  id: string;
  swap_date: string;
  version: number;
  status: string;
  total_cost: number | null;
  solved_count: number | null;
  unsolved_count: number | null;
  strategy: string | null;
  created_by: string | null;
  created_at: string;
  notes: string | null;
};

// Matches CrewSwapRow from swapOptimizer.ts
type CrewSwapRow = {
  name: string;
  home_airports: string[];
  role: "PIC" | "SIC";
  direction: "oncoming" | "offgoing";
  aircraft_type: string;
  tail_number: string;
  swap_location: string | null;
  all_swap_points?: string[];
  travel_type: "commercial" | "uber" | "rental_car" | "drive" | "none";
  flight_number: string | null;
  departure_time: string | null;
  arrival_time: string | null;
  travel_from: string | null;
  travel_to: string | null;
  cost_estimate: number | null;
  duration_minutes: number | null;
  available_time: string | null;
  duty_on_time: string | null;
  duty_off_time: string | null;
  is_checkairman: boolean;
  is_skillbridge: boolean;
  volunteer_status: string | null;
  notes: string | null;
  warnings: string[];
  alt_flights: { flight_number: string; dep: string; arr: string; price: string }[];
  backup_flight: string | null;
  score: number;
};

type TwoPassStats = {
  pass1_solved: number;
  pass1_unsolved: number;
  pass1_cost: number;
  pass2_solved: number;
  pass2_volunteers_used: { name: string; role: "PIC" | "SIC"; tail: string; type: "early" | "late" }[];
  pass2_bonus_cost: number;
  total_cost: number;
};

type SwapPlanResult = {
  ok: boolean;
  swap_date: string;
  rows: CrewSwapRow[];
  warnings: string[];
  routes_used: number;
  rotation_source?: string;
  total_cost: number;
  plan_score: number;
  solved_count?: number;
  unsolved_count?: number;
  two_pass?: TwoPassStats;
  crew_assignment?: {
    standby: { pic: string[]; sic: string[] };
    details: { name: string; tail: string; cost: number; reason: string }[];
  };
};

// ─── Toast System ───────────────────────────────────────────────────────────

type Toast = { id: number; type: "success" | "error" | "warning"; msg: string };
let _toastId = 0;

function ToastContainer({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: number) => void }) {
  if (toasts.length === 0) return null;
  const colors = {
    success: "bg-green-600 text-white",
    error: "bg-red-600 text-white",
    warning: "bg-amber-500 text-white",
  };
  return (
    <div className="fixed bottom-4 right-4 z-50 space-y-2">
      {toasts.map((t) => (
        <div key={t.id} className={`rounded-lg px-4 py-3 shadow-lg text-sm font-medium flex items-center gap-3 ${colors[t.type]}`}>
          <span>{t.msg}</span>
          <button onClick={() => onDismiss(t.id)} className="opacity-70 hover:opacity-100 text-lg leading-none">&times;</button>
        </div>
      ))}
    </div>
  );
}

// ─── Workflow Stepper ───────────────────────────────────────────────────────

function WorkflowStepper({ steps }: { steps: { label: string; done: boolean }[] }) {
  const currentStep = steps.findIndex((s) => !s.done);
  return (
    <div className="flex items-center gap-1 px-2">
      {steps.map((s, i) => (
        <div key={i} className="flex items-center gap-1">
          {i > 0 && <div className={`w-8 h-0.5 ${i <= currentStep && steps[i - 1].done ? "bg-green-400" : "bg-gray-200"}`} />}
          <div className="flex flex-col items-center gap-0.5">
            <div className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold ${
              s.done ? "bg-green-500 text-white" : i === currentStep ? "bg-blue-500 text-white ring-2 ring-blue-200" : "bg-gray-200 text-gray-400"
            }`}>
              {s.done ? "\u2713" : i + 1}
            </div>
            <span className="text-[9px] text-gray-500 whitespace-nowrap">{s.label}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── Tail Status Grid ───────────────────────────────────────────────────────

function TailStatusGrid({ rows, impactedTails, onTileClick }: {
  rows: CrewSwapRow[];
  impactedTails: Set<string>;
  onTileClick: (tail: string) => void;
}) {
  const byTail = new Map<string, CrewSwapRow[]>();
  for (const r of rows) {
    if (!byTail.has(r.tail_number)) byTail.set(r.tail_number, []);
    byTail.get(r.tail_number)!.push(r);
  }
  const tails = Array.from(byTail.entries()).sort(([a], [b]) => a.localeCompare(b));

  return (
    <div className="grid grid-cols-4 sm:grid-cols-6 md:grid-cols-8 gap-2 p-4">
      {tails.map(([tail, tailRows]) => {
        const isImpacted = impactedTails.has(tail);
        const hasUnsolved = tailRows.some((r) => r.travel_type === "none");
        const hasWarnings = tailRows.some((r) => r.warnings.length > 0);
        const tailCost = tailRows.reduce((s, r) => s + (r.cost_estimate ?? 0), 0);
        const ac = AIRCRAFT_COLORS[tailRows[0]?.aircraft_type ?? ""];

        const tileClass = isImpacted
          ? "bg-red-100 border-red-300 text-red-800"
          : hasUnsolved
          ? "bg-amber-100 border-amber-300 text-amber-800"
          : hasWarnings
          ? "bg-yellow-50 border-yellow-300 text-yellow-800"
          : "bg-green-100 border-green-300 text-green-800";

        return (
          <button
            key={tail}
            onClick={() => onTileClick(tail)}
            className={`rounded-lg p-2.5 text-center border cursor-pointer hover:ring-2 hover:ring-blue-300 transition-all ${tileClass}`}
          >
            <div className="font-mono font-bold text-sm">{tail}</div>
            {ac && <div className={`text-[9px] mt-0.5 ${ac.text}`}>{ac.label}</div>}
            {tailCost > 0 && <div className="text-[9px] mt-0.5 opacity-70">${tailCost}</div>}
          </button>
        );
      })}
    </div>
  );
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function getNextWednesday(): Date {
  const now = new Date();
  const day = now.getDay();
  const daysUntilWed = (3 - day + 7) % 7 || 7;
  const wed = new Date(now);
  wed.setDate(now.getDate() + daysUntilWed);
  wed.setHours(0, 0, 0, 0);
  return wed;
}

function fmtTime(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

function fmtShortTime(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
}

const AIRCRAFT_COLORS: Record<string, { bg: string; text: string; label: string }> = {
  citation_x: { bg: "bg-green-100", text: "text-green-700", label: "Cit X" },
  challenger: { bg: "bg-yellow-100", text: "text-yellow-700", label: "CL" },
  dual: { bg: "bg-purple-100", text: "text-purple-700", label: "Dual" },
};

const FLIGHT_TYPE_COLORS: Record<string, string> = {
  Charter: "bg-blue-100 text-blue-700",
  Revenue: "bg-green-100 text-green-700",
  Positioning: "bg-amber-100 text-amber-700",
  Maintenance: "bg-purple-100 text-purple-700",
  Owner: "bg-emerald-100 text-emerald-700",
  "Ferry/Mx": "bg-gray-100 text-gray-700",
};

function isWednesday(iso: string, targetWed: Date): boolean {
  const d = new Date(iso);
  return d.toISOString().slice(0, 10) === targetWed.toISOString().slice(0, 10);
}

function isLiveFlightType(type: string | null): boolean {
  if (!type) return false;
  return ["charter", "revenue", "owner"].includes(type.toLowerCase());
}

// ─── Swap Sheet (Excel-matching layout) ─────────────────────────────────────

function SwapSheetRow({ row }: { row: CrewSwapRow }) {
  const ac = AIRCRAFT_COLORS[row.aircraft_type];
  const rowBg = ac ? `${ac.bg}/30` : "";

  return (
    <tr className={`hover:bg-gray-50 border-b border-gray-100 ${rowBg}`}>
      {/* Name (Home Base) */}
      <td className="px-3 py-1.5 text-sm">
        <div className="flex items-center gap-1.5">
          {ac && (
            <span className={`inline-block w-2.5 h-2.5 rounded-full ${ac.bg} border ${ac.text.replace("text-", "border-")}`} />
          )}
          <span className="font-medium text-gray-900">{row.name}</span>
          <span className="text-gray-400 text-xs">
            ({row.home_airports.join("/") || "??"})
          </span>
          {row.is_checkairman && <span className="text-[10px] px-1 py-0.5 rounded bg-amber-100 text-amber-700">CA</span>}
          {row.is_skillbridge && <span className="text-[10px] px-1 py-0.5 rounded bg-teal-100 text-teal-700">SB</span>}
        </div>
      </td>

      {/* Swap Location */}
      <td className="px-3 py-1.5 font-mono text-xs text-gray-700 font-medium">
        {row.swap_location ?? "—"}
      </td>

      {/* Aircraft (tail) */}
      <td className="px-3 py-1.5">
        <div className="flex items-center gap-1">
          <span className="font-mono text-xs font-bold text-gray-800">{row.tail_number}</span>
          {ac && (
            <span className={`text-[10px] px-1 py-0.5 rounded ${ac.bg} ${ac.text}`}>{ac.label}</span>
          )}
        </div>
      </td>

      {/* Flight Number */}
      <td className="px-3 py-1.5 text-xs">
        {row.travel_type === "commercial" && row.flight_number ? (
          <span className="font-mono text-blue-700 font-medium">{row.flight_number}</span>
        ) : row.travel_type === "uber" ? (
          <span className="font-mono text-violet-700 font-medium">UBER</span>
        ) : row.travel_type === "rental_car" ? (
          <span className="font-mono text-orange-700 font-medium">RENTAL</span>
        ) : row.travel_type === "drive" ? (
          <span className="font-mono text-amber-700 font-medium">DRIVE</span>
        ) : (
          <span className="text-gray-400">—</span>
        )}
      </td>

      {/* Dep Time */}
      <td className="px-3 py-1.5 text-xs text-gray-600">
        {row.departure_time ? fmtShortTime(row.departure_time) : (
          row.travel_type === "drive" && row.duration_minutes
            ? `~${Math.round(row.duration_minutes / 60 * 10) / 10}h`
            : "—"
        )}
      </td>

      {/* Available / Arrival Time */}
      <td className="px-3 py-1.5 text-xs text-gray-600">
        {row.available_time ? fmtShortTime(row.available_time)
          : row.arrival_time ? fmtShortTime(row.arrival_time)
          : "—"}
      </td>

      {/* Cost */}
      <td className="px-3 py-1.5 text-xs text-gray-500">
        {row.cost_estimate != null ? `$${row.cost_estimate}` : "—"}
      </td>

      {/* Notes / Warnings */}
      <td className="px-3 py-1.5 text-xs max-w-[250px]">
        <div className="space-y-0.5">
          {row.warnings.length > 0 && (
            <div className="text-amber-600">{row.warnings[0]}</div>
          )}
          {row.notes && !row.warnings.length && (
            <div className="text-gray-500">{row.notes}</div>
          )}
          {row.backup_flight && (
            <div className="text-blue-500">Backup: {row.backup_flight}</div>
          )}
          {row.alt_flights.length > 0 && !row.backup_flight && (
            <div className="text-gray-400">+{row.alt_flights.length} alt flights</div>
          )}
        </div>
      </td>
    </tr>
  );
}

function SwapSheet({ rows, view, impacts, impactedTails }: { rows: CrewSwapRow[]; view: "role" | "aircraft"; impacts?: PlanImpact[]; impactedTails?: Set<string> }) {
  if (view === "aircraft") return <SwapSheetByTail rows={rows} impacts={impacts} impactedTails={impactedTails} />;
  return <SwapSheetByRole rows={rows} />;
}

function SwapSheetByRole({ rows }: { rows: CrewSwapRow[] }) {
  const oncomingPics = rows.filter((r) => r.direction === "oncoming" && r.role === "PIC");
  const oncomingSics = rows.filter((r) => r.direction === "oncoming" && r.role === "SIC");
  const offgoingPics = rows.filter((r) => r.direction === "offgoing" && r.role === "PIC");
  const offgoingSics = rows.filter((r) => r.direction === "offgoing" && r.role === "SIC");

  const SectionHeader = ({ title, count, color }: { title: string; count: number; color: string }) => (
    <tr>
      <td colSpan={8} className={`px-3 py-2 text-xs font-bold uppercase tracking-wider ${color}`}>
        {title} ({count})
      </td>
    </tr>
  );

  const columnHeaders = (
    <tr className="text-[10px] text-gray-400 uppercase tracking-wider">
      <th className="px-3 py-1.5 text-left font-medium">Name (Home Base)</th>
      <th className="px-3 py-1.5 text-left font-medium">Swap Location</th>
      <th className="px-3 py-1.5 text-left font-medium">Aircraft</th>
      <th className="px-3 py-1.5 text-left font-medium">Flight Number</th>
      <th className="px-3 py-1.5 text-left font-medium">Dep Time</th>
      <th className="px-3 py-1.5 text-left font-medium">Avail Time</th>
      <th className="px-3 py-1.5 text-left font-medium">Cost</th>
      <th className="px-3 py-1.5 text-left font-medium">Notes</th>
    </tr>
  );

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="bg-gray-50 border-b">
          {columnHeaders}
        </thead>
        <tbody>
          <SectionHeader title="Oncoming Pilots — Pilot In-Command" count={oncomingPics.length} color="bg-green-50 text-green-700 border-t-2 border-green-300" />
          {oncomingPics.map((r, i) => <SwapSheetRow key={`op-${i}`} row={r} />)}
          <SectionHeader title="Oncoming Pilots — Second In-Command" count={oncomingSics.length} color="bg-green-50 text-green-600" />
          {oncomingSics.map((r, i) => <SwapSheetRow key={`os-${i}`} row={r} />)}
          <SectionHeader title="Offgoing Pilots — Pilot In-Command" count={offgoingPics.length} color="bg-red-50 text-red-700 border-t-2 border-red-300" />
          {offgoingPics.map((r, i) => <SwapSheetRow key={`fp-${i}`} row={r} />)}
          <SectionHeader title="Offgoing Pilots — Second In-Command" count={offgoingSics.length} color="bg-red-50 text-red-600" />
          {offgoingSics.map((r, i) => <SwapSheetRow key={`fs-${i}`} row={r} />)}
        </tbody>
      </table>
      {rows.length === 0 && (
        <div className="px-4 py-6 text-center text-sm text-gray-400">
          No swap assignments found. Upload the swap Excel document first.
        </div>
      )}
    </div>
  );
}

function SwapSheetByTail({ rows, impacts, impactedTails }: { rows: CrewSwapRow[]; impacts?: PlanImpact[]; impactedTails?: Set<string> }) {
  // Group by tail number
  const byTail = new Map<string, CrewSwapRow[]>();
  for (const r of rows) {
    if (!byTail.has(r.tail_number)) byTail.set(r.tail_number, []);
    byTail.get(r.tail_number)!.push(r);
  }
  const tails = Array.from(byTail.entries()).sort(([a], [b]) => a.localeCompare(b));

  return (
    <div className="space-y-3 p-3">
      {tails.map(([tail, tailRows]) => {
        const onPic = tailRows.find((r) => r.direction === "oncoming" && r.role === "PIC");
        const onSic = tailRows.find((r) => r.direction === "oncoming" && r.role === "SIC");
        const offPic = tailRows.find((r) => r.direction === "offgoing" && r.role === "PIC");
        const offSic = tailRows.find((r) => r.direction === "offgoing" && r.role === "SIC");
        const ac = AIRCRAFT_COLORS[onPic?.aircraft_type ?? onSic?.aircraft_type ?? offPic?.aircraft_type ?? ""];
        const tailCost = tailRows.reduce((s, r) => s + (r.cost_estimate ?? 0), 0);
        const swapLoc = onPic?.swap_location ?? onSic?.swap_location ?? offPic?.swap_location ?? "?";
        const allWarnings = tailRows.flatMap((r) => r.warnings);

        // Timing analysis: check aircraft never unattended
        const latestOnArrival = [onPic, onSic]
          .filter((r) => r?.available_time)
          .map((r) => new Date(r!.available_time!).getTime())
          .sort((a, b) => b - a)[0] ?? null;
        const earliestOffDep = [offPic, offSic]
          .filter((r) => r?.departure_time)
          .map((r) => new Date(r!.departure_time!).getTime())
          .sort((a, b) => a - b)[0] ?? null;
        const hasGap = latestOnArrival && earliestOffDep && earliestOffDep >= latestOnArrival;
        const gapMinutes = latestOnArrival && earliestOffDep
          ? Math.round((earliestOffDep - latestOnArrival) / 60_000)
          : null;

        function CrewSlot({ label, color, row }: { label: string; color: string; row: CrewSwapRow | undefined }) {
          if (!row) return (
            <div className="flex items-center gap-2 py-1.5 px-3 rounded bg-gray-50">
              <span className={`text-[10px] font-bold uppercase ${color} w-14`}>{label}</span>
              <span className="text-xs text-gray-400">— not assigned —</span>
            </div>
          );
          return (
            <div className="flex items-center gap-2 py-1.5 px-3 rounded bg-gray-50/50">
              <span className={`text-[10px] font-bold uppercase ${color} w-14 shrink-0`}>{label}</span>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className="text-sm font-medium text-gray-900 truncate">{row.name}</span>
                  <span className="text-[10px] text-gray-400">({row.home_airports.join("/")})</span>
                  {row.is_checkairman && <span className="text-[9px] px-1 py-0.5 rounded bg-amber-100 text-amber-700">CA</span>}
                  {row.is_skillbridge && <span className="text-[9px] px-1 py-0.5 rounded bg-teal-100 text-teal-700">SB</span>}
                </div>
                <div className="flex items-center gap-3 mt-0.5">
                  {row.travel_type === "commercial" && row.flight_number ? (
                    <span className="font-mono text-[11px] text-blue-700 font-medium">{row.flight_number}</span>
                  ) : row.travel_type === "uber" ? (
                    <span className="font-mono text-[11px] text-violet-700 font-medium">UBER</span>
                  ) : row.travel_type === "rental_car" ? (
                    <span className="font-mono text-[11px] text-orange-700 font-medium">RENTAL</span>
                  ) : row.travel_type === "drive" ? (
                    <span className="font-mono text-[11px] text-amber-700 font-medium">DRIVE</span>
                  ) : (
                    <span className="text-[11px] text-red-500 font-medium">NO TRANSPORT</span>
                  )}
                  {row.departure_time && (
                    <span className="text-[11px] text-gray-500">dep {fmtShortTime(row.departure_time)}</span>
                  )}
                  {(row.available_time ?? row.arrival_time) && (
                    <span className="text-[11px] text-gray-500">
                      {row.direction === "oncoming" ? "avail" : "arr"} {fmtShortTime(row.available_time ?? row.arrival_time)}
                    </span>
                  )}
                  {row.cost_estimate != null && (
                    <span className="text-[11px] text-gray-400">${row.cost_estimate}</span>
                  )}
                  {row.backup_flight && (
                    <span className="text-[10px] text-blue-400">backup: {row.backup_flight}</span>
                  )}
                </div>
              </div>
              {row.warnings.length > 0 && (
                <span className="text-amber-500 text-[10px] shrink-0" title={row.warnings.join("\n")}>
                  {row.warnings.length} warn
                </span>
              )}
            </div>
          );
        }

        const tailImpacts = impacts?.filter((i) => i.tail_number === tail && !i.resolved) ?? [];
        const isImpacted = impactedTails?.has(tail) || tailImpacts.length > 0;
        const isSolved = [onPic, onSic, offPic, offSic].every((r) => r && r.travel_type !== "none");
        const borderColor = isImpacted ? "border-l-red-500" : !isSolved ? "border-l-amber-400" : "border-l-green-500";

        return (
          <div key={tail} id={`tail-${tail}`} className={`rounded-lg border border-l-4 ${borderColor} bg-white overflow-hidden ${tailImpacts.some(i => i.severity === "critical") ? "ring-2 ring-red-300" : ""}`}>
            {/* Tail header */}
            <div className="px-4 py-2 bg-gray-50 border-b flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="font-mono font-bold text-gray-900">{tail}</span>
                {ac && <span className={`text-[10px] px-1.5 py-0.5 rounded ${ac.bg} ${ac.text}`}>{ac.label}</span>}
                <span className="font-mono text-xs text-gray-500">
                  @ {swapLoc}
                  {(() => {
                    const allPts = onPic?.all_swap_points ?? onSic?.all_swap_points ?? [];
                    const others = [...new Set(allPts.filter(p => p !== swapLoc))];
                    return others.length > 0 ? ` (also ${others.join(", ")})` : "";
                  })()}
                </span>
              </div>
              <div className="flex items-center gap-3">
                {tailImpacts.length > 0 && (
                  <span className={`text-[10px] px-1.5 py-0.5 rounded font-bold ${
                    tailImpacts.some(i => i.severity === "critical") ? "bg-red-100 text-red-700" : "bg-amber-100 text-amber-700"
                  }`}>
                    {tailImpacts.length} impact{tailImpacts.length > 1 ? "s" : ""}
                  </span>
                )}
                {gapMinutes !== null && (
                  <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${
                    hasGap ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700"
                  }`}>
                    {hasGap ? `${gapMinutes}min overlap` : `${Math.abs(gapMinutes)}min gap — unattended`}
                  </span>
                )}
                {tailCost > 0 && (
                  <span className="text-xs text-gray-500">${tailCost.toLocaleString()}</span>
                )}
              </div>
            </div>

            {/* Impact banners */}
            {tailImpacts.length > 0 && (
              <div className="px-4 py-2 space-y-1 border-b" style={{ background: tailImpacts.some(i => i.severity === "critical") ? "#fef2f2" : "#fffbeb" }}>
                {tailImpacts.map((imp) => (
                  <div key={imp.id} className="text-xs">
                    <span className={`font-bold ${imp.severity === "critical" ? "text-red-700" : "text-amber-700"}`}>
                      {imp.severity === "critical" ? "CRITICAL" : "WARNING"}:
                    </span>
                    {imp.affected_crew.map((c, ci) => (
                      <span key={ci} className="ml-2 text-gray-700">
                        {c.name} ({c.role} {c.direction}): {c.detail}
                      </span>
                    ))}
                  </div>
                ))}
              </div>
            )}

            {/* Crew grid: oncoming on left, offgoing on right */}
            <div className="grid grid-cols-2 divide-x">
              <div className="p-2 space-y-1">
                <div className="text-[10px] font-bold uppercase text-green-600 px-3 pb-1">Oncoming</div>
                <CrewSlot label="PIC" color="text-green-700" row={onPic} />
                <CrewSlot label="SIC" color="text-green-600" row={onSic} />
              </div>
              <div className="p-2 space-y-1">
                <div className="text-[10px] font-bold uppercase text-red-600 px-3 pb-1">Offgoing</div>
                <CrewSlot label="PIC" color="text-red-700" row={offPic} />
                <CrewSlot label="SIC" color="text-red-600" row={offSic} />
              </div>
            </div>

            {/* Tail-level warnings */}
            {allWarnings.length > 0 && (
              <div className="px-4 py-1.5 bg-amber-50 border-t text-[10px] text-amber-700 space-y-0.5">
                {[...new Set(allWarnings)].slice(0, 3).map((w, i) => (
                  <div key={i}>{w}</div>
                ))}
                {allWarnings.length > 3 && <div>+{allWarnings.length - 3} more</div>}
              </div>
            )}
          </div>
        );
      })}
      {rows.length === 0 && (
        <div className="px-4 py-6 text-center text-sm text-gray-400">
          No swap assignments found. Upload the swap Excel document first.
        </div>
      )}
    </div>
  );
}

// ─── Main Component ──────────────────────────────────────────────────────────

export default function CrewSwap({ flights }: { flights: Flight[] }) {
  const [selectedWed, setSelectedWed] = useState<Date>(getNextWednesday());
  const [crew, setCrew] = useState<CrewMember[]>([]);
  const [crewLoaded, setCrewLoaded] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadResult, setUploadResult] = useState<RosterUploadResult | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [showRoster, setShowRoster] = useState(false);
  const [optimizing, setOptimizing] = useState(false);
  const [swapPlan, setSwapPlan] = useState<SwapPlanResult | null>(null);
  const [optimizeError, setOptimizeError] = useState<string | null>(null);
  const [showSchedule, setShowSchedule] = useState(false);
  const swapPlanRef = useRef<HTMLDivElement>(null);
  const [exporting, setExporting] = useState(false);
  const [swapView, setSwapView] = useState<"role" | "aircraft">("aircraft");
  const [routeStatus, setRouteStatus] = useState<RouteStatus | null>(null);
  const [computingRoutes, setComputingRoutes] = useState(false);
  const [detectingRotation, setDetectingRotation] = useState(false);
  const [rotationSource, setRotationSource] = useState<string | null>(null);
  // Phase 1-2: Volunteer preferences
  const [volunteers, setVolunteers] = useState<VolunteerResponse[]>([]);
  const [volunteerOverrides, setVolunteerOverrides] = useState<Record<string, string>>({});
  const [parsingVolunteers, setParsingVolunteers] = useState(false);
  const [showVolunteers, setShowVolunteers] = useState(false);
  // Phase 3: Swap points
  const [swapPoints, setSwapPoints] = useState<SwapPointData[]>([]);
  const [showSwapPoints, setShowSwapPoints] = useState(false);
  const [loadingSwapPoints, setLoadingSwapPoints] = useState(false);
  // Phase 4: Flight change alerts
  const [swapAlerts, setSwapAlerts] = useState<SwapAlert[]>([]);
  const [alertCount, setAlertCount] = useState(0);
  // Excluded tails (MX, owner-flown, etc.)
  const [excludedTails, setExcludedTails] = useState<Set<string>>(new Set());
  // Phase 5-6: Strategy
  const [strategy, setStrategy] = useState<"offgoing_first" | "oncoming_first">("offgoing_first");
  // Tabs
  const [activeTab, setActiveTab] = useState<"setup" | "plan" | "impacts">("setup");
  // Toasts
  const [toasts, setToasts] = useState<Toast[]>([]);
  const addToast = useCallback((type: Toast["type"], msg: string) => {
    const id = ++_toastId;
    setToasts((prev) => [...prev, { id, type, msg }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 4000);
  }, []);
  const removeToast = useCallback((id: number) => setToasts((prev) => prev.filter((t) => t.id !== id)), []);
  // Plan persistence
  const [savedPlanMeta, setSavedPlanMeta] = useState<{ id: string; version: number; created_at: string } | null>(null);
  const [savingPlan, setSavingPlan] = useState(false);
  const [loadingPlan, setLoadingPlan] = useState(false);
  // Impact detection
  const [planImpacts, setPlanImpacts] = useState<PlanImpact[]>([]);
  const [checkingImpacts, setCheckingImpacts] = useState(false);
  // Plan history
  const [planVersions, setPlanVersions] = useState<PlanVersion[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [loadingVersion, setLoadingVersion] = useState(false);

  async function exportToImage() {
    if (!swapPlanRef.current) return;
    setExporting(true);
    try {
      const dataUrl = await toPng(swapPlanRef.current, {
        backgroundColor: "#ffffff",
        pixelRatio: 2,
        style: { overflow: "visible" },
      });
      const link = document.createElement("a");
      link.download = `swap-plan-${selectedWed.toISOString().slice(0, 10)}.png`;
      link.href = dataUrl;
      link.click();
    } catch (e) {
      console.error("Export failed:", e);
    } finally {
      setExporting(false);
    }
  }

  function exportToExcel() {
    if (!swapPlan) return;
    const rows = swapPlan.rows;
    const oncomingPics = rows.filter((r) => r.direction === "oncoming" && r.role === "PIC");
    const oncomingSics = rows.filter((r) => r.direction === "oncoming" && r.role === "SIC");
    const offgoingPics = rows.filter((r) => r.direction === "offgoing" && r.role === "PIC");
    const offgoingSics = rows.filter((r) => r.direction === "offgoing" && r.role === "SIC");

    const AIRCRAFT_EMOJI: Record<string, string> = {
      citation_x: "\u{1F7E2}", // green circle
      challenger: "\u{1F7E1}", // yellow circle
      dual: "\u{1F7E3}",       // purple circle
    };

    function crewCell(r: CrewSwapRow): string {
      const emoji = AIRCRAFT_EMOJI[r.aircraft_type] ?? "";
      const home = r.home_airports.length > 0 ? ` (${r.home_airports.join("/")})` : "";
      const ca = r.is_checkairman ? " \u2714" : "";
      return `${emoji} ${r.name}${home}${ca}`.trim();
    }

    function fmtLocal(iso: string | null): string {
      if (!iso) return "";
      return new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }) + "L";
    }

    function travelLabel(r: CrewSwapRow): string {
      if (r.travel_type === "commercial" && r.flight_number) return r.flight_number;
      if (r.travel_type === "uber") return "UBER";
      if (r.travel_type === "rental_car") return "RENTAL";
      if (r.travel_type === "drive") return "DRIVE";
      return "";
    }

    // Headers match the manual Excel layout
    const ONCOMING_HEADER = [
      "SB", "Vol", "Name (Home Base)", "Swap Location", "Aircraft",
      "Flight Number", "Date", "Duty On Time", "Arrival Time",
      "Price", "Notes", "Verified Ticket", "Bonus Eligible", "Bonus Claimed",
      "", "", // gap columns
      "OLD PIC", "NEW PIC", "TAIL",
    ];

    const OFFGOING_HEADER = [
      "SB", "Vol", "Name (Home Base)", "Swap Location", "Aircraft",
      "Flight Number", "Date", "Depart", "Arrival Time",
      "Price", "Notes", "Verified Ticket", "Bonus Eligible", "Bonus Claimed",
    ];

    function dataRow(r: CrewSwapRow, isOffgoing: boolean): (string | number | null)[] {
      return [
        r.is_skillbridge ? "SB" : "",
        r.volunteer_status ?? "",
        crewCell(r),
        r.swap_location ?? "",
        r.tail_number,
        travelLabel(r),
        r.departure_time ? new Date(r.departure_time).toLocaleDateString() : "",
        isOffgoing
          ? fmtLocal(r.departure_time)                          // Offgoing: Depart time
          : fmtLocal(r.duty_on_time ?? r.departure_time),       // Oncoming: Duty On Time
        fmtLocal(r.available_time ?? r.arrival_time),            // Arrival Time (times only, no airports)
        r.cost_estimate != null ? `$${r.cost_estimate}` : "",
        [...(r.notes ? [r.notes] : []), ...r.warnings].filter(Boolean).join("; "),
        "", // Verified Ticket (manual)
        r.volunteer_status ? "Y" : "",
        "", // Bonus Claimed (manual)
      ];
    }

    // Sort rows within each section by aircraft type: CX → Challenger → Standby → OFF
    const acTypeOrder = (r: CrewSwapRow): number => {
      if (r.swap_location === "STANDBY" || r.travel_type === "none") return 2;
      if (r.aircraft_type === "citation_x") return 0;
      if (r.aircraft_type === "challenger") return 1;
      return 3; // OFF/unavailable
    };
    const sortSection = (arr: CrewSwapRow[]) =>
      [...arr].sort((a, b) => acTypeOrder(a) - acTypeOrder(b) || a.tail_number.localeCompare(b.tail_number));

    const sheetData: (string | number | null)[][] = [];

    // ONCOMING PILOTS
    sheetData.push(["", "", "ONCOMING PILOTS", "", "", "", "", "", "", "", "", "", "", ""]);
    sheetData.push(["", "", "PILOT IN-COMMAND", "", "", "", "", "", "", "", "", "", "", ""]);
    sheetData.push(ONCOMING_HEADER);
    for (const r of sortSection(oncomingPics)) sheetData.push(dataRow(r, false));
    sheetData.push([]);
    sheetData.push(["", "", "SECOND IN-COMMAND", "", "", "", "", "", "", "", "", "", "", ""]);
    sheetData.push(ONCOMING_HEADER);
    for (const r of sortSection(oncomingSics)) sheetData.push(dataRow(r, false));
    sheetData.push([]);

    // OFFGOING PILOTS
    sheetData.push(["", "", "OFFGOING PILOTS", "", "", "", "", "", "", "", "", "", "", ""]);
    sheetData.push(["", "", "PILOT IN-COMMAND", "", "", "", "", "", "", "", "", "", "", ""]);
    sheetData.push(OFFGOING_HEADER);
    for (const r of sortSection(offgoingPics)) sheetData.push(dataRow(r, true));
    sheetData.push([]);
    sheetData.push(["", "", "SECOND IN-COMMAND", "", "", "", "", "", "", "", "", "", "", ""]);
    sheetData.push(OFFGOING_HEADER);
    for (const r of sortSection(offgoingSics)) sheetData.push(dataRow(r, true));

    // Summary row
    sheetData.push([]);
    sheetData.push(["", "", `Total Est. Cost: $${swapPlan.total_cost.toLocaleString()}`, "", "",
      `Score: ${swapPlan.plan_score}`, `Solved: ${swapPlan.solved_count ?? 0}`,
      `Unsolved: ${swapPlan.unsolved_count ?? 0}`, "", "", "", "", "", ""]);
    if (swapPlan.warnings.length > 0) {
      sheetData.push(["", "", "WARNINGS:", "", "", "", "", "", "", "", "", "", "", ""]);
      for (const w of swapPlan.warnings) {
        sheetData.push(["", "", w, "", "", "", "", "", "", "", "", "", "", ""]);
      }
    }

    // To-Do List sidebar (columns P-R on first oncoming header row)
    // Find the first oncoming header row index and add to-do items
    const todoItems = [
      "Verify all tickets booked",
      "Confirm rental cars reserved",
      "Send crew notifications",
      "Update JetInsight schedules",
      "Confirm FBO crew lounges",
      "Verify ground transport",
    ];
    // Add to-do list to the first few rows after the first header
    for (let i = 0; i < Math.min(todoItems.length, sheetData.length); i++) {
      const row = sheetData[i + 3]; // skip title rows + header
      if (row && row.length < 19) {
        while (row.length < 16) row.push("");
        row.push("", "", "");
      }
    }

    const ws = XLSX.utils.aoa_to_sheet(sheetData);
    // Set column widths: A-N = data, O-P = gap, Q-S = To-Do sidebar
    ws["!cols"] = [
      { wch: 4 },  // SB
      { wch: 18 }, // Vol
      { wch: 28 }, // Name (Home Base)
      { wch: 12 }, // Swap Location
      { wch: 12 }, // Aircraft
      { wch: 18 }, // Flight Number
      { wch: 10 }, // Date
      { wch: 12 }, // Duty On / Depart
      { wch: 12 }, // Arrival Time
      { wch: 8 },  // Price
      { wch: 35 }, // Notes
      { wch: 10 }, // Verified Ticket
      { wch: 10 }, // Bonus Eligible
      { wch: 10 }, // Bonus Claimed
      { wch: 3 },  // gap
      { wch: 3 },  // gap
      { wch: 14 }, // OLD PIC
      { wch: 14 }, // NEW PIC
      { wch: 12 }, // TAIL
    ];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Swap Plan");
    XLSX.writeFile(wb, `swap-plan-${selectedWed.toISOString().slice(0, 10)}.xlsx`);
  }

  const [swapAssignments, setSwapAssignments] = useState<Record<string, SwapAssignment> | null>(() => {
    if (typeof window === "undefined") return null;
    try {
      const stored = localStorage.getItem("swap_assignments");
      return stored ? JSON.parse(stored) : null;
    } catch { return null; }
  });
  const [oncomingPool, setOncomingPool] = useState<OncomingPool | null>(() => {
    if (typeof window === "undefined") return null;
    try {
      const stored = localStorage.getItem("oncoming_pool");
      return stored ? JSON.parse(stored) : null;
    } catch { return null; }
  });

  // Fetch crew roster
  const loadCrew = useCallback(async () => {
    try {
      const res = await fetch("/api/crew/roster");
      if (!res.ok) return;
      const data = await res.json();
      setCrew(data.crew ?? []);
      setCrewLoaded(true);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    loadCrew();
  }, [loadCrew]);

  // Fetch route computation status for the selected Wednesday
  const loadRouteStatus = useCallback(async () => {
    try {
      const dateStr = selectedWed.toISOString().slice(0, 10);
      const res = await fetch(`/api/crew/routes?date=${dateStr}`);
      if (!res.ok) return;
      const data = await res.json();
      setRouteStatus(data);
    } catch {
      // ignore
    }
  }, [selectedWed]);

  useEffect(() => {
    loadRouteStatus();
  }, [loadRouteStatus]);

  // Load volunteer preferences for selected Wednesday
  const loadVolunteers = useCallback(async () => {
    try {
      const dateStr = selectedWed.toISOString().slice(0, 10);
      const res = await fetch(`/api/crew/volunteers?swap_date=${dateStr}`);
      if (!res.ok) return;
      const data = await res.json();
      setVolunteers(data.volunteers ?? []);
    } catch { /* ignore */ }
  }, [selectedWed]);

  useEffect(() => { loadVolunteers(); }, [loadVolunteers]);

  // Load swap points
  const loadSwapPoints = useCallback(async () => {
    setLoadingSwapPoints(true);
    try {
      const dateStr = selectedWed.toISOString().slice(0, 10);
      const res = await fetch(`/api/crew/swap-points?swap_date=${dateStr}`);
      if (!res.ok) return;
      const data = await res.json();
      setSwapPoints(data.tails ?? []);
    } catch { /* ignore */ }
    finally { setLoadingSwapPoints(false); }
  }, [selectedWed]);

  // Load flight change alerts
  const loadAlerts = useCallback(async () => {
    try {
      const dateStr = selectedWed.toISOString().slice(0, 10);
      const res = await fetch(`/api/crew/swap-alerts?swap_date=${dateStr}`);
      if (!res.ok) return;
      const data = await res.json();
      setSwapAlerts(data.alerts ?? []);
      setAlertCount(data.unacknowledged_count ?? 0);
    } catch { /* ignore */ }
  }, [selectedWed]);

  useEffect(() => { loadAlerts(); }, [loadAlerts]);

  // Parse volunteer thread on-demand
  async function parseVolunteers() {
    setParsingVolunteers(true);
    try {
      const res = await fetch("/api/crew/volunteers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ swap_date: selectedWed.toISOString().slice(0, 10) }),
      });
      if (res.ok) await loadVolunteers();
    } catch { /* ignore */ }
    finally { setParsingVolunteers(false); }
  }

  // Override a volunteer preference
  async function overrideVolunteer(id: string, preference: string) {
    setVolunteerOverrides((prev) => ({ ...prev, [id]: preference }));
    try {
      await fetch("/api/crew/volunteers", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, parsed_preference: preference }),
      });
      await loadVolunteers();
    } catch { /* ignore */ }
  }

  // Acknowledge alert
  async function acknowledgeAlert(id: string) {
    try {
      await fetch("/api/crew/swap-alerts", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      await loadAlerts();
    } catch { /* ignore */ }
  }

  // Load saved plan for selected Wednesday
  const loadSavedPlan = useCallback(async () => {
    setLoadingPlan(true);
    try {
      const dateStr = selectedWed.toISOString().slice(0, 10);
      const res = await fetch(`/api/crew/swap-plan?swap_date=${dateStr}`);
      if (!res.ok) return;
      const data = await res.json();
      if (data.plan) {
        const plan = data.plan as SavedPlan;
        setSwapPlan(plan.plan_data);
        setSavedPlanMeta({ id: plan.id, version: plan.version, created_at: plan.created_at });
        if (plan.swap_assignments) {
          setSwapAssignments(plan.swap_assignments);
          try { localStorage.setItem("swap_assignments", JSON.stringify(plan.swap_assignments)); } catch {}
        }
        if (plan.oncoming_pool) {
          setOncomingPool(plan.oncoming_pool);
          try { localStorage.setItem("oncoming_pool", JSON.stringify(plan.oncoming_pool)); } catch {}
        }
        if (plan.strategy) {
          setStrategy(plan.strategy as "offgoing_first" | "oncoming_first");
        }
        setPlanImpacts(data.impacts ?? []);
      } else {
        setSavedPlanMeta(null);
        setPlanImpacts([]);
      }
    } catch { /* ignore */ }
    finally { setLoadingPlan(false); }
  }, [selectedWed]);

  useEffect(() => { loadSavedPlan(); }, [loadSavedPlan]);

  // Save current plan
  async function savePlan() {
    if (!swapPlan) return;
    setSavingPlan(true);
    try {
      const res = await fetch("/api/crew/swap-plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          swap_date: selectedWed.toISOString().slice(0, 10),
          plan_data: swapPlan,
          swap_assignments: swapAssignments,
          oncoming_pool: oncomingPool,
          strategy,
        }),
      });
      if (res.ok) {
        const data = await res.json();
        setSavedPlanMeta({ id: data.id, version: data.version, created_at: data.created_at });
        addToast("success", `Plan saved (v${data.version})`);
      } else {
        addToast("error", "Failed to save plan");
      }
    } catch { addToast("error", "Failed to save plan"); }
    finally { setSavingPlan(false); }
  }

  // Check impacts — works client-side against in-memory plan, or server-side if saved
  async function checkImpacts() {
    const planRows = swapPlan?.rows;
    if (!planRows || planRows.length === 0) {
      addToast("warning", "Run the optimizer first to analyze impacts");
      return;
    }
    setCheckingImpacts(true);
    try {
      if (savedPlanMeta) {
        // Server-side: cross-reference against saved plan + persist results
        const res = await fetch("/api/crew/swap-plan/impact", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ swap_date: selectedWed.toISOString().slice(0, 10) }),
        });
        if (res.ok) {
          const data = await res.json();
          setPlanImpacts(data.impacts?.map((imp: PlanImpact & { id?: string }, i: number) => ({
            ...imp,
            id: imp.id ?? `temp-${i}`,
            resolved: false,
          })) ?? []);
          const count = data.impacts?.length ?? 0;
          addToast(count > 0 ? "warning" : "success", count > 0 ? `${count} impact(s) detected` : "No impacts found");
        }
      } else {
        // Client-side: analyze in-memory plan against current alerts
        const unacked = swapAlerts.filter((a) => !a.acknowledged);
        if (unacked.length === 0) {
          addToast("success", "No unacknowledged alerts to analyze");
          setCheckingImpacts(false);
          return;
        }
        const results: PlanImpact[] = [];
        for (const alert of unacked) {
          const tailRows = planRows.filter((r) => r.tail_number === alert.tail_number);
          if (tailRows.length === 0) continue;
          const affected: PlanImpact["affected_crew"] = [];
          let severity: "critical" | "warning" | "info" = "info";

          if (alert.change_type === "cancelled") {
            for (const r of tailRows) {
              affected.push({ name: r.name, role: r.role, direction: r.direction, detail: "Leg cancelled — swap point may have changed" });
            }
            severity = "critical";
          } else if (alert.change_type === "airport_change") {
            const oldAirport = (alert.old_value?.departure_icao as string) ?? (alert.old_value?.arrival_icao as string);
            const newAirport = (alert.new_value?.departure_icao as string) ?? (alert.new_value?.arrival_icao as string);
            for (const r of tailRows) {
              if (r.swap_location && oldAirport && r.swap_location === oldAirport) {
                affected.push({ name: r.name, role: r.role, direction: r.direction, detail: `Traveling to ${oldAirport} but leg now at ${newAirport ?? "?"}` });
                severity = "critical";
              }
            }
          } else if (alert.change_type === "time_change") {
            const newDep = alert.new_value?.scheduled_departure as string | undefined;
            if (newDep) {
              const newDepTime = new Date(newDep).getTime();
              for (const r of tailRows) {
                if (r.direction === "oncoming") {
                  const arr = r.available_time ?? r.arrival_time;
                  if (arr && new Date(arr).getTime() > newDepTime) {
                    affected.push({ name: r.name, role: r.role, direction: r.direction, detail: "Arrives after aircraft departs" });
                    severity = "critical";
                  }
                }
              }
            }
            if (affected.length === 0) {
              for (const r of tailRows) {
                affected.push({ name: r.name, role: r.role, direction: r.direction, detail: "Leg time changed — review timing" });
              }
              severity = "warning";
            }
          } else if (alert.change_type === "added") {
            for (const r of tailRows) {
              affected.push({ name: r.name, role: r.role, direction: r.direction, detail: "New leg added — swap points may need review" });
            }
            severity = "warning";
          }

          if (affected.length > 0) {
            results.push({ id: `local-${alert.id}`, alert_id: alert.id, tail_number: alert.tail_number, affected_crew: affected, severity, resolved: false });
          }
        }
        setPlanImpacts(results);
        addToast(results.length > 0 ? "warning" : "success", results.length > 0 ? `${results.length} impact(s) detected` : "No impacts on current plan");
      }
    } catch {
      addToast("error", "Impact analysis failed");
    }
    finally { setCheckingImpacts(false); }
  }

  // Auto-check impacts when plan is loaded and there are unacknowledged alerts
  useEffect(() => {
    if (savedPlanMeta && alertCount > 0 && !checkingImpacts) {
      checkImpacts();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedPlanMeta, alertCount]);

  // Load plan version history
  async function loadPlanHistory() {
    try {
      const dateStr = selectedWed.toISOString().slice(0, 10);
      const res = await fetch(`/api/crew/swap-plan?swap_date=${dateStr}&version=all`);
      if (!res.ok) return;
      const data = await res.json();
      setPlanVersions(data.versions ?? []);
    } catch { /* ignore */ }
  }

  // Load a specific historical version (re-fetches the full plan from the server)
  async function loadVersion(versionId: string) {
    setLoadingVersion(true);
    try {
      // We need to fetch the full plan data. The history endpoint only returns metadata.
      // For now, re-fetch active plan. If user wants a specific version, they would need
      // to be able to restore it. We'll implement restore by re-saving the version's data.
      // For MVP, just show version list. Full restore is a future enhancement.
      setLoadingVersion(false);
      console.log("Load version:", versionId);
    } catch { /* ignore */ }
    finally { setLoadingVersion(false); }
  }

  // Re-optimize only affected tails
  async function reoptimizeAffected() {
    if (!swapPlan || planImpacts.length === 0) return;
    const affectedTails = new Set(planImpacts.filter(i => !i.resolved).map(i => i.tail_number));
    if (affectedTails.size === 0) return;

    // Lock all tails that are NOT affected
    const allTails = [...new Set(swapPlan.rows.map(r => r.tail_number))];
    const lockTails = allTails.filter(t => !affectedTails.has(t));
    const lockedRows = swapPlan.rows.filter(r => !affectedTails.has(r.tail_number));

    setOptimizing(true);
    setOptimizeError(null);
    try {
      let filteredAssignments = swapAssignments;
      if (filteredAssignments && excludedTails.size > 0) {
        filteredAssignments = Object.fromEntries(
          Object.entries(filteredAssignments).filter(([tail]) => !excludedTails.has(tail))
        );
      }
      const res = await fetch("/api/crew/optimize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          swap_date: selectedWed.toISOString().slice(0, 10),
          swap_assignments: filteredAssignments ?? undefined,
          oncoming_pool: oncomingPool ?? undefined,
          strategy,
          lock_tails: lockTails,
          locked_rows: lockedRows,
        }),
      });
      const text = await res.text();
      let data;
      try { data = JSON.parse(text); } catch {
        setOptimizeError(`Server error: ${text.slice(0, 200)}`);
        return;
      }
      if (!res.ok) {
        setOptimizeError(data.error ?? "Re-optimization failed");
      } else {
        setSwapPlan(data);
        // Clear impacts since we re-optimized
        setPlanImpacts([]);
      }
    } catch (e) {
      setOptimizeError(e instanceof Error ? e.message : "Re-optimization failed");
    } finally {
      setOptimizing(false);
    }
  }

  // Safe JSON parse — Vercel timeouts return HTML like "An error occurred..."
  async function safeJson(res: Response, fallbackError: string) {
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(res.status === 504 ? `${fallbackError} (timed out)` : `${fallbackError}: ${text.slice(0, 120)}`);
    }
  }

  // Trigger route computation
  async function computeRoutes() {
    setComputingRoutes(true);
    try {
      const res = await fetch("/api/crew/routes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ swap_date: selectedWed.toISOString().slice(0, 10) }),
      });
      const data = await safeJson(res, "Route computation failed");
      if (res.ok) {
        await loadRouteStatus();
      } else {
        setOptimizeError(data.error ?? "Route computation failed");
      }
    } catch (e) {
      setOptimizeError(e instanceof Error ? e.message : "Route computation failed");
    } finally {
      setComputingRoutes(false);
    }
  }

  // Auto-detect rotation from JetInsight flights
  async function detectRotation() {
    setDetectingRotation(true);
    setOptimizeError(null);
    try {
      const dateStr = selectedWed.toISOString().slice(0, 10);
      const res = await fetch(`/api/crew/detect-rotation?date=${dateStr}`);
      const data = await safeJson(res, "Rotation detection failed");
      if (!res.ok) {
        setOptimizeError(data.error ?? "Rotation detection failed");
        return;
      }
      if (data.swap_assignments) {
        setSwapAssignments(data.swap_assignments);
        try { localStorage.setItem("swap_assignments", JSON.stringify(data.swap_assignments)); } catch {}
      }
      if (data.oncoming_pool) {
        setOncomingPool(data.oncoming_pool);
        try { localStorage.setItem("oncoming_pool", JSON.stringify(data.oncoming_pool)); } catch {}
      }
      setRotationSource("auto_detect");
      if (data.unmatched_names?.length > 0) {
        setOptimizeError(`Auto-detected rotation. ${data.unmatched_names.length} JetInsight names unmatched: ${data.unmatched_names.join(", ")}`);
      }
    } catch (e) {
      setOptimizeError(e instanceof Error ? e.message : "Rotation detection failed");
    } finally {
      setDetectingRotation(false);
    }
  }

  // Upload Excel roster
  async function handleUpload(file: File) {
    setUploading(true);
    setUploadError(null);
    setUploadResult(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/crew/roster", { method: "POST", body: fd });
      const data = await safeJson(res, "Upload failed");
      if (!res.ok) {
        setUploadError(data.error ?? "Upload failed");
      } else {
        setUploadResult(data);
        if (data.swap_assignments) {
          setSwapAssignments(data.swap_assignments);
          try { localStorage.setItem("swap_assignments", JSON.stringify(data.swap_assignments)); } catch {}
        }
        if (data.oncoming_pool) {
          setOncomingPool(data.oncoming_pool);
          try { localStorage.setItem("oncoming_pool", JSON.stringify(data.oncoming_pool)); } catch {}
        }
        setRotationSource("excel");
        await loadCrew();
      }
    } catch (e) {
      setUploadError(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  }

  // Build per-tail schedule for the Aircraft Schedule section
  const tailSchedules = useMemo(() => {
    const byTail = new Map<string, Flight[]>();
    for (const f of flights) {
      if (!f.tail_number) continue;
      if (!byTail.has(f.tail_number)) byTail.set(f.tail_number, []);
      byTail.get(f.tail_number)!.push(f);
    }

    const schedules: { tail: string; wedFlights: Flight[]; lastKnown: string | null }[] = [];

    for (const [tail, tailFlights] of byTail) {
      const sorted = [...tailFlights].sort(
        (a, b) => new Date(a.scheduled_departure).getTime() - new Date(b.scheduled_departure).getTime(),
      );
      const wedFlights = sorted.filter((f) => isWednesday(f.scheduled_departure, selectedWed));
      const lastKnown = sorted.filter((f) => f.arrival_icao).pop()?.arrival_icao ?? null;
      schedules.push({ tail, wedFlights, lastKnown });
    }

    return schedules.sort((a, b) => a.tail.localeCompare(b.tail));
  }, [flights, selectedWed]);

  // Run swap optimizer (uses pre-computed routes from pilot_routes table)
  async function runOptimizer() {
    setOptimizing(true);
    setOptimizeError(null);
    try {
      // Filter out excluded tails from swap assignments
      let filteredAssignments = swapAssignments;
      if (filteredAssignments && excludedTails.size > 0) {
        filteredAssignments = Object.fromEntries(
          Object.entries(filteredAssignments).filter(([tail]) => !excludedTails.has(tail))
        );
      }
      const res = await fetch("/api/crew/optimize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          swap_date: selectedWed.toISOString().slice(0, 10),
          swap_assignments: filteredAssignments ?? undefined,
          oncoming_pool: oncomingPool ?? undefined,
          strategy,
        }),
      });
      const text = await res.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        setOptimizeError(`Server error: ${text.slice(0, 200)}`);
        return;
      }
      if (!res.ok) {
        setOptimizeError(data.error ?? "Optimization failed");
        addToast("error", data.error ?? "Optimization failed");
      } else {
        setSwapPlan(data);
        setActiveTab("plan");
        addToast("success", `Optimized: ${data.solved_count ?? 0} solved, $${(data.total_cost ?? 0).toLocaleString()}`);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Optimization failed";
      setOptimizeError(msg);
      addToast("error", msg);
    } finally {
      setOptimizing(false);
    }
  }

  // Derived: impacted tails set
  const impactedTails = useMemo(
    () => new Set(swapAlerts.filter((a) => !a.acknowledged).map((a) => a.tail_number)),
    [swapAlerts],
  );

  function shiftWeek(delta: number) {
    setSelectedWed((prev) => {
      const next = new Date(prev);
      next.setDate(prev.getDate() + delta * 7);
      return next;
    });
  }

  return (
    <div className="space-y-4">
      {/* Header + Week Selector + Stepper */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-6">
          <div>
            <h2 className="text-lg font-bold text-gray-900">Crew Swap Planning</h2>
            <p className="text-sm text-gray-500">
              Wednesday swap day: {selectedWed.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric" })}
            </p>
          </div>
          <WorkflowStepper steps={[
            { label: "Upload", done: !!(uploadResult || swapAssignments) },
            { label: "Routes", done: !!(routeStatus && routeStatus.total_routes > 0) },
            { label: "Optimize", done: !!swapPlan },
            { label: "Save", done: !!savedPlanMeta },
          ]} />
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => shiftWeek(-1)} className="px-3 py-1.5 text-sm font-medium border rounded-lg hover:bg-gray-50">
            Prev Week
          </button>
          <button onClick={() => setSelectedWed(getNextWednesday())} className="px-3 py-1.5 text-sm font-medium border rounded-lg hover:bg-gray-50">
            Next Swap
          </button>
          <button onClick={() => shiftWeek(1)} className="px-3 py-1.5 text-sm font-medium border rounded-lg hover:bg-gray-50">
            Next Week
          </button>
        </div>
      </div>

      {/* Plan Status Hero Banner */}
      {savedPlanMeta && (
        <div className={`rounded-lg border-2 px-5 py-3 flex items-center justify-between ${
          planImpacts.filter(i => !i.resolved).some(i => i.severity === "critical")
            ? "border-red-200 bg-red-50"
            : planImpacts.filter(i => !i.resolved).length > 0
            ? "border-amber-200 bg-amber-50"
            : "border-green-200 bg-green-50"
        }`}>
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2">
              <span className="text-sm font-bold text-gray-800">v{savedPlanMeta.version}</span>
              <span className="text-xs text-gray-500">
                saved {new Date(savedPlanMeta.created_at).toLocaleString(undefined, { weekday: "short", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}
              </span>
            </div>
            {swapPlan && (
              <div className="flex items-center gap-2 text-xs">
                <span className="text-gray-600">${swapPlan.total_cost.toLocaleString()}</span>
                <span className="text-gray-400">|</span>
                <span className="text-gray-600">{swapPlan.solved_count ?? 0} solved</span>
              </div>
            )}
            {planImpacts.filter(i => !i.resolved).length > 0 && (
              <span className="text-xs font-bold text-red-700 px-2 py-0.5 rounded bg-red-100">
                {planImpacts.filter(i => i.severity === "critical" && !i.resolved).length} critical / {planImpacts.filter(i => !i.resolved).length} impacts
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => { checkImpacts(); setActiveTab("impacts"); }}
              disabled={checkingImpacts}
              className="px-3 py-1.5 text-xs font-medium rounded-lg border bg-white hover:bg-gray-50"
            >
              {checkingImpacts ? "Checking..." : "Check Impacts"}
            </button>
            {planImpacts.some(i => i.severity === "critical" && !i.resolved) && (
              <button
                onClick={reoptimizeAffected}
                disabled={optimizing}
                className="px-3 py-1.5 text-xs font-medium rounded-lg bg-red-600 text-white hover:bg-red-700"
              >
                Re-optimize Affected
              </button>
            )}
          </div>
        </div>
      )}

      {/* Tab Bar */}
      <div className="flex border-b">
        {([
          { key: "setup" as const, label: "Setup", badge: null },
          { key: "plan" as const, label: "Plan", badge: swapPlan ? `${swapPlan.rows.length / 4 | 0} tails` : null },
          { key: "impacts" as const, label: "Impacts", badge: alertCount > 0 ? `${alertCount}` : null },
        ]).map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={`px-5 py-2.5 text-sm font-medium border-b-2 transition-colors ${
              activeTab === tab.key
                ? "border-blue-500 text-blue-600"
                : "border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300"
            }`}
          >
            {tab.label}
            {tab.badge && (
              <span className={`ml-1.5 text-[10px] px-1.5 py-0.5 rounded-full ${
                tab.key === "impacts" && alertCount > 0 ? "bg-red-100 text-red-700" : "bg-gray-100 text-gray-600"
              }`}>
                {tab.badge}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* ═══ SETUP TAB ═══ */}
      {activeTab === "setup" && <>

      {/* Crew Roster Section */}
      <div className="rounded-lg border bg-white shadow-sm overflow-hidden">
        <div className="px-4 py-3 bg-gray-50 border-b flex items-center justify-between">
          <h3 className="text-sm font-semibold text-gray-700 uppercase tracking-wider">
            Crew Roster {crewLoaded && `(${crew.length})`}
          </h3>
          <div className="flex items-center gap-2">
            {crew.length > 0 && (
              <button
                onClick={() => setShowRoster(!showRoster)}
                className="px-3 py-1.5 text-xs font-medium border rounded-lg hover:bg-gray-50"
              >
                {showRoster ? "Hide" : "Show"} Roster
              </button>
            )}
            <label className={`px-3 py-1.5 text-xs font-medium border rounded-lg cursor-pointer ${
              uploading ? "bg-gray-100 text-gray-400" : "bg-blue-50 text-blue-700 hover:bg-blue-100 border-blue-200"
            }`}>
              {uploading ? "Uploading..." : "Upload Roster (.xlsx)"}
              <input
                type="file"
                accept=".xlsx,.xls"
                className="hidden"
                disabled={uploading}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) handleUpload(f);
                  e.target.value = "";
                }}
              />
            </label>
          </div>
        </div>

        {uploadResult && (
          <div className="px-4 py-3 bg-green-50 border-b border-green-200 text-sm">
            <span className="text-green-700 font-medium">Roster uploaded: </span>
            <span className="text-green-600">
              {uploadResult.total_parsed} parsed, {uploadResult.unique_crew} unique, {uploadResult.upserted} upserted
            </span>
            {uploadResult.summary && (
              <span className="text-green-500 ml-2 text-xs">
                (On-PIC: {uploadResult.summary.oncoming_pic ?? 0}, On-SIC: {uploadResult.summary.oncoming_sic ?? 0},
                 Off-PIC: {uploadResult.summary.offgoing_pic ?? 0}, Off-SIC: {uploadResult.summary.offgoing_sic ?? 0})
              </span>
            )}
            {uploadResult.swap_assignments && (
              <span className="text-green-500 ml-2 text-xs">
                | {Object.keys(uploadResult.swap_assignments).length} tails
                {uploadResult.oncoming_pool && ` | Pool: ${uploadResult.oncoming_pool.pic.length} PICs, ${uploadResult.oncoming_pool.sic.length} SICs to assign`}
              </span>
            )}
            {uploadResult.errors && uploadResult.errors.length > 0 && (
              <div className="mt-1 text-xs text-red-600">
                Errors: {uploadResult.errors.join("; ")}
              </div>
            )}
          </div>
        )}
        {uploadError && (
          <div className="px-4 py-3 bg-red-50 border-b border-red-200 text-sm text-red-700">
            {uploadError}
          </div>
        )}

        {showRoster && crew.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-left text-xs text-gray-500 uppercase tracking-wider">
                <tr>
                  <th className="px-4 py-2">Name</th>
                  <th className="px-4 py-2">Role</th>
                  <th className="px-4 py-2">Home</th>
                  <th className="px-4 py-2">Aircraft</th>
                  <th className="px-4 py-2">Flags</th>
                  <th className="px-4 py-2">Notes</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {crew.map((c) => (
                  <tr key={c.id} className="hover:bg-gray-50">
                    <td className="px-4 py-2 font-medium text-gray-900">{c.name}</td>
                    <td className="px-4 py-2">
                      <span className={`text-xs px-2 py-0.5 rounded font-medium ${
                        c.role === "PIC" ? "bg-blue-100 text-blue-700" : "bg-purple-100 text-purple-700"
                      }`}>
                        {c.role}
                      </span>
                    </td>
                    <td className="px-4 py-2 font-mono text-xs text-gray-600">
                      {c.home_airports.join(" / ")}
                    </td>
                    <td className="px-4 py-2 text-xs text-gray-600">
                      {c.aircraft_types.map((t) => {
                        const ac = AIRCRAFT_COLORS[t];
                        return (
                          <span key={t} className={`inline-block mr-1 px-1.5 py-0.5 rounded ${
                            ac ? `${ac.bg} ${ac.text}` : "bg-gray-100 text-gray-600"
                          }`}>
                            {ac ? ac.label : t}
                          </span>
                        );
                      })}
                    </td>
                    <td className="px-4 py-2">
                      <div className="flex gap-1">
                        {c.is_checkairman && <span className="text-xs px-1.5 py-0.5 rounded bg-amber-100 text-amber-700">CA</span>}
                        {c.is_skillbridge && <span className="text-xs px-1.5 py-0.5 rounded bg-teal-100 text-teal-700">SB</span>}
                      </div>
                    </td>
                    <td className="px-4 py-2 text-xs text-gray-400 max-w-[200px] truncate">
                      {c.notes ?? "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {!showRoster && crew.length === 0 && crewLoaded && (
          <div className="px-4 py-6 text-center text-sm text-gray-400">
            No crew roster loaded. Upload an Excel file to get started.
          </div>
        )}
      </div>

      {/* Phase 2: Volunteer Review Panel */}
      <div className="rounded-lg border bg-white shadow-sm overflow-hidden">
        <div
          className="px-4 py-3 bg-gray-50 border-b flex items-center justify-between cursor-pointer"
          onClick={() => setShowVolunteers(!showVolunteers)}
        >
          <div className="flex items-center gap-3">
            <h3 className="text-sm font-semibold text-gray-700 uppercase tracking-wider">
              Volunteer Preferences
            </h3>
            {volunteers.length > 0 && (
              <span className="text-[10px] px-2 py-0.5 rounded bg-green-50 text-green-600">
                {volunteers.length} responses
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={(e) => { e.stopPropagation(); parseVolunteers(); }}
              disabled={parsingVolunteers}
              className={`px-3 py-1.5 text-xs font-medium border rounded-lg ${
                parsingVolunteers ? "bg-gray-100 text-gray-400" : "bg-violet-50 text-violet-700 hover:bg-violet-100 border-violet-200"
              }`}
            >
              {parsingVolunteers ? "Parsing..." : "Parse Slack Thread"}
            </button>
            <span className="text-xs text-gray-400">{showVolunteers ? "Hide" : "Show"}</span>
          </div>
        </div>
        {showVolunteers && (
          <div className="overflow-x-auto">
            {volunteers.length > 0 ? (
              <table className="w-full text-sm">
                <thead className="bg-gray-50 text-left text-xs text-gray-500 uppercase tracking-wider">
                  <tr>
                    <th className="px-4 py-2">Name</th>
                    <th className="px-4 py-2">Slack Text</th>
                    <th className="px-4 py-2">Parsed</th>
                    <th className="px-4 py-2">Override</th>
                    <th className="px-4 py-2">Notes</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {volunteers.map((v) => {
                    const prefColors: Record<string, string> = {
                      early: "bg-blue-100 text-blue-700",
                      late: "bg-orange-100 text-orange-700",
                      standby: "bg-gray-100 text-gray-700",
                      early_and_late: "bg-purple-100 text-purple-700",
                      unknown: "bg-red-100 text-red-700",
                    };
                    return (
                      <tr key={v.id} className="hover:bg-gray-50">
                        <td className="px-4 py-2 font-medium text-gray-900">
                          {v.crew_members?.name ?? (
                            <span className="text-amber-600 italic">Unmatched ({v.slack_user_id})</span>
                          )}
                          {v.crew_members?.role && (
                            <span className={`ml-1 text-[10px] px-1 py-0.5 rounded ${
                              v.crew_members.role === "PIC" ? "bg-blue-100 text-blue-700" : "bg-purple-100 text-purple-700"
                            }`}>
                              {v.crew_members.role}
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-2 text-xs text-gray-500 max-w-[200px] truncate">
                          {v.raw_text}
                        </td>
                        <td className="px-4 py-2">
                          <span className={`text-xs px-2 py-0.5 rounded font-medium ${prefColors[v.parsed_preference] ?? "bg-gray-100"}`}>
                            {v.parsed_preference}
                          </span>
                        </td>
                        <td className="px-4 py-2">
                          <select
                            className="text-xs border rounded px-2 py-1"
                            value={volunteerOverrides[v.id] ?? v.parsed_preference}
                            onChange={(e) => overrideVolunteer(v.id, e.target.value)}
                          >
                            <option value="early">Early</option>
                            <option value="late">Late</option>
                            <option value="standby">Standby</option>
                            <option value="early_and_late">Early & Late</option>
                            <option value="unknown">Unknown</option>
                          </select>
                        </td>
                        <td className="px-4 py-2 text-xs text-gray-400 max-w-[150px] truncate">
                          {v.notes ?? "—"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            ) : (
              <div className="px-4 py-6 text-center text-sm text-gray-400">
                No volunteer responses parsed yet. Click &quot;Parse Slack Thread&quot; to load from #pilots.
              </div>
            )}
          </div>
        )}
      </div>

      {/* Phase 3: Swap Points Preview */}
      <div className="rounded-lg border bg-white shadow-sm overflow-hidden">
        <div
          className="px-4 py-3 bg-gray-50 border-b flex items-center justify-between cursor-pointer"
          onClick={() => { setShowSwapPoints(!showSwapPoints); if (!showSwapPoints && swapPoints.length === 0) loadSwapPoints(); }}
        >
          <div className="flex items-center gap-3">
            <h3 className="text-sm font-semibold text-gray-700 uppercase tracking-wider">
              Swap Points
            </h3>
            {swapPoints.length > 0 && (
              <span className="text-[10px] px-2 py-0.5 rounded bg-blue-50 text-blue-600">
                {swapPoints.length - excludedTails.size}/{swapPoints.length} tails
                {excludedTails.size > 0 && ` (${excludedTails.size} excluded)`}
              </span>
            )}
            {/* Phase 4: Alert badge */}
            {alertCount > 0 && (
              <span className="text-[10px] px-2 py-0.5 rounded bg-red-100 text-red-700 font-bold animate-pulse">
                {alertCount} flight change{alertCount > 1 ? "s" : ""}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={(e) => { e.stopPropagation(); loadSwapPoints(); }}
              disabled={loadingSwapPoints}
              className={`px-3 py-1.5 text-xs font-medium border rounded-lg ${
                loadingSwapPoints ? "bg-gray-100 text-gray-400" : "bg-blue-50 text-blue-700 hover:bg-blue-100 border-blue-200"
              }`}
            >
              {loadingSwapPoints ? "Loading..." : "Refresh"}
            </button>
            <span className="text-xs text-gray-400">{showSwapPoints ? "Hide" : "Show"}</span>
          </div>
        </div>
        {showSwapPoints && (
          <div className="divide-y">
            {/* Flight change alerts */}
            {swapAlerts.filter((a) => !a.acknowledged).length > 0 && (
              <div className="px-4 py-3 bg-red-50 border-b space-y-1">
                <div className="text-xs font-semibold text-red-700 mb-1">Flight Changes Detected:</div>
                {swapAlerts.filter((a) => !a.acknowledged).map((a) => (
                  <div key={a.id} className="flex items-center justify-between text-xs">
                    <span className="text-red-600">
                      <span className="font-mono font-bold">{a.tail_number}</span>: {a.change_type}
                      {a.new_value && typeof a.new_value === "object" && " — " + JSON.stringify(a.new_value).slice(0, 80)}
                    </span>
                    <button
                      onClick={() => acknowledgeAlert(a.id)}
                      className="px-2 py-0.5 text-[10px] rounded bg-red-100 text-red-700 hover:bg-red-200"
                    >
                      Ack
                    </button>
                  </div>
                ))}
              </div>
            )}

            {/* Swap points per tail */}
            {swapPoints.length > 0 ? (
              <div className="space-y-2 p-3">
                {swapPoints.map((t) => (
                  <div key={t.tail} className={`rounded border overflow-hidden ${excludedTails.has(t.tail) ? "opacity-40" : "bg-white"}`}>
                    <div className="px-3 py-2 bg-gray-50 border-b flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => setExcludedTails((prev) => {
                            const next = new Set(prev);
                            if (next.has(t.tail)) next.delete(t.tail); else next.add(t.tail);
                            return next;
                          })}
                          className={`w-4 h-4 rounded border flex items-center justify-center text-[10px] ${excludedTails.has(t.tail) ? "bg-red-100 border-red-300 text-red-600" : "bg-white border-gray-300 text-transparent hover:border-gray-400"}`}
                          title={excludedTails.has(t.tail) ? "Click to include" : "Click to exclude"}
                        >
                          {excludedTails.has(t.tail) ? "X" : ""}
                        </button>
                        <span className={`font-mono font-bold text-sm ${excludedTails.has(t.tail) ? "text-gray-400 line-through" : "text-gray-900"}`}>{t.tail}</span>
                      </div>
                      <div className="flex items-center gap-2 text-xs text-gray-500">
                        {t.recent_crew ? (
                          <span className="px-1.5 py-0.5 rounded bg-green-100 text-green-700 text-[10px]" title={`PIC: ${t.recent_crew.pic.join(", ") || "—"} | SIC: ${t.recent_crew.sic.join(", ") || "—"}`}>
                            Crewed
                          </span>
                        ) : (
                          <span className="px-1.5 py-0.5 rounded bg-red-100 text-red-600 text-[10px]">
                            No crew (MX?)
                          </span>
                        )}
                        {t.wednesday_legs.length > 0
                          ? <span>{t.wednesday_legs.length} legs</span>
                          : <span className="text-amber-600">Idle at {t.overnight_airport ?? "?"}</span>
                        }
                      </div>
                    </div>
                    {/* Wednesday legs */}
                    {t.wednesday_legs.length > 0 && (
                      <div className="px-3 py-1.5 border-b bg-gray-50/50">
                        {t.wednesday_legs.map((leg, i) => (
                          <span key={i} className="text-xs text-gray-500">
                            {i > 0 && " → "}
                            <span className="font-mono">{leg.dep}</span>
                            <span className="text-gray-300 mx-0.5">→</span>
                            <span className="font-mono">{leg.arr}</span>
                            <span className="text-gray-400 ml-0.5">({fmtShortTime(leg.dep_time)})</span>
                          </span>
                        ))}
                      </div>
                    )}
                    {/* Swap points */}
                    <div className="px-3 py-2 flex flex-wrap gap-1.5">
                      {t.swap_points.map((sp, i) => {
                        const posColors: Record<string, string> = {
                          before_live: "bg-green-100 text-green-700",
                          after_live: "bg-blue-100 text-blue-700",
                          between_legs: "bg-amber-100 text-amber-700",
                          idle: "bg-gray-100 text-gray-600",
                        };
                        return (
                          <span
                            key={i}
                            className={`text-[10px] px-2 py-1 rounded font-mono ${posColors[sp.position] ?? "bg-gray-100"}`}
                            title={`${sp.position} @ ${fmtTime(sp.time)}`}
                          >
                            {sp.icao.replace(/^K/, "")} ({sp.position.replace("_", " ")})
                          </span>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="px-4 py-6 text-center text-sm text-gray-400">
                {loadingSwapPoints ? "Loading swap points..." : "Click Refresh to compute swap points from Wednesday legs."}
              </div>
            )}
          </div>
        )}
      </div>

      </>}

      {/* ═══ PLAN TAB ═══ */}
      {activeTab === "plan" && <>

      {/* Swap Optimizer */}
      <div className="rounded-lg border bg-white shadow-sm overflow-hidden">
        {/* Sticky toolbar */}
        <div className="sticky top-0 z-20 bg-white/95 backdrop-blur-sm border-b shadow-sm px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <h3 className="text-sm font-semibold text-gray-700 uppercase tracking-wider">
              Swap Optimizer
            </h3>
            {swapAssignments && (
              <span className="text-[10px] px-2 py-0.5 rounded bg-blue-50 text-blue-600">
                {Object.keys(swapAssignments).length} tails
                {oncomingPool && ` | Pool: ${oncomingPool.pic.length} PICs, ${oncomingPool.sic.length} SICs`}
                {" | "}{Object.values(swapAssignments).filter(a => a.offgoing_pic || a.offgoing_sic).length} offgoing
                {rotationSource === "auto_detect" && " (auto-detected)"}
              </span>
            )}
            {!swapAssignments && (
              <span className="text-[10px] px-2 py-0.5 rounded bg-amber-50 text-amber-600">
                No swap assignments — upload Excel or auto-detect
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {routeStatus && routeStatus.total_routes > 0 && (
              <span className={`text-[10px] px-2 py-0.5 rounded ${
                routeStatus.is_stale ? "bg-amber-50 text-amber-600" : "bg-green-50 text-green-600"
              }`}>
                {routeStatus.total_routes} routes cached
                {routeStatus.last_computed && ` (${new Date(routeStatus.last_computed).toLocaleString(undefined, { hour: "2-digit", minute: "2-digit" })})`}
                {routeStatus.is_stale && " — stale"}
              </span>
            )}
            {/* Strategy toggle */}
            <div className="flex rounded-lg border overflow-hidden">
              <button
                onClick={() => setStrategy("offgoing_first")}
                className={`px-2.5 py-1.5 text-[10px] font-medium ${strategy === "offgoing_first" ? "bg-emerald-50 text-emerald-700" : "bg-white text-gray-500 hover:bg-gray-50"}`}
                title="Solve offgoing constraints first, derive oncoming deadlines"
              >
                Offgoing First
              </button>
              <button
                onClick={() => setStrategy("oncoming_first")}
                className={`px-2.5 py-1.5 text-[10px] font-medium border-l ${strategy === "oncoming_first" ? "bg-emerald-50 text-emerald-700" : "bg-white text-gray-500 hover:bg-gray-50"}`}
                title="Current algorithm (oncoming-first assignment)"
              >
                Legacy
              </button>
            </div>
            <button
              onClick={detectRotation}
              disabled={detectingRotation || optimizing}
              className={`px-3 py-1.5 text-xs font-medium border rounded-lg ${
                detectingRotation ? "bg-gray-100 text-gray-400" : "bg-green-50 text-green-700 hover:bg-green-100 border-green-200"
              }`}
            >
              {detectingRotation ? "Detecting..." : "Auto-Detect Rotation"}
            </button>
            <button
              onClick={computeRoutes}
              disabled={computingRoutes || optimizing}
              className={`px-3 py-1.5 text-xs font-medium border rounded-lg ${
                computingRoutes ? "bg-gray-100 text-gray-400" : "bg-amber-50 text-amber-700 hover:bg-amber-100 border-amber-200"
              }`}
            >
              {computingRoutes ? "Computing Routes..." : "Refresh Routes"}
            </button>
            <button
              onClick={() => runOptimizer()}
              disabled={optimizing || computingRoutes}
              className={`px-3 py-1.5 text-xs font-medium border rounded-lg ${
                optimizing ? "bg-gray-100 text-gray-400" : "bg-blue-50 text-blue-700 hover:bg-blue-100 border-blue-200"
              }`}
            >
              {optimizing ? "Optimizing..." : "Optimize"}
            </button>
            {swapPlan && (
              <>
                <div className="flex rounded-lg border overflow-hidden">
                  <button
                    onClick={() => setSwapView("aircraft")}
                    className={`px-2.5 py-1.5 text-xs font-medium ${swapView === "aircraft" ? "bg-blue-50 text-blue-700" : "bg-white text-gray-500 hover:bg-gray-50"}`}
                  >
                    By Aircraft
                  </button>
                  <button
                    onClick={() => setSwapView("role")}
                    className={`px-2.5 py-1.5 text-xs font-medium border-l ${swapView === "role" ? "bg-blue-50 text-blue-700" : "bg-white text-gray-500 hover:bg-gray-50"}`}
                  >
                    By Role
                  </button>
                </div>
                <button
                  onClick={exportToImage}
                  disabled={exporting}
                  className="px-3 py-1.5 text-xs font-medium border rounded-lg bg-gray-50 text-gray-700 hover:bg-gray-100"
                >
                  {exporting ? "Exporting..." : "Export PNG"}
                </button>
                <button
                  onClick={exportToExcel}
                  className="px-3 py-1.5 text-xs font-medium border rounded-lg bg-gray-50 text-gray-700 hover:bg-gray-100"
                >
                  Export Excel
                </button>
                <button
                  onClick={savePlan}
                  disabled={savingPlan}
                  className={`px-3 py-1.5 text-xs font-medium border rounded-lg ${
                    savingPlan ? "bg-gray-100 text-gray-400" : "bg-emerald-50 text-emerald-700 hover:bg-emerald-100 border-emerald-200"
                  }`}
                >
                  {savingPlan ? "Saving..." : savedPlanMeta ? `Update Plan (v${savedPlanMeta.version + 1})` : "Save Plan"}
                </button>
              </>
            )}
          </div>
        </div>

        {optimizeError && (
          <div className="px-4 py-3 bg-red-50 border-b border-red-200 text-sm text-red-700">
            {optimizeError}
          </div>
        )}

        {swapPlan && (
          <div ref={swapPlanRef}>
            {/* Summary bar */}
            <div className="px-4 py-2 bg-green-50 border-b text-sm text-green-700 flex items-center justify-between">
              <div className="flex items-center gap-4">
                <span className="font-medium">
                  {swapPlan.rows.length} crew planned for {swapPlan.swap_date}
                </span>
                {swapPlan.total_cost > 0 && (
                  <span className="text-green-600 text-xs font-medium">
                    Est. total: ${swapPlan.total_cost.toLocaleString()}
                  </span>
                )}
                {swapPlan.plan_score > 0 && (
                  <span className={`text-xs font-medium px-1.5 py-0.5 rounded ${
                    swapPlan.plan_score >= 70 ? "bg-green-100 text-green-700"
                    : swapPlan.plan_score >= 50 ? "bg-yellow-100 text-yellow-700"
                    : "bg-red-100 text-red-700"
                  }`}>
                    Score: {swapPlan.plan_score}
                  </span>
                )}
                {(swapPlan.unsolved_count ?? 0) > 0 && (
                  <span className="text-xs font-medium px-1.5 py-0.5 rounded bg-orange-100 text-orange-700">
                    {swapPlan.unsolved_count} unsolved
                  </span>
                )}
                {swapPlan.routes_used > 0 && (
                  <span className="text-green-500 text-xs">
                    ({swapPlan.routes_used} cached routes used)
                  </span>
                )}
                {swapPlan.warnings.length > 0 && (
                  <span className="text-amber-600 text-xs">
                    {swapPlan.warnings.length} warning(s)
                  </span>
                )}
              </div>
              <div className="flex items-center gap-3">
                {savedPlanMeta && (
                  <span className="text-xs text-green-600">
                    Saved v{savedPlanMeta.version} — {new Date(savedPlanMeta.created_at).toLocaleString(undefined, { weekday: "short", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                  </span>
                )}
                {planImpacts.filter(i => !i.resolved).length > 0 && (
                  <span className="text-xs font-bold text-red-700 px-2 py-0.5 rounded bg-red-100">
                    {planImpacts.filter(i => i.severity === "critical").length} critical / {planImpacts.filter(i => !i.resolved).length} impacts
                  </span>
                )}
              </div>
            </div>

            {/* Impact action bar */}
            {planImpacts.filter(i => !i.resolved).length > 0 && (
              <div className="px-4 py-2 bg-red-50 border-b flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <span className="text-xs font-semibold text-red-700">
                    Schedule changes detected since last save
                  </span>
                  <button
                    onClick={checkImpacts}
                    disabled={checkingImpacts}
                    className="px-2 py-1 text-[10px] font-medium rounded bg-red-100 text-red-700 hover:bg-red-200"
                  >
                    {checkingImpacts ? "Checking..." : "Refresh Impacts"}
                  </button>
                </div>
                {planImpacts.some(i => i.severity === "critical" && !i.resolved) && (
                  <button
                    onClick={reoptimizeAffected}
                    disabled={optimizing}
                    className={`px-3 py-1.5 text-xs font-medium rounded-lg ${
                      optimizing ? "bg-gray-100 text-gray-400" : "bg-red-600 text-white hover:bg-red-700"
                    }`}
                  >
                    {optimizing ? "Re-optimizing..." : `Re-optimize Affected (${new Set(planImpacts.filter(i => !i.resolved).map(i => i.tail_number)).size} tails)`}
                  </button>
                )}
              </div>
            )}

            {/* Two-pass cost comparison */}
            {swapPlan.two_pass && (
              <div className="px-4 py-2 bg-blue-50 border-b">
                <div className="text-xs font-medium text-blue-800 mb-1">Two-Pass Optimizer</div>
                <div className="flex items-center gap-6 text-xs">
                  <span className="text-blue-700">
                    Pass 1: {swapPlan.two_pass.pass1_solved}/{swapPlan.two_pass.pass1_solved + swapPlan.two_pass.pass1_unsolved} tails, ${swapPlan.two_pass.pass1_cost.toLocaleString()}
                  </span>
                  {swapPlan.two_pass.pass2_solved > 0 && (
                    <span className="text-purple-700">
                      Pass 2: +{swapPlan.two_pass.pass2_solved} tails via {swapPlan.two_pass.pass2_volunteers_used.length} volunteer(s), +${swapPlan.two_pass.pass2_bonus_cost.toLocaleString()} bonus
                    </span>
                  )}
                  <span className="font-medium text-blue-900">
                    Total: ${swapPlan.two_pass.total_cost.toLocaleString()}
                  </span>
                </div>
                {swapPlan.two_pass.pass2_volunteers_used.length > 0 && (
                  <div className="mt-1 flex flex-wrap gap-2">
                    {swapPlan.two_pass.pass2_volunteers_used.map((v, i) => (
                      <span key={i} className="inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded bg-purple-100 text-purple-700">
                        {v.name} ({v.role}) — {v.type} on {v.tail}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Global warnings */}
            {swapPlan.warnings.length > 0 && (
              <div className="px-4 py-2 bg-amber-50 border-b space-y-1">
                {swapPlan.warnings.map((w, i) => (
                  <div key={i} className="text-xs text-amber-700">{w}</div>
                ))}
              </div>
            )}

            {/* Standby crew (unassigned) */}
            {swapPlan.crew_assignment?.standby && (
              (swapPlan.crew_assignment.standby.pic.length > 0 || swapPlan.crew_assignment.standby.sic.length > 0) && (
                <div className="px-4 py-2 bg-gray-50 border-b text-xs space-y-1">
                  <span className="font-semibold text-gray-600">Standby (unassigned): </span>
                  {swapPlan.crew_assignment.standby.pic.length > 0 && (
                    <span className="text-gray-500">
                      PICs: {swapPlan.crew_assignment.standby.pic.join(", ")}
                    </span>
                  )}
                  {swapPlan.crew_assignment.standby.pic.length > 0 && swapPlan.crew_assignment.standby.sic.length > 0 && (
                    <span className="text-gray-400 mx-1">|</span>
                  )}
                  {swapPlan.crew_assignment.standby.sic.length > 0 && (
                    <span className="text-gray-500">
                      SICs: {swapPlan.crew_assignment.standby.sic.join(", ")}
                    </span>
                  )}
                </div>
              )
            )}

            {/* Plan history (collapsible) */}
            {savedPlanMeta && (
              <div className="border-b">
                <button
                  onClick={() => { setShowHistory(!showHistory); if (!showHistory) loadPlanHistory(); }}
                  className="w-full px-4 py-1.5 text-[10px] text-gray-500 hover:bg-gray-50 flex items-center justify-between"
                >
                  <span>Plan History</span>
                  <span>{showHistory ? "Hide" : "Show"}</span>
                </button>
                {showHistory && planVersions.length > 0 && (
                  <div className="px-4 pb-2 space-y-1">
                    {planVersions.map((v) => (
                      <div key={v.id} className={`flex items-center justify-between text-xs py-1 px-2 rounded ${v.status === "active" ? "bg-green-50" : "bg-gray-50"}`}>
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-gray-700">v{v.version}</span>
                          <span className={`px-1 py-0.5 rounded text-[9px] ${v.status === "active" ? "bg-green-100 text-green-700" : "bg-gray-200 text-gray-500"}`}>
                            {v.status}
                          </span>
                          <span className="text-gray-500">
                            {new Date(v.created_at).toLocaleString(undefined, { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                          </span>
                        </div>
                        <div className="flex items-center gap-2 text-gray-500">
                          <span>${(v.total_cost ?? 0).toLocaleString()}</span>
                          <span>{v.solved_count ?? 0}/{(v.solved_count ?? 0) + (v.unsolved_count ?? 0)} solved</span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* The swap sheet */}
            {/* Tail status grid */}
            {swapView === "aircraft" && (
              <TailStatusGrid
                rows={swapPlan.rows}
                impactedTails={impactedTails}
                onTileClick={(tail) => {
                  const el = document.getElementById(`tail-${tail}`);
                  if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
                }}
              />
            )}

            <SwapSheet rows={swapPlan.rows} view={swapView} impacts={planImpacts} impactedTails={impactedTails} />
          </div>
        )}

        {!swapPlan && !optimizeError && (
          <div className="px-4 py-6 text-center text-sm text-gray-400">
            {loadingPlan ? "Loading saved plan..." : (
              routeStatus && routeStatus.total_routes > 0
                ? `${routeStatus.total_routes} routes cached for ${routeStatus.crew_count} crew. Click Optimize to run.`
                : `Upload roster then click Refresh Routes to pre-compute routes for ${selectedWed.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`
            )}
          </div>
        )}
      </div>

      {/* Aircraft Schedule (collapsible) */}
      <div className="rounded-lg border bg-white shadow-sm overflow-hidden">
        <div
          className="px-4 py-3 bg-gray-50 border-b flex items-center justify-between cursor-pointer"
          onClick={() => setShowSchedule(!showSchedule)}
        >
          <h3 className="text-sm font-semibold text-gray-700 uppercase tracking-wider">
            Aircraft Schedule ({tailSchedules.length} tails)
          </h3>
          <span className="text-xs text-gray-400">
            {showSchedule ? "Hide" : "Show"}
          </span>
        </div>

        {showSchedule && (
          <div className="space-y-3 p-3">
            {tailSchedules.map((ts) => (
              <div key={ts.tail} className="rounded-lg border bg-white overflow-hidden">
                <div className="px-4 py-2.5 bg-gray-50 border-b flex items-center justify-between">
                  <span className="font-mono font-bold text-gray-900">{ts.tail}</span>
                  <span className="text-xs text-gray-400">
                    {ts.wedFlights.length} legs on Wed
                    {ts.wedFlights.length === 0 && ts.lastKnown && (
                      <span className="ml-2 text-amber-600">Last: {ts.lastKnown}</span>
                    )}
                  </span>
                </div>
                {ts.wedFlights.length > 0 ? (
                  <div className="divide-y">
                    {ts.wedFlights.map((f) => {
                      const typeColor = FLIGHT_TYPE_COLORS[f.flight_type ?? ""] ?? "bg-gray-100 text-gray-600";
                      return (
                        <div key={f.id} className="px-4 py-2 flex items-center gap-4 text-sm">
                          <span className={`px-2 py-0.5 rounded text-xs font-medium ${typeColor}`}>
                            {f.flight_type ?? "—"}
                          </span>
                          <span className="font-mono text-gray-700">
                            {f.departure_icao} → {f.arrival_icao}
                          </span>
                          <span className="text-gray-500">{fmtTime(f.scheduled_departure)}</span>
                          <span className="text-gray-400">→</span>
                          <span className="text-gray-500">{fmtTime(f.scheduled_arrival)}</span>
                          {f.pic && (
                            <span className="text-xs text-gray-400 ml-auto">
                              {f.pic}{f.sic ? ` / ${f.sic}` : ""}
                            </span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <div className="px-4 py-3 text-sm text-gray-400 italic">
                    No flights — aircraft at {ts.lastKnown ?? "unknown"}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      </>}

      {/* ═══ IMPACTS TAB ═══ */}
      {activeTab === "impacts" && <>

      <div className="rounded-lg border bg-white shadow-sm overflow-hidden">
        <div className="px-4 py-3 bg-gray-50 border-b flex items-center justify-between">
          <h3 className="text-sm font-semibold text-gray-700 uppercase tracking-wider">
            Flight Change Alerts
            {alertCount > 0 && (
              <span className="ml-2 text-[10px] px-2 py-0.5 rounded bg-red-100 text-red-700 font-bold">
                {alertCount} unacknowledged
              </span>
            )}
          </h3>
          <button
            onClick={() => { checkImpacts(); }}
            disabled={checkingImpacts || !swapPlan}
            className={`px-3 py-1.5 text-xs font-medium border rounded-lg ${
              !swapPlan ? "bg-gray-100 text-gray-400 cursor-not-allowed"
              : checkingImpacts ? "bg-gray-100 text-gray-400"
              : "bg-blue-50 text-blue-700 hover:bg-blue-100 border-blue-200"
            }`}
            title={!swapPlan ? "Run optimizer first" : undefined}
          >
            {checkingImpacts ? "Analyzing..." : !swapPlan ? "Run optimizer first" : "Analyze Impact on Plan"}
          </button>
        </div>

        {/* Unacknowledged alerts */}
        {swapAlerts.filter((a) => !a.acknowledged).length > 0 ? (
          <div className="divide-y">
            {swapAlerts.filter((a) => !a.acknowledged).map((a) => (
              <div key={a.id} className="px-4 py-3 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <span className={`text-[10px] px-2 py-0.5 rounded font-bold ${
                    a.change_type === "cancelled" ? "bg-red-100 text-red-700"
                    : a.change_type === "time_change" ? "bg-amber-100 text-amber-700"
                    : a.change_type === "airport_change" ? "bg-red-100 text-red-700"
                    : "bg-blue-100 text-blue-700"
                  }`}>
                    {a.change_type.replace("_", " ")}
                  </span>
                  <span className="font-mono font-bold text-sm text-gray-900">{a.tail_number}</span>
                  <span className="text-xs text-gray-500">
                    {a.new_value && typeof a.new_value === "object" && JSON.stringify(a.new_value).slice(0, 100)}
                  </span>
                  <span className="text-[10px] text-gray-400">
                    {new Date(a.detected_at).toLocaleString(undefined, { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                  </span>
                </div>
                <button
                  onClick={() => acknowledgeAlert(a.id)}
                  className="px-2.5 py-1 text-xs rounded bg-gray-100 text-gray-600 hover:bg-gray-200"
                >
                  Acknowledge
                </button>
              </div>
            ))}
          </div>
        ) : (
          <div className="px-4 py-8 text-center text-sm text-gray-400">
            No unacknowledged flight changes for this swap date.
          </div>
        )}
      </div>

      {/* Plan impacts */}
      {planImpacts.filter(i => !i.resolved).length > 0 && (
        <div className="rounded-lg border bg-white shadow-sm overflow-hidden">
          <div className="px-4 py-3 bg-red-50 border-b">
            <h3 className="text-sm font-semibold text-red-700 uppercase tracking-wider">
              Plan Impacts ({planImpacts.filter(i => !i.resolved).length})
            </h3>
          </div>
          <div className="divide-y">
            {planImpacts.filter(i => !i.resolved).map((imp) => (
              <div key={imp.id} className={`px-4 py-3 ${imp.severity === "critical" ? "bg-red-50/50" : "bg-amber-50/50"}`}>
                <div className="flex items-center gap-3 mb-1">
                  <span className={`text-[10px] px-2 py-0.5 rounded font-bold ${
                    imp.severity === "critical" ? "bg-red-100 text-red-700" : "bg-amber-100 text-amber-700"
                  }`}>
                    {imp.severity}
                  </span>
                  <span className="font-mono font-bold text-sm text-gray-900">{imp.tail_number}</span>
                </div>
                <div className="space-y-0.5 ml-16">
                  {imp.affected_crew.map((c, ci) => (
                    <div key={ci} className="text-xs text-gray-700">
                      <span className="font-medium">{c.name}</span>
                      <span className="text-gray-400 mx-1">({c.role} {c.direction})</span>
                      <span>{c.detail}</span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      </>}

      {/* Toast notifications */}
      <ToastContainer toasts={toasts} onDismiss={removeToast} />
    </div>
  );
}
