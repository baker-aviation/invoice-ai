"use client";

import { useEffect, useMemo, useState, useCallback, useRef } from "react";
import { toPng } from "html-to-image";
import * as XLSX from "xlsx";
import type { Flight } from "@/lib/opsApi";
import { getAirportTimezone } from "@/lib/airportTimezones";
import FlightPickerModal, { type FlightPickerSelection } from "./FlightPickerModal";
import SheetValidationPanel from "./crew-swap/SheetValidationPanel";
import NameResolutionPanel from "./crew-swap/NameResolutionPanel";
import NameAliasAdmin from "./crew-swap/NameAliasAdmin";
import DaySelector, { VolunteerBadge } from "./crew-swap/DaySelector";
import DayResultsTabs from "./crew-swap/DayResultsTabs";
import PairConstraintEditor from "./crew-swap/PairConstraintEditor";
import type { ValidationResult } from "@/lib/swapValidation";
import { type SwapDay, dayToDate, isCrewAvailableForDay, sortDays, DAY_LABELS } from "@/lib/swapDays";

// ─── Types ──────────────────────────────────────────────────────────────────

type CrewMember = {
  id: string;
  name: string;
  role: "PIC" | "SIC";
  home_airports: string[];
  aircraft_types: string[];
  is_checkairman: boolean;
  checkairman_types: string[];
  is_skillbridge: boolean;
  grade: number;
  restrictions: Record<string, boolean>;
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

/** Pre-optimizer constraints set by coordinator */
type SwapConstraint =
  | { type: "force_tail"; crew_name: string; tail: string; day?: string; reason?: string }
  | { type: "force_pair"; crew_a: string; crew_b: string; day?: string; reason?: string }
  | { type: "force_fleet"; crew_name: string; aircraft_type: string; day?: string; reason?: string };

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

type ImpactSuggestion = {
  type: string;
  description: string;
  estimated_cost_delta: number | null;
  crew_affected_count: number;
  auto_applicable: boolean;
};

type PlanImpact = {
  id: string;
  alert_id: string;
  tail_number: string;
  affected_crew: { name: string; role: string; direction: string; detail: string }[];
  severity: "critical" | "warning" | "info";
  resolved: boolean;
  suggestions?: ImpactSuggestion[] | null;
  resolution_type?: string | null;
  resolution_note?: string | null;
  resolved_by?: string | null;
  resolved_at?: string | null;
  detected_at?: string | null;
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
  checkairman_types: string[];
  is_skillbridge: boolean;
  grade: number;
  volunteer_status: string | null;
  notes: string | null;
  warnings: string[];
  alt_flights: { flight_number: string; dep: string; arr: string; price: string }[];
  backup_flight: string | null;
  score: number;
  /** false = tentative/standby, true = confirmed/book it */
  confirmed?: boolean;
  /** Set when crew is positioning the day before the swap */
  is_day_before?: boolean;
  /** Crew rest hours between arrival and next-day duty start */
  crew_rest_hours?: number;
};

type TwoPassStats = {
  pass1_solved: number;
  pass1_unsolved: number;
  pass1_cost: number;
  pass2_solved: number;
  pass2_volunteers_used: { name: string; role: "PIC" | "SIC"; tail: string; type: "early" | "late" }[];
  pass2_bonus_cost: number;
  pass3_solved?: number;
  pass3_standby_used?: { name: string; role: "PIC" | "SIC"; tail: string }[];
  pass3_relaxation?: boolean;
  feedback_loop_solved?: number;
  feedback_loop_iterations?: number;
  feedback_loop_swaps?: { crew_moved: string; role: "PIC" | "SIC"; from_tail: string; to_tail: string; backfilled_by: string; new_swap_point?: string }[];
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
  diagnostics?: {
    unsolved_tails: { tail: string; role: string; reason: string; type_mismatch_count: number; no_route_count: number; intl_restricted_count: number; route_score_zero_count: number; total_crew_checked: number }[];
    unsolved_crew: { name: string; role: string; tails_checked: number; type_mismatch_tails: string[]; no_route_tails: string[]; intl_restricted_tails: string[]; route_score_zero_tails: string[] }[];
    type_mismatch_blockers: { tail: string; role: string; tail_type: string; crew_types_available: string[] }[];
  };
};

type CrewInfoData = {
  bad_pairings: { pic: string; sic: string; severity: string; notes: string }[];
  checkairmen: { name: string; rotation: string; citation_x: boolean; challenger: boolean }[];
  recurrency_299: { name: string; month: string; needs_299: boolean }[];
  pic_swap_table: { old_pic: string | null; new_pic: string | null; tail: string | null }[];
  crewing_checklist: { assignees: { name: string; tasks: Record<string, boolean | string> }[] } | null;
  calendar_weeks: { date_range: string; rotation: string; pic: { citation_x: string[]; challenger: string[]; dual: string[] }; sic: { citation_x: string[]; challenger: string[]; dual: string[] } }[];
  target_week_crew: { date_range: string; rotation: string; pic: { citation_x: string[]; challenger: string[]; dual: string[] }; sic: { citation_x: string[]; challenger: string[]; dual: string[] } } | null;
  different_airports?: { name: string; date: string | null; coming_from: string | null; going_to: string | null; notes: string | null }[];
  roster?: { total: number; active: number; terminated: number; skillbridge: number; part_time: number };
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
  const tails = sortTailEntries(Array.from(byTail.entries()), (_tail, rows2) => rows2[0]?.aircraft_type ?? "");

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
            {(() => {
              const solved = tailRows.filter(r => r.travel_type !== "none");
              const confirmed = solved.filter(r => r.confirmed).length;
              if (solved.length === 0) return null;
              return (
                <div className={`text-[8px] mt-0.5 font-medium ${confirmed === solved.length ? "text-green-700" : "text-yellow-700"}`}>
                  {confirmed}/{solved.length}
                </div>
              );
            })()}
          </button>
        );
      })}
    </div>
  );
}

// ─── Helpers ────────────────────────────────────────────────────────────────

type SwapAssignmentShape = { oncoming_pic: string | null; oncoming_sic: string | null; offgoing_pic: string | null; offgoing_sic: string | null };

function buildSummaryFromAssignments(
  assignments: Record<string, SwapAssignmentShape> | null | undefined,
): Record<string, number> {
  if (!assignments) return {};
  const vals = Object.values(assignments);
  return {
    oncoming_pic: vals.filter((a) => a.oncoming_pic).length,
    oncoming_sic: vals.filter((a) => a.oncoming_sic).length,
    offgoing_pic: vals.filter((a) => a.offgoing_pic).length,
    offgoing_sic: vals.filter((a) => a.offgoing_sic).length,
  };
}

function getNextWednesday(): Date {
  const now = new Date();
  const day = now.getDay();
  const daysUntilWed = (3 - day + 7) % 7 || 7;
  const wed = new Date(now);
  wed.setDate(now.getDate() + daysUntilWed);
  wed.setHours(0, 0, 0, 0);
  return wed;
}

function fmtTime(iso: string | null, airportIcao?: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  const tz = airportIcao ? getAirportTimezone(airportIcao) : null;
  const opts: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit", hour12: false };
  if (tz) opts.timeZone = tz;
  const time = d.toLocaleTimeString("en-GB", opts);
  if (tz) {
    const tzAbbr = d.toLocaleTimeString("en-US", { timeZone: tz, timeZoneName: "short" }).split(" ").pop() ?? "";
    return `${time} ${tzAbbr}`;
  }
  return time;
}

function fmtShortTime(iso: string | null, airportIcao?: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  const tz = airportIcao ? getAirportTimezone(airportIcao) : null;
  const opts: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit", hour12: false };
  if (tz) opts.timeZone = tz;
  const time = d.toLocaleTimeString("en-GB", opts);
  if (tz) {
    const tzAbbr = d.toLocaleTimeString("en-US", { timeZone: tz, timeZoneName: "short" }).split(" ").pop() ?? "";
    return `${time} ${tzAbbr}`;
  }
  return time;
}

/**
 * Sort tails alphabetically by tail number to match JetInsight order.
 */
function sortTailEntries<T>(
  entries: [string, T][],
  _getType: (tail: string, data: T) => string,
): [string, T][] {
  return entries.sort(([a], [b]) => a.localeCompare(b));
}

const AIRCRAFT_COLORS: Record<string, { bg: string; text: string; label: string }> = {
  citation_x: { bg: "bg-green-100", text: "text-green-700", label: "Cit X" },
  challenger: { bg: "bg-yellow-100", text: "text-yellow-700", label: "CL" },
  dual: { bg: "bg-purple-100", text: "text-purple-700", label: "Dual" },
  // ICS source codes (from ics_sources.aircraft_type)
  C750: { bg: "bg-green-100", text: "text-green-700", label: "Cit X" },
  CL30: { bg: "bg-yellow-100", text: "text-yellow-700", label: "CL" },
};

const FLIGHT_TYPE_COLORS: Record<string, string> = {
  Charter: "bg-blue-100 text-blue-700",
  Revenue: "bg-green-100 text-green-700",
  Positioning: "bg-amber-100 text-amber-700",
  Maintenance: "bg-purple-100 text-purple-700",
  Owner: "bg-emerald-100 text-emerald-700",
  "Ferry/Mx": "bg-gray-100 text-gray-700",
};

// FBO → Commercial airport reference for this week's swap locations
const FBO_COMMERCIAL_MAP: Record<string, { airports: string[]; preferred: string }> = {
  TEB: { airports: ["EWR", "LGA", "JFK"], preferred: "EWR" },
  OPF: { airports: ["MIA", "FLL"], preferred: "MIA" },
  VNY: { airports: ["BUR", "LAX"], preferred: "BUR" },
  BFI: { airports: ["SEA"], preferred: "SEA" },
  OGD: { airports: ["SLC"], preferred: "SLC" },
  CGF: { airports: ["CLE"], preferred: "CLE" },
  FXE: { airports: ["FLL", "MIA", "PBI"], preferred: "FLL" },
  BED: { airports: ["BOS"], preferred: "BOS" },
  HPN: { airports: ["JFK", "LGA", "EWR"], preferred: "JFK" },
  FTW: { airports: ["DFW", "DAL"], preferred: "DFW" },
  HEF: { airports: ["IAD", "DCA"], preferred: "IAD" },
  SUA: { airports: ["PBI", "FLL"], preferred: "PBI" },
  NUQ: { airports: ["SJC", "OAK", "SFO"], preferred: "SJC" },
  OSU: { airports: ["CMH"], preferred: "CMH" },
  IWA: { airports: ["PHX"], preferred: "PHX" },
  TRM: { airports: ["PSP"], preferred: "PSP" },
  UDD: { airports: ["PSP"], preferred: "PSP" },
  JQF: { airports: ["CLT"], preferred: "CLT" },
  HKY: { airports: ["CLT"], preferred: "CLT" },
  BUY: { airports: ["GSO", "RDU"], preferred: "GSO" },
  TTN: { airports: ["PHL", "EWR"], preferred: "PHL" },
  MMU: { airports: ["EWR", "LGA"], preferred: "EWR" },
  SDL: { airports: ["PHX"], preferred: "PHX" },
  APF: { airports: ["RSW"], preferred: "RSW" },
  RUE: { airports: ["XNA"], preferred: "XNA" },
};

// ─── Assign View: drag-and-drop crew assignment ─────────────────────────────

function AssignView({ rows, onAssignCrew, onRecomputeTail, swapDate, standbyPics, standbySics, tailAircraftTypes }: {
  rows: CrewSwapRow[];
  onAssignCrew: (tail: string, role: "PIC" | "SIC", name: string | null) => void;
  onRecomputeTail: (tail: string) => void;
  swapDate: string;
  standbyPics: string[];
  standbySics: string[];
  tailAircraftTypes?: Record<string, string>;
}) {
  const [dragCrew, setDragCrew] = useState<{ name: string; role: "PIC" | "SIC"; fromTail: string | null } | null>(null);
  const [recomputing, setRecomputing] = useState<Set<string>>(new Set());

  // Group rows by tail
  const byTail = new Map<string, CrewSwapRow[]>();
  for (const r of rows) {
    if (!byTail.has(r.tail_number)) byTail.set(r.tail_number, []);
    byTail.get(r.tail_number)!.push(r);
  }
  const tails = sortTailEntries(Array.from(byTail.entries()), (tail) => tailAircraftTypes?.[tail] ?? "");

  // All assigned oncoming names
  const assignedOncoming = new Set(rows.filter((r) => r.direction === "oncoming").map((r) => r.name));

  function handleDrop(targetTail: string, targetRole: "PIC" | "SIC") {
    if (!dragCrew) return;
    // Remove from source tail
    if (dragCrew.fromTail) {
      onAssignCrew(dragCrew.fromTail, dragCrew.role, null);
    }
    // Assign to target
    setTimeout(() => {
      onAssignCrew(targetTail, targetRole, dragCrew.name);
      // Recompute transport for affected tails
      setRecomputing((prev) => new Set(prev).add(targetTail));
      if (dragCrew.fromTail) setRecomputing((prev) => new Set(prev).add(dragCrew.fromTail!));
      setTimeout(() => {
        onRecomputeTail(targetTail);
        if (dragCrew.fromTail) onRecomputeTail(dragCrew.fromTail);
        setTimeout(() => {
          setRecomputing((prev) => { const n = new Set(prev); n.delete(targetTail); if (dragCrew.fromTail) n.delete(dragCrew.fromTail); return n; });
        }, 2000);
      }, 100);
    }, 50);
    setDragCrew(null);
  }

  // Crew card component
  function CrewCard({ name, role, homeAirports, aircraftType, fromTail, isSkillbridge, durationMinutes }: {
    name: string; role: "PIC" | "SIC"; homeAirports: string[]; aircraftType: string; fromTail: string | null; isSkillbridge?: boolean; durationMinutes?: number | null;
  }) {
    const typeTag = aircraftType === "citation_x" ? "CX" : aircraftType === "challenger" ? "CL" : aircraftType === "dual" ? "DL" : "";
    return (
      <div
        draggable
        onDragStart={(e) => {
          setDragCrew({ name, role, fromTail });
          e.dataTransfer.effectAllowed = "move";
        }}
        onDragEnd={() => setDragCrew(null)}
        className={`px-2 py-1.5 rounded border cursor-grab active:cursor-grabbing text-xs transition-all hover:shadow ${
          role === "PIC" ? "bg-blue-50 border-blue-200" : "bg-indigo-50 border-indigo-200"
        } ${dragCrew?.name === name ? "opacity-50" : ""}`}
      >
        <div className="font-medium text-gray-900">
          {name}
          {durationMinutes ? <span className="text-[9px] text-gray-400 font-normal ml-1">({Math.round(durationMinutes / 60 * 10) / 10}hr travel)</span> : null}
        </div>
        <div className="flex items-center gap-1 mt-0.5">
          <span className="text-[9px] text-gray-400">{homeAirports.join("/")}</span>
          {typeTag && <span className={`text-[8px] px-1 rounded ${role === "PIC" ? "bg-blue-100 text-blue-600" : "bg-indigo-100 text-indigo-600"}`}>{typeTag}</span>}
          {isSkillbridge && <span className="text-[8px] px-1 rounded bg-teal-100 text-teal-600">SB</span>}
        </div>
      </div>
    );
  }

  return (
    <div className="flex gap-3 h-[600px]">
      {/* Left panel: Standby / Unassigned crew */}
      <div className="w-64 shrink-0 border rounded-lg bg-white overflow-y-auto">
        <div className="px-3 py-2 bg-gray-50 border-b sticky top-0">
          <div className="text-xs font-semibold text-gray-700 uppercase">Unassigned Crew</div>
        </div>
        <div className="p-2 space-y-3">
          {standbyPics.length > 0 && (
            <div>
              <div className="text-[10px] font-bold text-blue-600 uppercase mb-1">PICs ({standbyPics.length})</div>
              <div className="space-y-1">
                {standbyPics.map((name) => {
                  const crewRow = rows.find((r) => r.name === name) ?? null;
                  return (
                    <CrewCard key={name} name={name} role="PIC"
                      homeAirports={crewRow?.home_airports ?? []}
                      aircraftType={crewRow?.aircraft_type ?? "unknown"}
                      fromTail={null}
                      isSkillbridge={crewRow?.is_skillbridge}
                      durationMinutes={crewRow?.duration_minutes}
                    />
                  );
                })}
              </div>
            </div>
          )}
          {standbySics.length > 0 && (
            <div>
              <div className="text-[10px] font-bold text-indigo-600 uppercase mb-1">SICs ({standbySics.length})</div>
              <div className="space-y-1">
                {standbySics.map((name) => {
                  const crewRow = rows.find((r) => r.name === name) ?? null;
                  return (
                    <CrewCard key={name} name={name} role="SIC"
                      homeAirports={crewRow?.home_airports ?? []}
                      aircraftType={crewRow?.aircraft_type ?? "unknown"}
                      fromTail={null}
                      isSkillbridge={crewRow?.is_skillbridge}
                      durationMinutes={crewRow?.duration_minutes}
                    />
                  );
                })}
              </div>
            </div>
          )}
          {standbyPics.length === 0 && standbySics.length === 0 && (
            <div className="text-xs text-gray-400 text-center py-4">All crew assigned</div>
          )}
        </div>
      </div>

      {/* Right panel: Tail drop zones */}
      <div className="flex-1 overflow-y-auto space-y-2">
        {tails.map(([tail, tailRows]) => {
          const onPic = tailRows.find((r) => r.direction === "oncoming" && r.role === "PIC");
          const onSic = tailRows.find((r) => r.direction === "oncoming" && r.role === "SIC");
          const offPic = tailRows.find((r) => r.direction === "offgoing" && r.role === "PIC");
          const offSic = tailRows.find((r) => r.direction === "offgoing" && r.role === "SIC");
          const swapLoc = onPic?.swap_location ?? onSic?.swap_location ?? offPic?.swap_location ?? "?";
          const tailType = tailAircraftTypes?.[tail];
          const ac = AIRCRAFT_COLORS[tailType ?? onPic?.aircraft_type ?? ""];
          const tailCost = tailRows.reduce((s, r) => s + (r.cost_estimate ?? 0), 0);
          const isRecomputing = recomputing.has(tail);

          function DropSlot({ label, role, current }: { label: string; role: "PIC" | "SIC"; current: CrewSwapRow | undefined }) {
            const [over, setOver] = useState(false);
            return (
              <div
                onDragOver={(e) => { e.preventDefault(); setOver(true); }}
                onDragLeave={() => setOver(false)}
                onDrop={(e) => { e.preventDefault(); setOver(false); handleDrop(tail, role); }}
                className={`rounded border-2 border-dashed p-1.5 min-h-[44px] transition-colors ${
                  over ? "border-purple-400 bg-purple-50" : "border-gray-200 bg-gray-50/50"
                } ${isRecomputing ? "animate-pulse" : ""}`}
              >
                {current ? (
                  <CrewCard name={current.name} role={role}
                    homeAirports={current.home_airports}
                    aircraftType={current.aircraft_type}
                    fromTail={tail}
                    isSkillbridge={current.is_skillbridge}
                    durationMinutes={current.duration_minutes}
                  />
                ) : (
                  <div className="text-[10px] text-gray-400 text-center py-1">
                    {dragCrew ? `Drop ${role} here` : `No ${role}`}
                  </div>
                )}
                {current?.travel_type && current.travel_type !== "none" && (
                  <div className="text-[9px] mt-0.5 text-gray-400">
                    {current.flight_number ?? current.travel_type} ${current.cost_estimate ?? 0}
                  </div>
                )}
              </div>
            );
          }

          return (
            <div key={tail} className={`rounded-lg border bg-white p-3 ${isRecomputing ? "ring-2 ring-purple-200" : ""}`}>
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <span className="font-mono font-bold text-sm">{tail}</span>
                  {ac && <span className={`text-[9px] px-1.5 py-0.5 rounded ${ac.bg} ${ac.text}`}>{ac.label}</span>}
                  <span className="text-[10px] text-gray-400">@ {swapLoc}</span>
                </div>
                <div className="flex items-center gap-2">
                  {tailCost > 0 && <span className="text-xs text-gray-500">${tailCost.toLocaleString()}</span>}
                  {isRecomputing && <span className="text-[9px] text-purple-600">Computing...</span>}
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <div className="text-[9px] font-bold text-green-600 uppercase mb-1">Oncoming</div>
                  <div className="space-y-1">
                    <DropSlot label="PIC" role="PIC" current={onPic} />
                    <DropSlot label="SIC" role="SIC" current={onSic} />
                  </div>
                </div>
                <div>
                  <div className="text-[9px] font-bold text-red-600 uppercase mb-1">Offgoing</div>
                  <div className="space-y-1 text-[10px]">
                    <div className="px-2 py-1 rounded bg-red-50/50 text-gray-600">
                      {offPic ? `${offPic.name} (${offPic.home_airports.join("/")})` : "—"}
                    </div>
                    <div className="px-2 py-1 rounded bg-red-50/50 text-gray-600">
                      {offSic ? `${offSic.name} (${offSic.home_airports.join("/")})` : "—"}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function AirportAliasPanel({ flights, selectedDate }: { flights: Flight[]; selectedDate: Date }) {
  const [show, setShow] = useState(false);

  // Find FBO airports from this week's flights
  const fboAirports = useMemo(() => {
    const wedStr = selectedDate.toISOString().slice(0, 10);
    const airports = new Set<string>();
    for (const f of flights) {
      if (f.scheduled_departure?.startsWith(wedStr) ||
          (f.scheduled_departure && new Date(f.scheduled_departure) >= new Date(selectedDate.getTime() - 86400_000) &&
           new Date(f.scheduled_departure) <= new Date(selectedDate.getTime() + 86400_000))) {
        if (f.departure_icao) airports.add(f.departure_icao);
        if (f.arrival_icao) airports.add(f.arrival_icao);
      }
    }
    // Convert to IATA and find FBOs with aliases
    const result: { fbo: string; airports: string[]; preferred: string }[] = [];
    for (const icao of airports) {
      const iata = icao.length === 4 && icao.startsWith("K") ? icao.slice(1) : icao;
      const mapping = FBO_COMMERCIAL_MAP[iata];
      if (mapping) {
        result.push({ fbo: iata, ...mapping });
      }
    }
    return result.sort((a, b) => a.fbo.localeCompare(b.fbo));
  }, [flights, selectedDate]);

  if (fboAirports.length === 0) return null;

  return (
    <div className="rounded-lg border bg-white shadow-sm overflow-hidden">
      <div
        className="px-4 py-3 bg-gray-50 border-b flex items-center justify-between cursor-pointer"
        onClick={() => setShow(!show)}
      >
        <h3 className="text-sm font-semibold text-gray-700 uppercase tracking-wider">
          FBO Commercial Airports ({fboAirports.length} FBOs)
        </h3>
        <span className="text-xs text-gray-400">{show ? "Hide" : "Show"}</span>
      </div>
      {show && (
        <div className="p-3">
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
            {fboAirports.map((fbo) => (
              <div key={fbo.fbo} className="rounded border px-3 py-2 bg-gray-50">
                <div className="font-mono font-bold text-sm text-gray-900">{fbo.fbo}</div>
                <div className="flex flex-wrap gap-1 mt-1">
                  {fbo.airports.map((a) => (
                    <span
                      key={a}
                      className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${
                        a === fbo.preferred
                          ? "bg-green-100 text-green-700 font-bold"
                          : "bg-blue-50 text-blue-600"
                      }`}
                    >
                      {a}{a === fbo.preferred ? " *" : ""}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
          <div className="mt-2 pt-2 border-t flex items-center gap-2">
            <button
              onClick={async () => {
                const fbo = prompt("FBO airport code (e.g., BFI):");
                if (!fbo) return;
                const comm = prompt(`Commercial airport(s) near ${fbo.toUpperCase()} (comma-separated, e.g., SEA,PDX):`);
                if (!comm) return;
                const airports = comm.split(",").map((a) => a.trim().toUpperCase()).filter(Boolean);
                if (airports.length === 0) return;
                const fboUpper = fbo.toUpperCase();
                // Update in-memory map
                FBO_COMMERCIAL_MAP[fboUpper] = { airports, preferred: airports[0] };
                // Persist to DB
                const icaos = airports.map((a) => a.length === 3 ? `K${a}` : a);
                const fboIcao = fboUpper.length === 3 ? `K${fboUpper}` : fboUpper;
                try {
                  await fetch("/api/crew/airport-aliases", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ fbo_icao: fboIcao, commercial_icaos: icaos, preferred_icao: icaos[0] }),
                  });
                } catch {}
                setShow(false);
                setTimeout(() => setShow(true), 50);
              }}
              className="text-[10px] px-2 py-1 rounded bg-blue-50 text-blue-600 hover:bg-blue-100 border border-blue-200 font-medium"
            >
              + Add FBO
            </button>
            <span className="text-[9px] text-gray-400">Add custom FBO → commercial airport mapping (supports multiple, comma-separated)</span>
          </div>
        </div>
      )}
    </div>
  );
}

function isWednesday(iso: string, targetWed: Date): boolean {
  const d = new Date(iso);
  return d.toISOString().slice(0, 10) === targetWed.toISOString().slice(0, 10);
}

function isLiveFlightType(type: string | null): boolean {
  if (!type) return false;
  return ["charter", "revenue", "owner"].includes(type.toLowerCase());
}

// ─── Swap Sheet (Excel-matching layout) ─────────────────────────────────────

/** Duty day duration tag — shows hours or duty-on time for oncoming without duty_off */
function DutyDayTag({ row }: { row: CrewSwapRow }) {
  if (row.duty_on_time && row.duty_off_time) {
    const hrs = (new Date(row.duty_off_time).getTime() - new Date(row.duty_on_time).getTime()) / 3600000;
    const display = hrs.toFixed(1) + "h";
    const cls = hrs > 14
      ? "bg-red-100 text-red-700"
      : hrs > 12
      ? "bg-amber-100 text-amber-700"
      : hrs > 10
      ? "bg-yellow-100 text-yellow-700"
      : "bg-gray-100 text-gray-600";
    return <span className={`text-[9px] px-1.5 py-0.5 rounded-full font-medium ${cls}`}>{display}</span>;
  }
  if (row.duty_on_time) {
    const d = new Date(row.duty_on_time);
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    return <span className="text-[9px] px-1.5 py-0.5 rounded-full font-medium bg-gray-100 text-gray-600">on {hh}:{mm}</span>;
  }
  return null;
}

function SwapSheetRow({ row, onArrivalOverride, onToggleConfirm }: { row: CrewSwapRow; onArrivalOverride?: (tail: string, role: "PIC" | "SIC", direction: "oncoming" | "offgoing", newTimeHHMM: string) => void; onToggleConfirm?: (tail: string, role: "PIC" | "SIC", direction: "oncoming" | "offgoing") => void }) {
  const ac = AIRCRAFT_COLORS[row.aircraft_type];
  const rowBg = ac ? `${ac.bg}/30` : "";
  const isUnsolved = row.travel_type === "none";
  const isConfirmed = !!row.confirmed;

  return (
    <tr className={`hover:bg-gray-50 border-b border-gray-100 ${rowBg} ${!isUnsolved && !isConfirmed ? "opacity-70" : ""}`}
      style={!isUnsolved ? { borderLeft: `3px solid ${isConfirmed ? "#22c55e" : "#eab308"}`, borderLeftStyle: isConfirmed ? "solid" : "dashed" } : undefined}
    >
      {/* Name (Home Base) */}
      <td className="px-3 py-1.5 text-sm">
        <div className="flex items-center gap-1.5">
          {!isUnsolved && onToggleConfirm && (
            <button
              onClick={() => onToggleConfirm(row.tail_number, row.role, row.direction)}
              className={`w-4 h-4 rounded border flex items-center justify-center text-[10px] shrink-0 transition-colors ${
                isConfirmed
                  ? "bg-green-500 border-green-600 text-white"
                  : "bg-white border-gray-300 text-transparent hover:border-yellow-400"
              }`}
              title={isConfirmed ? "Confirmed — click to mark tentative" : "Tentative — click to confirm"}
            >
              {isConfirmed ? "\u2713" : ""}
            </button>
          )}
          {ac && (
            <span className={`inline-block w-2.5 h-2.5 rounded-full ${ac.bg} border ${ac.text.replace("text-", "border-")}`} />
          )}
          <span className="font-medium text-gray-900">{row.name}</span>
          {row.is_day_before ? (
            <span className="text-[9px] px-1.5 py-0.5 rounded-full font-medium bg-indigo-100 text-indigo-700" title={row.crew_rest_hours != null ? `${row.crew_rest_hours}hr crew rest before swap day` : "Positioning day before swap"}>
              DAY BEFORE{row.crew_rest_hours != null ? ` · ${row.crew_rest_hours}hr rest` : ""}
            </span>
          ) : (
            <DutyDayTag row={row} />
          )}
          {row.duration_minutes ? <span className="text-xs text-gray-400 ml-1">({Math.round(row.duration_minutes / 60 * 10) / 10}hr travel)</span> : null}
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

      {/* Available / FBO Arrival Time */}
      <td className="px-3 py-1.5 text-xs text-gray-600">
        {onArrivalOverride && (row.travel_type === "uber" || row.travel_type === "rental_car" || row.travel_type === "drive") && (row.available_time || row.arrival_time) ? (
          <div className="flex flex-col gap-0.5">
            <input
              type="time"
              className="border border-gray-300 rounded px-1 py-0.5 text-xs w-[5.5rem] focus:ring-1 focus:ring-blue-400 focus:border-blue-400"
              defaultValue={(() => { const d = new Date(row.available_time ?? row.arrival_time!); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; })()}
              onBlur={(e) => onArrivalOverride(row.tail_number, row.role, row.direction, e.target.value)}
              title="Set FBO arrival time — departure from home auto-calculated"
            />
            <span className="text-[9px] text-gray-400">@ FBO</span>
          </div>
        ) : (
          row.available_time ? fmtShortTime(row.available_time)
            : row.arrival_time ? fmtShortTime(row.arrival_time)
            : "—"
        )}
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

function SwapSheet({ rows, view, impacts, impactedTails, lockedTails, onLockTail, onAssignCrew, pool, onChangeTransport, onSwapPointChange, onCrewSwapPointChange, onArrivalOverride, onToggleConfirm, onConfirmTail, badPairings, checkairmen, flights, selectedDate, tailAircraftTypes }: {
  rows: CrewSwapRow[]; view: "role" | "aircraft"; impacts?: PlanImpact[]; impactedTails?: Set<string>;
  lockedTails?: Set<string>; onLockTail?: (tail: string) => void;
  onAssignCrew?: (tail: string, role: "PIC" | "SIC", name: string | null) => void;
  pool?: OncomingPool | null;
  onChangeTransport?: (tail: string, role: "PIC" | "SIC", direction: "oncoming" | "offgoing", row: CrewSwapRow) => void;
  onSwapPointChange?: (tail: string, newSwapPoint: string) => void;
  onCrewSwapPointChange?: (tail: string, role: "PIC" | "SIC", direction: "oncoming" | "offgoing", row: CrewSwapRow, newSwapPoint: string) => void;
  onArrivalOverride?: (tail: string, role: "PIC" | "SIC", direction: "oncoming" | "offgoing", newTimeHHMM: string) => void;
  onToggleConfirm?: (tail: string, role: "PIC" | "SIC", direction: "oncoming" | "offgoing") => void;
  onConfirmTail?: (tail: string) => void;
  badPairings?: CrewInfoData["bad_pairings"];
  checkairmen?: CrewInfoData["checkairmen"];
  flights?: Flight[];
  selectedDate?: Date;
  tailAircraftTypes?: Record<string, string>;
}) {
  if (view === "aircraft") return <SwapSheetByTail rows={rows} impacts={impacts} impactedTails={impactedTails} lockedTails={lockedTails} onLockTail={onLockTail} onAssignCrew={onAssignCrew} pool={pool} onChangeTransport={onChangeTransport} onSwapPointChange={onSwapPointChange} onCrewSwapPointChange={onCrewSwapPointChange} onArrivalOverride={onArrivalOverride} onToggleConfirm={onToggleConfirm} onConfirmTail={onConfirmTail} badPairings={badPairings} checkairmen={checkairmen} flights={flights} selectedDate={selectedDate} tailAircraftTypes={tailAircraftTypes} />;
  return <SwapSheetByRole rows={rows} onArrivalOverride={onArrivalOverride} onToggleConfirm={onToggleConfirm} />;
}

function SwapSheetByRole({ rows, onArrivalOverride, onToggleConfirm }: { rows: CrewSwapRow[]; onArrivalOverride?: (tail: string, role: "PIC" | "SIC", direction: "oncoming" | "offgoing", newTimeHHMM: string) => void; onToggleConfirm?: (tail: string, role: "PIC" | "SIC", direction: "oncoming" | "offgoing") => void }) {
  const byArrival = (a: CrewSwapRow, b: CrewSwapRow) =>
    (a.arrival_time ?? "").localeCompare(b.arrival_time ?? "");
  const byDeparture = (a: CrewSwapRow, b: CrewSwapRow) =>
    (a.departure_time ?? "").localeCompare(b.departure_time ?? "");
  const oncomingPics = rows.filter((r) => r.direction === "oncoming" && r.role === "PIC").sort(byArrival);
  const oncomingSics = rows.filter((r) => r.direction === "oncoming" && r.role === "SIC").sort(byArrival);
  const offgoingPics = rows.filter((r) => r.direction === "offgoing" && r.role === "PIC").sort(byDeparture);
  const offgoingSics = rows.filter((r) => r.direction === "offgoing" && r.role === "SIC").sort(byDeparture);

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
          {oncomingPics.map((r, i) => <SwapSheetRow key={`op-${i}`} row={r} onArrivalOverride={onArrivalOverride} onToggleConfirm={onToggleConfirm} />)}
          <SectionHeader title="Oncoming Pilots — Second In-Command" count={oncomingSics.length} color="bg-green-50 text-green-600" />
          {oncomingSics.map((r, i) => <SwapSheetRow key={`os-${i}`} row={r} onArrivalOverride={onArrivalOverride} onToggleConfirm={onToggleConfirm} />)}
          <SectionHeader title="Offgoing Pilots — Pilot In-Command" count={offgoingPics.length} color="bg-red-50 text-red-700 border-t-2 border-red-300" />
          {offgoingPics.map((r, i) => <SwapSheetRow key={`fp-${i}`} row={r} onArrivalOverride={onArrivalOverride} onToggleConfirm={onToggleConfirm} />)}
          <SectionHeader title="Offgoing Pilots — Second In-Command" count={offgoingSics.length} color="bg-red-50 text-red-600" />
          {offgoingSics.map((r, i) => <SwapSheetRow key={`fs-${i}`} row={r} onArrivalOverride={onArrivalOverride} onToggleConfirm={onToggleConfirm} />)}
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

function SwapSheetByTail({ rows, impacts, impactedTails, lockedTails, onLockTail, onAssignCrew, pool, onChangeTransport, onSwapPointChange, onCrewSwapPointChange, onArrivalOverride, onToggleConfirm, onConfirmTail, badPairings, checkairmen, flights, selectedDate, tailAircraftTypes }: {
  rows: CrewSwapRow[];
  impacts?: PlanImpact[];
  impactedTails?: Set<string>;
  lockedTails?: Set<string>;
  onLockTail?: (tail: string) => void;
  onAssignCrew?: (tail: string, role: "PIC" | "SIC", name: string | null) => void;
  pool?: OncomingPool | null;
  onChangeTransport?: (tail: string, role: "PIC" | "SIC", direction: "oncoming" | "offgoing", row: CrewSwapRow) => void;
  onSwapPointChange?: (tail: string, newSwapPoint: string) => void;
  onCrewSwapPointChange?: (tail: string, role: "PIC" | "SIC", direction: "oncoming" | "offgoing", row: CrewSwapRow, newSwapPoint: string) => void;
  onArrivalOverride?: (tail: string, role: "PIC" | "SIC", direction: "oncoming" | "offgoing", newTimeHHMM: string) => void;
  onToggleConfirm?: (tail: string, role: "PIC" | "SIC", direction: "oncoming" | "offgoing") => void;
  onConfirmTail?: (tail: string) => void;
  badPairings?: CrewInfoData["bad_pairings"];
  checkairmen?: CrewInfoData["checkairmen"];
  flights?: Flight[];
  selectedDate?: Date;
  tailAircraftTypes?: Record<string, string>;
}) {
  // Build checkairman type lookup for enhanced CA badges
  const caTypeLookup = useMemo(() => {
    const map = new Map<string, { citation_x: boolean; challenger: boolean }>();
    if (!checkairmen) return map;
    for (const ca of checkairmen) {
      const existing = map.get(ca.name);
      if (existing) {
        if (ca.citation_x) existing.citation_x = true;
        if (ca.challenger) existing.challenger = true;
      } else {
        map.set(ca.name, { citation_x: ca.citation_x, challenger: ca.challenger });
      }
    }
    return map;
  }, [checkairmen]);

  // Group by tail number
  const byTail = new Map<string, CrewSwapRow[]>();
  for (const r of rows) {
    if (!byTail.has(r.tail_number)) byTail.set(r.tail_number, []);
    byTail.get(r.tail_number)!.push(r);
  }
  const tails = sortTailEntries(Array.from(byTail.entries()), (tail) => tailAircraftTypes?.[tail] ?? rows.find(r => r.tail_number === tail)?.aircraft_type ?? "");

  return (
    <div className="space-y-3 p-3">
      {tails.map(([tail, tailRows]) => {
        // Hide oncoming crew with NO TRANSPORT whose warnings say UNSOLVABLE —
        // they were assigned by the optimizer but transport planner confirmed no viable route.
        // Show them as unassigned so user knows to manually handle.
        const isUnsolvable = (r: CrewSwapRow | undefined) =>
          r && r.travel_type === "none" && !r.name.startsWith("[UNASSIGNED") && r.warnings.some((w) => w.includes("UNSOLVABLE"));
        const onPicRaw = tailRows.find((r) => r.direction === "oncoming" && r.role === "PIC");
        const onSicRaw = tailRows.find((r) => r.direction === "oncoming" && r.role === "SIC");
        const onPic = isUnsolvable(onPicRaw) ? undefined : onPicRaw;
        const onSic = isUnsolvable(onSicRaw) ? undefined : onSicRaw;
        const offPic = tailRows.find((r) => r.direction === "offgoing" && r.role === "PIC");
        const offSic = tailRows.find((r) => r.direction === "offgoing" && r.role === "SIC");
        // Use actual aircraft type from ics_sources (tail → type), fall back to crew type
        const tailType = tailAircraftTypes?.[tail];
        const ac = AIRCRAFT_COLORS[tailType ?? onPic?.aircraft_type ?? onSic?.aircraft_type ?? offPic?.aircraft_type ?? ""];
        const tailCost = tailRows.reduce((s, r) => s + (r.cost_estimate ?? 0), 0);
        const swapLoc = onPic?.swap_location ?? onSic?.swap_location ?? offPic?.swap_location ?? "?";
        const allWarnings = tailRows.flatMap((r) => r.warnings);

        // Bad pairing check (oncoming and offgoing crews)
        const onBadPairing = badPairings ? findBadPairing(onPic?.name, onSic?.name, badPairings) : null;
        const offBadPairing = badPairings ? findBadPairing(offPic?.name, offSic?.name, badPairings) : null;

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

        // Check if ANY oncoming crew arrives AFTER aircraft departs THEIR swap point
        let crewArrivesLate = false;
        if (flights && selectedDate) {
          const wedStr = selectedDate.toISOString().slice(0, 10);
          for (const onCrew of [onPic, onSic]) {
            if (!onCrew?.available_time) continue;
            const crewSwap = onCrew.swap_location ?? swapLoc;
            const crewSwapIcao = crewSwap.length === 3 ? `K${crewSwap}` : crewSwap;
            const crewAvailMs = new Date(onCrew.available_time).getTime();
            // Find the first departure FROM this crew member's swap point, skipping overnight legs (before 6 AM)
            const depFromSwap = flights
              .filter((f) => {
                if (f.tail_number !== tail || f.departure_icao !== crewSwapIcao) return false;
                if (!f.scheduled_departure?.startsWith(wedStr)) return false;
                // Skip overnight legs (before 6 AM local) — these are carryovers from the previous day
                const depHour = new Date(f.scheduled_departure).getHours();
                return depHour >= 6;
              })
              .sort((a, b) => (a.scheduled_departure ?? "").localeCompare(b.scheduled_departure ?? ""))[0];
            if (depFromSwap?.scheduled_departure) {
              const depMs = new Date(depFromSwap.scheduled_departure).getTime();
              if (crewAvailMs > depMs) {
                crewArrivesLate = true;
                break;
              }
            }
          }
        }

        // Classify tail legs: REV (has revenue/charter), POS (only positioning), IDLE (no legs)
        const tailLegType: "rev" | "pos" | "idle" = (() => {
          if (!flights || !selectedDate) return "idle";
          const wedStr = selectedDate.toISOString().slice(0, 10);
          const tailLegs = flights.filter((f) => f.tail_number === tail && f.scheduled_departure?.startsWith(wedStr));
          if (tailLegs.length === 0) return "idle";
          const hasRev = tailLegs.some((f) => {
            const ft = (f.flight_type ?? "").toLowerCase();
            return ft.includes("charter") || ft.includes("revenue") || ft.includes("owner");
          });
          return hasRev ? "rev" : "pos";
        })();

        // Detect split swap: PIC and SIC swapping at different airports
        const onPicSwap = onPic?.swap_location;
        const onSicSwap = onSic?.swap_location;
        const offPicSwap = offPic?.swap_location;
        const offSicSwap = offSic?.swap_location;
        // Only flag split swap when both crew ARE assigned and at different airports
        const onPicAssigned = onPic && onPic.travel_type !== "none" && !onPic.name.includes("UNASSIGNED");
        const onSicAssigned = onSic && onSic.travel_type !== "none" && !onSic.name.includes("UNASSIGNED");
        const isSplitSwap = (onPicAssigned && onSicAssigned && onPicSwap && onSicSwap && onPicSwap !== onSicSwap) ||
          (offPicSwap && offSicSwap && offPicSwap !== offSicSwap);

        // Check pairing: each swap point needs at least one oncoming AND one offgoing
        const swapPointCrewMap = new Map<string, { oncoming: string[]; offgoing: string[] }>();
        for (const r of tailRows) {
          const sp = r.swap_location ?? swapLoc;
          if (!swapPointCrewMap.has(sp)) swapPointCrewMap.set(sp, { oncoming: [], offgoing: [] });
          swapPointCrewMap.get(sp)![r.direction].push(r.name);
        }
        const unpairedSwapPoints: string[] = [];
        for (const [sp, crew] of swapPointCrewMap) {
          // Only flag when someone is LEAVING with no one ARRIVING (aircraft unattended).
          // Someone ARRIVING with no one LEAVING is fine — they're boarding early at an intermediate stop.
          if (crew.offgoing.length > 0 && crew.oncoming.length === 0) unpairedSwapPoints.push(`${sp} (offgoing only — no replacement)`);
        }

        const isLocked = lockedTails?.has(tail);
        // Build pool options for crew picker (only oncoming direction)
        const poolPics = pool?.pic ?? [];
        const poolSics = pool?.sic ?? [];
        // Names already assigned across all tails (to avoid double-assigning)
        const assignedOncoming = new Set(rows.filter((r) => r.direction === "oncoming").map((r) => r.name));

        function CrewSlot({ label, color, row, direction, role }: {
          label: string; color: string; row: CrewSwapRow | undefined;
          direction: "oncoming" | "offgoing"; role: "PIC" | "SIC";
        }) {
          const rowLocked = isLocked || !!row?.confirmed;
          const canPick = direction === "oncoming" && onAssignCrew && pool && !rowLocked;
          const poolForRole = role === "PIC" ? poolPics : poolSics;
          const available = poolForRole.filter((p) => !assignedOncoming.has(p.name) || p.name === row?.name);

          // Crew assigned to OTHER unlocked tails (for cross-tail reassignment)
          const assignedElsewhere = rows
            .filter((r) => r.direction === "oncoming" && r.role === role && r.tail_number !== tail && !lockedTails?.has(r.tail_number))
            .map((r) => {
              const poolEntry = poolForRole.find((p) => p.name === r.name);
              return { name: r.name, tail_number: r.tail_number, home_airports: poolEntry?.home_airports ?? r.home_airports ?? [], aircraft_type: poolEntry?.aircraft_type ?? "" };
            });

          if (!row) return (
            <div className="flex items-center gap-2 py-1.5 px-3 rounded bg-gray-50">
              <span className={`text-[10px] font-bold uppercase ${color} w-14`}>{label}</span>
              {canPick && (available.length > 0 || assignedElsewhere.length > 0) ? (
                <select
                  className="text-xs border rounded px-2 py-1 bg-white text-gray-700"
                  value=""
                  onChange={(e) => { if (e.target.value) onAssignCrew(tail, role, e.target.value); }}
                >
                  <option value="">Assign crew...</option>
                  {available.length > 0 && (
                    <optgroup label="Available">
                      {available.map((p) => {
                        const typeTag = p.aircraft_type === "citation_x" ? "CX" : p.aircraft_type === "challenger" ? "CL" : p.aircraft_type === "dual" ? "DL" : "";
                        return (
                          <option key={p.name} value={p.name}>
                            {p.name} ({p.home_airports.join("/")}) [{typeTag}]
                            {p.is_checkairman ? " [CA]" : ""}{p.is_skillbridge ? " [SB]" : ""}
                          </option>
                        );
                      })}
                    </optgroup>
                  )}
                  {assignedElsewhere.length > 0 && (
                    <optgroup label="── Pull from other tail ──">
                      {assignedElsewhere.map((a) => {
                        const typeTag = a.aircraft_type === "citation_x" ? "CX" : a.aircraft_type === "challenger" ? "CL" : a.aircraft_type === "dual" ? "DL" : "";
                        return (
                          <option key={a.name} value={a.name}>
                            {a.name} ({a.home_airports.join("/")}) [{typeTag}] ← {a.tail_number}
                          </option>
                        );
                      })}
                    </optgroup>
                  )}
                </select>
              ) : (
                <span className="text-xs text-gray-400">— not assigned —</span>
              )}
            </div>
          );
          const crewIsUnsolved = row.travel_type === "none";
          const crewIsConfirmed = !!row.confirmed;
          return (
            <div className={`flex items-center gap-2 py-1.5 px-3 rounded bg-gray-50/50 ${!crewIsUnsolved && !crewIsConfirmed ? "opacity-70" : ""}`}
              style={!crewIsUnsolved ? { borderLeft: `3px ${crewIsConfirmed ? "solid #22c55e" : "dashed #eab308"}` } : undefined}
            >
              {/* Confirm toggle */}
              {!crewIsUnsolved && onToggleConfirm && (
                <button
                  onClick={() => onToggleConfirm(tail, role, direction)}
                  className={`w-4 h-4 rounded border flex items-center justify-center text-[10px] shrink-0 transition-colors ${
                    crewIsConfirmed
                      ? "bg-green-500 border-green-600 text-white"
                      : "bg-white border-gray-300 text-transparent hover:border-yellow-400"
                  }`}
                  title={crewIsConfirmed ? "Confirmed — click to mark tentative" : "Tentative — click to confirm"}
                >
                  {crewIsConfirmed ? "\u2713" : ""}
                </button>
              )}
              <span className={`text-[10px] font-bold uppercase ${color} w-10 shrink-0`}>{label}</span>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span className="text-sm font-semibold text-gray-900">{row.name}</span>
                  {row.is_day_before ? (
                    <span className="text-[9px] px-1.5 py-0.5 rounded-full font-medium bg-indigo-100 text-indigo-700" title={row.crew_rest_hours != null ? `${row.crew_rest_hours}hr crew rest` : ""}>
                      DAY BEFORE{row.crew_rest_hours != null ? ` · ${row.crew_rest_hours}hr rest` : ""}
                    </span>
                  ) : (
                    <DutyDayTag row={row} />
                  )}
                  <span className="text-[10px] text-gray-400">({row.home_airports.join("/")})</span>
                  {/* Per-crew swap point — show if different from tail swap point or if multiple available */}
                  {row.swap_location && (() => {
                    const allPts = row.all_swap_points ?? [];
                    const crewSwapLoc = row.swap_location;
                    const isDifferent = crewSwapLoc !== swapLoc;
                    // PIC can swap anywhere, SIC only at SIC-eligible points
                    const availablePts = role === "PIC" ? allPts : allPts;
                    // Extract repo/positioning leg airports for manual override
                    const crewRepoAirports: string[] = [];
                    if (flights && selectedDate) {
                      const wedStr = selectedDate.toISOString().slice(0, 10);
                      const tailFlights = flights.filter((f) => f.tail_number === tail && f.scheduled_departure?.startsWith(wedStr));
                      const repoSet = new Set<string>();
                      for (const f of tailFlights) {
                        if (!isLiveFlightType(f.flight_type)) {
                          const depIata = f.departure_icao?.length === 4 && f.departure_icao.startsWith("K") ? f.departure_icao.slice(1) : f.departure_icao;
                          const arrIata = f.arrival_icao?.length === 4 && f.arrival_icao.startsWith("K") ? f.arrival_icao.slice(1) : f.arrival_icao;
                          if (depIata && !availablePts.includes(depIata)) repoSet.add(depIata);
                          if (arrIata && !availablePts.includes(arrIata)) repoSet.add(arrIata);
                        }
                      }
                      crewRepoAirports.push(...repoSet);
                    }
                    const totalCrewOptions = availablePts.length + crewRepoAirports.length;
                    if (totalCrewOptions > 1 && onChangeTransport) {
                      return (
                        <select
                          className={`text-[9px] border rounded px-1 py-0.5 font-mono ${
                            isDifferent ? "bg-amber-50 text-amber-700 border-amber-300" : "bg-gray-50 text-gray-500"
                          } ${rowLocked ? "opacity-50 cursor-not-allowed" : ""}`}
                          value={crewSwapLoc}
                          disabled={rowLocked}
                          onChange={(e) => {
                            const newLoc = e.target.value;
                            if (newLoc === crewSwapLoc) return;
                            if (onCrewSwapPointChange) {
                              // Auto-recompute transport for this crew member at the new swap point
                              onCrewSwapPointChange(tail, role, direction, row, newLoc);
                            } else if (onChangeTransport) {
                              // Fallback: open flight picker manually
                              const updatedRow: CrewSwapRow = {
                                ...row,
                                swap_location: newLoc,
                                flight_number: null,
                                departure_time: null,
                                arrival_time: null,
                                available_time: null,
                                duty_on_time: null,
                                cost_estimate: null,
                                duration_minutes: null,
                                travel_type: "none",
                                backup_flight: null,
                                alt_flights: [],
                                warnings: [],
                                notes: `Swap point changed to ${newLoc} — searching flights...`,
                              };
                              onChangeTransport(tail, role, direction, updatedRow);
                            }
                          }}
                        >
                          {availablePts.map((pt) => (
                            <option key={pt} value={pt}>@ {pt}</option>
                          ))}
                          {crewRepoAirports.map((pt) => (
                            <option key={`repo-${pt}`} value={pt} className="text-gray-400">@ {pt} (repo)</option>
                          ))}
                        </select>
                      );
                    }
                    if (isDifferent) {
                      return <span className="text-[9px] px-1 py-0.5 rounded bg-amber-50 text-amber-700 font-mono">@ {crewSwapLoc}</span>;
                    }
                    return null;
                  })()}
                  {row.is_checkairman && (() => {
                    const caTypes = caTypeLookup.get(row.name);
                    const both = caTypes?.citation_x && caTypes?.challenger;
                    const label = !caTypes ? "CA" : both ? "CA" : caTypes.citation_x ? "CA-CX" : caTypes.challenger ? "CA-CL" : "CA";
                    return <span className="text-[9px] px-1 py-0.5 rounded bg-amber-100 text-amber-700">{label}</span>;
                  })()}
                  {row.is_skillbridge && <span className="text-[9px] px-1 py-0.5 rounded bg-teal-100 text-teal-700">SB</span>}
                  {canPick && !rowLocked && (() => {
                    // Find tails that need this role (for "Move to..." option)
                    const tailsNeedingRole = Object.keys(byTail).filter((t) => {
                      if (t === tail) return false;
                      const tRows = byTail.get(t) ?? [];
                      const hasRole = tRows.some((r) => r.direction === "oncoming" && r.role === role && r.travel_type !== "none");
                      return !hasRole;
                    });

                    return (
                      <select
                        className="text-[10px] border rounded px-1 py-0.5 bg-white text-gray-500 ml-1"
                        value={row.name}
                        onChange={(e) => {
                          const val = e.target.value;
                          if (val.startsWith("move:")) {
                            // Move to another tail: unassign from current, assign to target
                            const targetTail = val.slice(5);
                            onAssignCrew(tail, role, null); // unassign from current
                            setTimeout(() => onAssignCrew(targetTail, role, row.name), 50); // assign to target
                          } else {
                            onAssignCrew(tail, role, val || null);
                          }
                        }}
                      >
                        <option value={row.name}>{row.name}</option>
                        <option value="">Unassign</option>
                        {available.filter((p) => p.name !== row.name).map((p) => {
                          const typeTag = p.aircraft_type === "citation_x" ? "CX" : p.aircraft_type === "challenger" ? "CL" : p.aircraft_type === "dual" ? "DL" : "";
                          return (
                            <option key={p.name} value={p.name}>
                              {p.name} ({p.home_airports.join("/")}) [{typeTag}]
                              {p.is_checkairman ? " [CA]" : ""}{p.is_skillbridge ? " [SB]" : ""}
                            </option>
                          );
                        })}
                        {tailsNeedingRole.length > 0 && (
                          <optgroup label={`Move to (needs ${role})...`}>
                            {tailsNeedingRole.map((t) => (
                              <option key={`move:${t}`} value={`move:${t}`}>→ {t}</option>
                            ))}
                          </optgroup>
                        )}
                      </select>
                    );
                  })()}
                </div>
                <div className="flex items-center gap-2 mt-1 text-xs">
                  {/* Transport type badge */}
                  {row.travel_type === "commercial" && row.flight_number ? (
                    <span className="font-mono text-blue-700 font-semibold">{row.flight_number}</span>
                  ) : row.travel_type === "uber" ? (
                    <span className="font-mono text-violet-700 font-semibold">UBER</span>
                  ) : row.travel_type === "rental_car" ? (
                    <span className="font-mono text-orange-700 font-semibold">RENTAL</span>
                  ) : row.travel_type === "drive" ? (
                    <span className="font-mono text-amber-700 font-semibold">DRIVE</span>
                  ) : (
                    <span className="text-red-500 font-semibold">NO TRANSPORT</span>
                  )}
                  {/* Departure → Arrival times */}
                  {row.departure_time && (
                    <span className="text-gray-500">dep {fmtShortTime(row.departure_time, row.swap_location)}</span>
                  )}
                  {(row.available_time ?? row.arrival_time) && (
                    onArrivalOverride && (row.travel_type === "uber" || row.travel_type === "rental_car" || row.travel_type === "drive") ? (
                      <span className="text-gray-500 flex items-center gap-1">
                        avail
                        <input
                          type="time"
                          className={`border border-gray-300 rounded px-1 py-0.5 text-xs w-20 focus:ring-1 focus:ring-blue-400 ${rowLocked ? "opacity-50 cursor-not-allowed bg-gray-100" : ""}`}
                          defaultValue={(() => { const d = new Date((row.available_time ?? row.arrival_time)!); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; })()}
                          disabled={rowLocked}
                          onBlur={(e) => onArrivalOverride(row.tail_number, row.role, row.direction, e.target.value)}
                        />
                      </span>
                    ) : (
                      <span className="text-gray-500">
                        {row.direction === "oncoming" ? "avail" : "arr"} {fmtShortTime(row.available_time ?? row.arrival_time, row.swap_location)}
                      </span>
                    )
                  )}
                  {/* Cost */}
                  {row.cost_estimate != null && (
                    <span className="text-gray-400 font-medium">${row.cost_estimate}</span>
                  )}
                  {/* Backup flight */}
                  {row.backup_flight && (
                    <span className="text-blue-400 text-[10px]">backup: {row.backup_flight}</span>
                  )}
                </div>
              </div>
              {row.warnings.length > 0 && (
                <span className="text-amber-500 text-[10px] shrink-0" title={row.warnings.join("\n")}>
                  {row.warnings.length} warn
                </span>
              )}
              {onChangeTransport && !rowLocked && (
                <button
                  onClick={() => onChangeTransport(tail, role, direction, row)}
                  className="text-[9px] px-1.5 py-0.5 rounded bg-blue-50 text-blue-600 hover:bg-blue-100 shrink-0 font-medium"
                >
                  Change
                </button>
              )}
              {rowLocked && (
                <span className="text-[9px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-400 shrink-0">Locked</span>
              )}
            </div>
          );
        }

        const tailImpacts = impacts?.filter((i) => i.tail_number === tail && !i.resolved) ?? [];
        const isImpacted = impactedTails?.has(tail) || tailImpacts.length > 0;
        const isSolved = [onPic, onSic, offPic, offSic].every((r) => r && r.travel_type !== "none");
        // Border color: red=impacted, amber=unsolved, gray=idle, yellow=pos-only, green=rev+solved
        const borderColor = isImpacted ? "border-l-red-500"
          : !isSolved ? "border-l-amber-400"
          : tailLegType === "idle" ? "border-l-gray-300"
          : tailLegType === "pos" ? "border-l-yellow-400"
          : "border-l-green-500";

        return (
          <div key={tail} id={`tail-${tail}`} className={`rounded-lg border border-l-4 ${borderColor} bg-white overflow-hidden ${isLocked ? "ring-2 ring-blue-300" : ""} ${tailImpacts.some(i => i.severity === "critical") ? "ring-2 ring-red-300" : ""}`}>
            {/* Tail header */}
            <div className={`px-4 py-2 border-b flex items-center justify-between ${isLocked ? "bg-blue-50" : "bg-gray-50"}`}>
              <div className="flex items-center gap-2">
                {onLockTail && (
                  <button
                    onClick={() => onLockTail(tail)}
                    className={`w-6 h-6 rounded flex items-center justify-center text-sm transition-colors ${
                      isLocked ? "bg-blue-500 text-white" : "bg-gray-200 text-gray-400 hover:bg-gray-300"
                    }`}
                    title={isLocked ? "Unlock — optimizer will recalculate this tail" : "Lock — keep this assignment during re-optimization"}
                  >
                    {isLocked ? "\uD83D\uDD12" : "\uD83D\uDD13"}
                  </button>
                )}
                <span className="font-mono font-bold text-gray-900">{tail}</span>
                {ac && <span className={`text-[10px] px-1.5 py-0.5 rounded ${ac.bg} ${ac.text}`}>{ac.label}</span>}
                {(() => {
                  const allPts = [...new Set(onPic?.all_swap_points ?? onSic?.all_swap_points ?? offPic?.all_swap_points ?? [])];
                  // Extract repo/positioning leg airports for manual override
                  const repoAirports: string[] = [];
                  if (flights && selectedDate) {
                    const wedStr = selectedDate.toISOString().slice(0, 10);
                    const tailFlights = flights.filter((f) => f.tail_number === tail && f.scheduled_departure?.startsWith(wedStr));
                    const repoSet = new Set<string>();
                    for (const f of tailFlights) {
                      if (!isLiveFlightType(f.flight_type)) {
                        const depIata = f.departure_icao?.length === 4 && f.departure_icao.startsWith("K") ? f.departure_icao.slice(1) : f.departure_icao;
                        const arrIata = f.arrival_icao?.length === 4 && f.arrival_icao.startsWith("K") ? f.arrival_icao.slice(1) : f.arrival_icao;
                        if (depIata && !allPts.includes(depIata)) repoSet.add(depIata);
                        if (arrIata && !allPts.includes(arrIata)) repoSet.add(arrIata);
                      }
                    }
                    repoAirports.push(...repoSet);
                  }
                  const totalOptions = allPts.length + repoAirports.length;
                  if (totalOptions > 1 && onSwapPointChange) {
                    return (
                      <select
                        className="font-mono text-xs text-gray-500 bg-white border rounded px-1.5 py-0.5 cursor-pointer hover:border-blue-300"
                        value={swapLoc}
                        onChange={(e) => onSwapPointChange(tail, e.target.value)}
                      >
                        {allPts.map((pt) => (
                          <option key={pt} value={pt}>@ {pt}</option>
                        ))}
                        {repoAirports.map((pt) => (
                          <option key={`repo-${pt}`} value={pt} className="text-gray-400">@ {pt} (repo)</option>
                        ))}
                      </select>
                    );
                  }
                  return <span className="font-mono text-xs text-gray-500">@ {swapLoc}</span>;
                })()}
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
                {crewArrivesLate && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded font-bold bg-red-600 text-white animate-pulse">
                    CREW ARRIVES AFTER AIRCRAFT DEPARTS
                  </span>
                )}
                {isSplitSwap && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded font-bold bg-purple-100 text-purple-700">
                    SPLIT SWAP
                  </span>
                )}
                {unpairedSwapPoints.length > 0 && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded font-bold bg-red-100 text-red-700" title={unpairedSwapPoints.join(", ")}>
                    UNPAIRED: {unpairedSwapPoints.join(", ")}
                  </span>
                )}
                {tailLegType === "idle" && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded font-medium bg-gray-200 text-gray-600">
                    IDLE — SCHEDULE MAY CHANGE
                  </span>
                )}
                {tailLegType === "pos" && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded font-medium bg-yellow-100 text-yellow-700">
                    POS ONLY — MAY CHANGE
                  </span>
                )}
                {(onBadPairing || offBadPairing) && (
                  <span className={`text-[10px] px-1.5 py-0.5 rounded font-bold ${
                    (onBadPairing?.severity === "severe" || offBadPairing?.severity === "severe")
                      ? "bg-red-100 text-red-700" : "bg-amber-100 text-amber-700"
                  }`} title={onBadPairing?.notes ?? offBadPairing?.notes ?? ""}>
                    Bad Pairing
                  </span>
                )}
                {tailCost > 0 && (
                  <span className="text-xs text-gray-500">${tailCost.toLocaleString()}</span>
                )}
                {/* Per-tail confirm status + button */}
                {(() => {
                  const solvedRows = tailRows.filter(r => r.travel_type !== "none");
                  const confirmedCount = solvedRows.filter(r => r.confirmed).length;
                  const allConfirmed = solvedRows.length > 0 && confirmedCount === solvedRows.length;
                  if (solvedRows.length === 0) return null;
                  return (
                    <>
                      <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${
                        allConfirmed ? "bg-green-100 text-green-700" : "bg-yellow-100 text-yellow-700"
                      }`}>
                        {confirmedCount}/{solvedRows.length} confirmed
                      </span>
                      {!allConfirmed && onConfirmTail && (
                        <button
                          onClick={() => onConfirmTail(tail)}
                          className="text-[9px] px-1.5 py-0.5 rounded bg-green-50 text-green-700 hover:bg-green-100 border border-green-200 font-medium"
                          title="Confirm all crew on this tail"
                        >
                          Confirm Tail
                        </button>
                      )}
                    </>
                  );
                })()}
              </div>
            </div>

            {/* Leg timeline — shows which crew flies which legs */}
            {flights && selectedDate && (() => {
              const wedStr = selectedDate.toISOString().slice(0, 10);
              const tailLegs = flights
                .filter((f) => f.tail_number === tail && f.scheduled_departure?.startsWith(wedStr))
                .sort((a, b) => (a.scheduled_departure ?? "").localeCompare(b.scheduled_departure ?? ""));
              if (tailLegs.length < 2) return null; // only show for multi-leg days
              const swapIcao = swapLoc.length === 3 ? `K${swapLoc}` : swapLoc;
              // Find the swap point index: the leg whose departure is from the swap airport
              // OR the last leg arriving at swap airport (for between_legs)
              let swapIdx = -1;
              for (let i = 0; i < tailLegs.length; i++) {
                if (tailLegs[i].arrival_icao === swapIcao && i < tailLegs.length - 1) {
                  swapIdx = i; // swap happens after this leg arrives
                  break;
                }
              }
              // If no between-legs match, check for before_live (swap at first departure)
              if (swapIdx === -1 && tailLegs[0]?.departure_icao === swapIcao) swapIdx = -1; // before first leg
              // For after_live, swap after last leg
              if (swapIdx === -1 && tailLegs[tailLegs.length - 1]?.arrival_icao === swapIcao) swapIdx = tailLegs.length - 1;

              return (
                <div className="px-4 py-1.5 border-b bg-gray-50/50 flex items-center gap-0.5 overflow-x-auto">
                  <span className="text-[9px] text-gray-400 mr-1 shrink-0">LEGS:</span>
                  {tailLegs.map((leg, i) => {
                    const dep = leg.departure_icao?.replace(/^K/, "") ?? "?";
                    const arr = leg.arrival_icao?.replace(/^K/, "") ?? "?";
                    const depTime = leg.scheduled_departure ? new Date(leg.scheduled_departure).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false }) : "";
                    const isLive = ["charter", "revenue", "owner"].includes((leg.flight_type ?? "").toLowerCase());
                    // Before swap = offgoing crew, after swap = oncoming crew
                    const isBeforeSwap = swapIdx >= 0 ? i <= swapIdx : true;
                    const bgColor = isBeforeSwap ? "bg-red-50 border-red-200 text-red-700" : "bg-green-50 border-green-200 text-green-700";
                    const showSwapMarker = i === swapIdx && swapIdx < tailLegs.length - 1;
                    return (
                      <div key={i} className="flex items-center gap-0.5 shrink-0">
                        <span
                          className={`text-[9px] px-1.5 py-0.5 rounded border font-mono ${bgColor} ${isLive ? "font-bold" : ""}`}
                          title={`${depTime} ${dep}→${arr} (${isBeforeSwap ? "offgoing" : "oncoming"} crew)${isLive ? " [LIVE]" : ""}`}
                        >
                          {dep}→{arr}
                        </span>
                        {showSwapMarker && (
                          <span className="text-[9px] px-1 py-0.5 rounded bg-amber-200 text-amber-800 font-bold shrink-0" title={`Swap point: ${swapLoc}`}>
                            SWAP
                          </span>
                        )}
                      </div>
                    );
                  })}
                  <span className="text-[9px] text-gray-400 ml-1 shrink-0">
                    {offPic?.name?.split(" ").pop() ?? "?"} → {onPic?.name?.split(" ").pop() ?? "?"}
                  </span>
                </div>
              );
            })()}

            {/* Bad pairing banner */}
            {(onBadPairing || offBadPairing) && (
              <div className={`px-4 py-1.5 border-b text-[11px] ${
                (onBadPairing?.severity === "severe" || offBadPairing?.severity === "severe") ? "bg-red-50" : "bg-amber-50"
              }`}>
                {onBadPairing && (
                  <div className={`flex items-center gap-1.5 ${onBadPairing.severity === "severe" ? "text-red-700" : "text-amber-700"}`}>
                    <span className={`text-[9px] px-1 py-0.5 rounded font-bold uppercase ${
                      onBadPairing.severity === "severe" ? "bg-red-200 text-red-800" : "bg-amber-200 text-amber-800"
                    }`}>{onBadPairing.severity}</span>
                    <span>Oncoming: {onBadPairing.pic} + {onBadPairing.sic}</span>
                    {onBadPairing.notes && <span className="text-gray-500">— {onBadPairing.notes}</span>}
                  </div>
                )}
                {offBadPairing && (
                  <div className={`flex items-center gap-1.5 ${offBadPairing.severity === "severe" ? "text-red-700" : "text-amber-700"}`}>
                    <span className={`text-[9px] px-1 py-0.5 rounded font-bold uppercase ${
                      offBadPairing.severity === "severe" ? "bg-red-200 text-red-800" : "bg-amber-200 text-amber-800"
                    }`}>{offBadPairing.severity}</span>
                    <span>Offgoing: {offBadPairing.pic} + {offBadPairing.sic}</span>
                    {offBadPairing.notes && <span className="text-gray-500">— {offBadPairing.notes}</span>}
                  </div>
                )}
              </div>
            )}

            {/* Impact banners — deduplicated, max 3 shown */}
            {tailImpacts.length > 0 && (
              <div className="px-4 py-2 space-y-1 border-b" style={{ background: tailImpacts.some(i => i.severity === "critical") ? "#fef2f2" : "#fffbeb" }}>
                {(() => {
                  // Deduplicate by severity+crew combo to avoid repeated warnings
                  const seen = new Set<string>();
                  const unique = tailImpacts.filter((imp) => {
                    const key = `${imp.severity}-${imp.affected_crew.map(c => c.name).sort().join(",")}`;
                    if (seen.has(key)) return false;
                    seen.add(key);
                    return true;
                  });
                  const shown = unique.slice(0, 3);
                  return (
                    <>
                      {shown.map((imp) => (
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
                      {unique.length > 3 && (
                        <div className="text-[10px] text-gray-400">+{unique.length - 3} more</div>
                      )}
                    </>
                  );
                })()}
              </div>
            )}

            {/* Wednesday flight legs for this tail */}
            {(() => {
              if (!flights || !selectedDate) return null;
              const wedStr = selectedDate.toISOString().slice(0, 10);
              const tailFlights = flights
                .filter((f) => f.tail_number === tail && f.scheduled_departure?.startsWith(wedStr))
                .sort((a, b) => (a.scheduled_departure ?? "").localeCompare(b.scheduled_departure ?? ""));
              if (tailFlights.length === 0) return null;

              const getTypeTag = (ft: string | null) => {
                if (!ft) return { label: "", cls: "text-gray-400 bg-gray-100" };
                const l = ft.toLowerCase();
                if (l.includes("charter") || l.includes("revenue")) return { label: "REV", cls: "text-blue-700 bg-blue-50" };
                if (l.includes("position") || l.includes("ferry")) return { label: "POS", cls: "text-amber-600 bg-amber-50" };
                if (l.includes("owner")) return { label: "OWN", cls: "text-emerald-700 bg-emerald-50" };
                if (l.includes("maint")) return { label: "MX", cls: "text-purple-600 bg-purple-50" };
                return { label: ft.slice(0, 3).toUpperCase(), cls: "text-gray-500 bg-gray-100" };
              };

              return (
                <div className="px-4 py-2 border-b bg-slate-50/80">
                  <div className="flex flex-wrap items-center gap-x-1 gap-y-1">
                    {tailFlights.map((f, i) => {
                      const depIcao = f.departure_icao;
                      const arrIcao = f.arrival_icao;
                      const depIata = depIcao?.length === 4 && depIcao.startsWith("K") ? depIcao.slice(1) : depIcao;
                      // Highlight legs added/changed since plan was saved
                      const isNewLeg = tailImpacts.length > 0 && f.id && tailImpacts.some((imp) =>
                        imp.affected_crew.some((c) => c.detail?.includes("New leg added"))
                      );
                      const arrIata = arrIcao?.length === 4 && arrIcao.startsWith("K") ? arrIcao.slice(1) : arrIcao;
                      const tag = getTypeTag(f.flight_type);
                      const isLive = tag.label === "REV" || tag.label === "OWN";
                      // All times in swap point timezone for consistency
                      const swapIcao = swapLoc.length === 3 ? `K${swapLoc}` : swapLoc;
                      // Show day label when the local display time is on a different calendar day
                      // (catches overnight legs stored as UTC that appear as prior-day local time)
                      const depDate = f.scheduled_departure ? new Date(f.scheduled_departure) : null;
                      const swapDateStr = selectedDate?.toISOString().slice(0, 10) ?? "";
                      const localDepDay = depDate ? depDate.toLocaleDateString(undefined, { weekday: "short" }).toUpperCase() : null;
                      const swapDay = selectedDate ? selectedDate.toLocaleDateString(undefined, { weekday: "short" }).toUpperCase() : null;
                      const isOtherDay = localDepDay && swapDay && localDepDay !== swapDay;
                      const dayLabel = isOtherDay ? localDepDay : null;
                      return (
                        <div key={f.id ?? i} className={`inline-flex items-center gap-1 ${isNewLeg ? "bg-yellow-100 px-1.5 py-0.5 rounded ring-1 ring-yellow-300" : ""} ${isOtherDay ? "opacity-50" : ""}`}>
                          {i > 0 && <span className="text-gray-300 mx-1">|</span>}
                          {isNewLeg && <span className="text-[8px] font-bold text-yellow-700">NEW</span>}
                          {dayLabel && <span className="text-[8px] font-bold text-indigo-500 mr-0.5">{dayLabel}</span>}
                          <span className={`font-mono text-xs font-bold ${isLive ? "text-gray-900" : "text-gray-400"}`}>{depIata}</span>
                          <span className="text-[10px] text-gray-400">{fmtShortTime(f.scheduled_departure, swapIcao)}</span>
                          <span className="text-gray-300">{"\u2192"}</span>
                          <span className={`font-mono text-xs font-bold ${isLive ? "text-gray-900" : "text-gray-400"}`}>{arrIata}</span>
                          <span className="text-[10px] text-gray-400">{fmtShortTime(f.scheduled_arrival, swapIcao)}</span>
                          <span className={`text-[9px] px-1 py-0.5 rounded font-medium ${tag.cls}`}>{tag.label}</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })()}

            {/* Crew grid: oncoming on left, offgoing on right */}
            <div className="grid grid-cols-2 divide-x">
              <div className="p-2 space-y-1">
                <div className="text-[10px] font-bold uppercase text-green-600 px-3 pb-1">Oncoming</div>
                <CrewSlot label="PIC" color="text-green-700" row={onPic} direction="oncoming" role="PIC" />
                <CrewSlot label="SIC" color="text-green-600" row={onSic} direction="oncoming" role="SIC" />
              </div>
              <div className="p-2 space-y-1">
                <div className="text-[10px] font-bold uppercase text-red-600 px-3 pb-1">Offgoing</div>
                <CrewSlot label="PIC" color="text-red-700" row={offPic} direction="offgoing" role="PIC" />
                <CrewSlot label="SIC" color="text-red-600" row={offSic} direction="offgoing" role="SIC" />
              </div>
            </div>

            {/* Rental handoff suggestions */}
            {(() => {
              // Check if oncoming has a rental and a matching offgoing at the same swap point has NO TRANSPORT
              // AND they're coming from / going to the same area (home airports overlap or within driving distance)
              const handoffs: { oncoming: string; offgoing: string; swapPt: string; homeArea: string }[] = [];
              const oncomingWithRental = [onPic, onSic].filter((r) => r && (r.travel_type === "rental_car" || r.travel_type === "drive"));
              const offgoingNoTransport = [offPic, offSic].filter((r) => r && r.travel_type === "none");

              for (const on of oncomingWithRental) {
                for (const off of offgoingNoTransport) {
                  if (!on || !off) continue;
                  // Must be at the same swap point
                  const onSp = on.swap_location ?? swapLoc;
                  const offSp = off.swap_location ?? swapLoc;
                  if (onSp !== offSp) continue;
                  // Check if they're from the same area (any home airport in common, or within 100mi)
                  const onHomes = new Set(on.home_airports.map((a) => a.toUpperCase()));
                  const offHomes = off.home_airports.map((a) => a.toUpperCase());
                  const sameArea = offHomes.some((h) => onHomes.has(h));
                  if (sameArea) {
                    handoffs.push({
                      oncoming: on.name,
                      offgoing: off.name,
                      swapPt: onSp,
                      homeArea: on.home_airports.join("/"),
                    });
                  }
                }
              }

              if (handoffs.length === 0) return null;
              return (
                <div className="px-4 py-1.5 bg-teal-50 border-t text-[10px] text-teal-700 space-y-0.5">
                  {handoffs.map((h, i) => (
                    <div key={i} className="flex items-center gap-1.5">
                      <span className="text-[9px] px-1 py-0.5 rounded bg-teal-100 text-teal-800 font-bold">RENTAL HANDOFF</span>
                      <span>{h.oncoming} (oncoming) rental → {h.offgoing} (offgoing) takes car back to {h.homeArea}</span>
                    </div>
                  ))}
                </div>
              );
            })()}

            {/* Offgoing "can't get home" warning */}
            {(() => {
              const offgoingStranded = [offPic, offSic].filter(
                (r) => r && r.name && r.travel_type === "none" && r.direction === "offgoing"
              );
              if (offgoingStranded.length === 0) return null;

              // Check if this is a late swap point (last leg) — offgoing may not have time for flights
              let lateSwapWarning = false;
              if (flights && selectedDate) {
                const wedStr = selectedDate.toISOString().slice(0, 10);
                const tailLegs = flights
                  .filter((f) => f.tail_number === tail && f.scheduled_departure?.startsWith(wedStr) && isLiveFlightType(f.flight_type))
                  .sort((a, b) => (a.scheduled_departure ?? "").localeCompare(b.scheduled_departure ?? ""));
                const lastLeg = tailLegs[tailLegs.length - 1];
                if (lastLeg?.scheduled_arrival) {
                  const arrHour = new Date(lastLeg.scheduled_arrival).getHours();
                  // If last leg arrives after 5pm local, offgoing may not catch a flight home
                  if (arrHour >= 17) lateSwapWarning = true;
                }
              }

              return (
                <div className="px-4 py-2 border-t bg-red-50 space-y-1">
                  {offgoingStranded.map((r) => (
                    <div key={r!.name} className="flex items-center gap-2 text-[11px]">
                      <span className="text-[9px] px-1.5 py-0.5 rounded font-bold bg-red-600 text-white">
                        NO WAY HOME
                      </span>
                      <span className="text-red-700 font-medium">
                        {r!.name} ({r!.role}) — no commercial flights found from {r!.swap_location ?? swapLoc} → {r!.home_airports.join("/")}
                      </span>
                    </div>
                  ))}
                  {lateSwapWarning && (
                    <div className="text-[10px] text-red-600">
                      Late swap point — aircraft arrives after 17:00, offgoing crew may miss last commercial flights
                    </div>
                  )}
                </div>
              );
            })()}

            {/* Repositioning warning: next leg departs from different airport than swap point */}
            {(() => {
              if (!flights || !selectedDate) return null;
              const wedStr = selectedDate.toISOString().slice(0, 10);
              const swapIcao = swapLoc.length === 3 ? `K${swapLoc}` : swapLoc;
              const tailLegs = flights
                .filter((f) => f.tail_number === tail && f.scheduled_departure?.startsWith(wedStr))
                .sort((a, b) => (a.scheduled_departure ?? "").localeCompare(b.scheduled_departure ?? ""));

              // Find the first leg that departs AFTER the swap point
              // If the swap point is at this airport, the next departure should also be from here
              const nextDep = tailLegs.find((f) => f.departure_icao !== swapIcao);
              if (!nextDep) return null;

              // Only warn if there's a leg FROM the swap point followed by a leg from elsewhere
              const legsFromSwap = tailLegs.filter((f) => f.departure_icao === swapIcao);
              const legsNotFromSwap = tailLegs.filter((f) => f.departure_icao !== swapIcao);
              if (legsFromSwap.length === 0 && legsNotFromSwap.length > 0) {
                const nextIata = nextDep.departure_icao?.length === 4 && nextDep.departure_icao.startsWith("K")
                  ? nextDep.departure_icao.slice(1) : nextDep.departure_icao;
                return (
                  <div className="px-4 py-1 border-t bg-orange-50 text-[10px] text-orange-700">
                    Aircraft repositions to {nextIata} before next leg — swap point may change if schedule updates
                  </div>
                );
              }
              return null;
            })()}

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

// ─── Crew Info Panel (CREW INFO Excel Data) ────────────────────────────────

function CrewInfoPanel({ data }: { data: CrewInfoData }) {
  const [showBadPairings, setShowBadPairings] = useState(true);
  const [showCheckairmen, setShowCheckairmen] = useState(false);
  const [showChecklist, setShowChecklist] = useState(false);
  const [showCalendar, setShowCalendar] = useState(false);
  const [showPicSwap, setShowPicSwap] = useState(false);

  const severityStyle: Record<string, string> = {
    severe: "bg-red-100 text-red-700 border-red-200",
    moderate: "bg-amber-100 text-amber-700 border-amber-200",
    minor: "bg-gray-100 text-gray-600 border-gray-200",
  };

  // Group checkairmen by rotation
  const caByRotation = new Map<string, typeof data.checkairmen>();
  for (const ca of data.checkairmen) {
    const key = ca.rotation === "A" ? "Rotation A" : ca.rotation === "B" ? "Rotation B" : "Other";
    if (!caByRotation.has(key)) caByRotation.set(key, []);
    caByRotation.get(key)!.push(ca);
  }

  // Build a lookup for checkairman types (merged across rotations)
  const caTypeLookup = new Map<string, { citation_x: boolean; challenger: boolean }>();
  for (const ca of data.checkairmen) {
    const existing = caTypeLookup.get(ca.name);
    if (existing) {
      if (ca.citation_x) existing.citation_x = true;
      if (ca.challenger) existing.challenger = true;
    } else {
      caTypeLookup.set(ca.name, { citation_x: ca.citation_x, challenger: ca.challenger });
    }
  }

  const CollapsibleSection = ({ title, count, open, toggle, children, color = "text-gray-700" }: {
    title: string; count?: number; open: boolean; toggle: () => void; children: React.ReactNode; color?: string;
  }) => (
    <div className="border-b border-gray-100 last:border-b-0">
      <button onClick={toggle} className="w-full px-3 py-2 text-left flex items-center justify-between hover:bg-gray-50/50 transition-colors">
        <div className="flex items-center gap-2">
          <span className={`text-[10px] font-bold uppercase tracking-wider ${color}`}>{title}</span>
          {count !== undefined && count > 0 && (
            <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-gray-100 text-gray-500">{count}</span>
          )}
        </div>
        <span className="text-[10px] text-gray-400">{open ? "\u25B2" : "\u25BC"}</span>
      </button>
      {open && <div className="px-3 pb-2.5">{children}</div>}
    </div>
  );

  return (
    <div className="rounded-lg border bg-white shadow-sm overflow-hidden">
      <div className="px-4 py-2.5 bg-indigo-50 border-b flex items-center gap-2">
        <span className="text-[10px] font-bold uppercase tracking-wider text-indigo-700">Crew Info</span>
        <span className="text-[9px] text-indigo-500">from Excel sync</span>
      </div>

      {/* Bad Pairings / Crew Conflicts */}
      <CollapsibleSection
        title="Crew Conflicts"
        count={data.bad_pairings.length}
        open={showBadPairings}
        toggle={() => setShowBadPairings(!showBadPairings)}
        color={data.bad_pairings.some(p => p.severity === "severe") ? "text-red-700" : "text-gray-700"}
      >
        {data.bad_pairings.length > 0 ? (
          <div className="space-y-1">
            {data.bad_pairings.map((bp, i) => (
              <div key={i} className={`flex items-center gap-2 px-2 py-1.5 rounded border text-[11px] ${severityStyle[bp.severity] ?? severityStyle.minor}`}>
                <span className={`text-[9px] px-1.5 py-0.5 rounded font-bold uppercase ${
                  bp.severity === "severe" ? "bg-red-200 text-red-800" : bp.severity === "moderate" ? "bg-amber-200 text-amber-800" : "bg-gray-200 text-gray-600"
                }`}>{bp.severity}</span>
                <span className="font-medium">{bp.pic}</span>
                <span className="text-gray-400">+</span>
                <span className="font-medium">{bp.sic}</span>
                {bp.notes && <span className="text-gray-500 truncate ml-1" title={bp.notes}>{bp.notes}</span>}
              </div>
            ))}
          </div>
        ) : (
          <div className="text-[11px] text-gray-400 py-1">No bad pairings on record.</div>
        )}
      </CollapsibleSection>

      {/* Checkairmen */}
      <CollapsibleSection
        title="Checkairmen"
        count={data.checkairmen.length}
        open={showCheckairmen}
        toggle={() => setShowCheckairmen(!showCheckairmen)}
        color="text-amber-700"
      >
        {Array.from(caByRotation.entries()).map(([group, members]) => (
          <div key={group} className="mb-1.5 last:mb-0">
            <div className="text-[9px] font-bold text-gray-400 uppercase mb-0.5">{group}</div>
            <div className="flex flex-wrap gap-1">
              {members.map((ca, i) => {
                const types = caTypeLookup.get(ca.name);
                const both = types?.citation_x && types?.challenger;
                const typeLabel = both ? "CA" : types?.citation_x ? "CA-CX" : types?.challenger ? "CA-CL" : "CA";
                return (
                  <span key={i} className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-amber-50 border border-amber-200 text-amber-700">
                    {ca.name}
                    <span className="text-[8px] font-bold bg-amber-200 text-amber-800 px-1 rounded">{typeLabel}</span>
                  </span>
                );
              })}
            </div>
          </div>
        ))}
      </CollapsibleSection>

      {/* Calendar — Oncoming Crew */}
      {data.target_week_crew && (
        <CollapsibleSection
          title="Oncoming Crew"
          open={showCalendar}
          toggle={() => setShowCalendar(!showCalendar)}
          color="text-purple-700"
        >
          <div className="text-[10px] text-gray-500 mb-1.5">
            {data.target_week_crew.date_range} (Rotation {data.target_week_crew.rotation})
          </div>
          {(["pic", "sic"] as const).map((role) => {
            const roleData = data.target_week_crew![role as "pic" | "sic"];
            const total = roleData.citation_x.length + roleData.challenger.length + roleData.dual.length;
            if (total === 0) return null;
            return (
              <div key={role} className="mb-1.5 last:mb-0">
                <div className="text-[9px] font-bold uppercase text-gray-400 mb-0.5">{role === "pic" ? "Captains" : "First Officers"} ({total})</div>
                <div className="flex flex-wrap gap-1">
                  {roleData.citation_x.map((n, i) => (
                    <span key={`cx-${i}`} className="text-[9px] px-1 py-0.5 rounded bg-green-50 border border-green-200 text-green-700">{n}</span>
                  ))}
                  {roleData.challenger.map((n, i) => (
                    <span key={`cl-${i}`} className="text-[9px] px-1 py-0.5 rounded bg-yellow-50 border border-yellow-200 text-yellow-700">{n}</span>
                  ))}
                  {roleData.dual.map((n, i) => (
                    <span key={`du-${i}`} className="text-[9px] px-1 py-0.5 rounded bg-purple-50 border border-purple-200 text-purple-700">{n}</span>
                  ))}
                </div>
              </div>
            );
          })}
        </CollapsibleSection>
      )}

      {/* PIC Swap Reference */}
      {data.pic_swap_table.length > 0 && (
        <CollapsibleSection
          title="PIC Swap Reference"
          count={data.pic_swap_table.filter(r => r.old_pic || r.new_pic).length}
          open={showPicSwap}
          toggle={() => setShowPicSwap(!showPicSwap)}
        >
          <div className="space-y-0.5">
            {data.pic_swap_table.filter(r => r.old_pic || r.new_pic).map((row, i) => (
              <div key={i} className="flex items-center gap-1.5 text-[10px] py-0.5">
                <span className="text-red-600 font-medium w-[90px] truncate" title={row.old_pic ?? ""}>{row.old_pic ?? "—"}</span>
                <span className="text-gray-400">{"\u2192"}</span>
                <span className="text-green-600 font-medium w-[90px] truncate" title={row.new_pic ?? ""}>{row.new_pic ?? "—"}</span>
                {row.tail && <span className="font-mono text-gray-500 text-[9px]">{row.tail}</span>}
              </div>
            ))}
          </div>
        </CollapsibleSection>
      )}
    </div>
  );
}

// ─── Bad Pairing Check Helper ─────────────────────────────────────────────

function findBadPairing(
  picName: string | null | undefined,
  sicName: string | null | undefined,
  badPairings: CrewInfoData["bad_pairings"],
): CrewInfoData["bad_pairings"][0] | null {
  if (!picName || !sicName || badPairings.length === 0) return null;
  const picNorm = picName.toLowerCase().trim();
  const sicNorm = sicName.toLowerCase().trim();
  return badPairings.find(
    (bp) => bp.pic.toLowerCase().trim() === picNorm && bp.sic.toLowerCase().trim() === sicNorm
  ) ?? null;
}

// ─── Main Component ──────────────────────────────────────────────────────────

export default function CrewSwap({ flights: parentFlights }: { flights: Flight[] }) {
  const [selectedDate, setSelectedDate] = useState<Date>(getNextWednesday());
  // Fetch flights covering the swap week (parent only has ±48hrs from today)
  const [swapWeekFlights, setSwapWeekFlights] = useState<Flight[]>([]);
  useEffect(() => {
    // Calculate hours from now to swap date + 1 day
    const hoursAhead = Math.max(48, Math.ceil((selectedDate.getTime() + 86400_000 - Date.now()) / 3600_000));
    const lookback = Math.max(48, Math.ceil((Date.now() - selectedDate.getTime() + 3 * 86400_000) / 3600_000));
    fetch(`/api/ops/flights?lookahead_hours=${hoursAhead}&lookback_hours=${lookback}`)
      .then((r) => r.ok ? r.json() : { flights: [] })
      .then((d) => setSwapWeekFlights(d.flights ?? []))
      .catch(() => {});
  }, [selectedDate]);

  // Merge parent flights (today ±48hr) with swap week flights, dedup by id
  const flights = useMemo(() => {
    const byId = new Map<string, Flight>();
    for (const f of parentFlights) byId.set(f.id, f);
    for (const f of swapWeekFlights) byId.set(f.id, f);
    return Array.from(byId.values());
  }, [parentFlights, swapWeekFlights]);

  const [crew, setCrew] = useState<CrewMember[]>([]);
  const [crewLoaded, setCrewLoaded] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadResult, setUploadResult] = useState<RosterUploadResult | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [showRoster, setShowRoster] = useState(false);
  const [optimizing, setOptimizing] = useState(false);
  const [swapPlan, setSwapPlan] = useState<SwapPlanResult | null>(null);
  const [optimizeError, setOptimizeError] = useState<string | null>(null);
  const [optimizeStatus, setOptimizeStatus] = useState<string | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [showSchedule, setShowSchedule] = useState(false);
  const swapPlanRef = useRef<HTMLDivElement>(null);
  const [exporting, setExporting] = useState(false);
  const [swapView, setSwapView] = useState<"role" | "aircraft" | "assign">("aircraft");
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
  // Gap detection (new airports + missing cache pairs)
  const [gapAlerts, setGapAlerts] = useState<{ newAirports: { icao: string; iata: string; suggested: string | null; suggestedIcao: string | null; distance: number | null; flights: number }[]; missingPairs: number } | null>(null);
  const [addedAliases, setAddedAliases] = useState<Set<string>>(new Set());
  const [addingAlias, setAddingAlias] = useState<string | null>(null);
  const [manualAliasInputs, setManualAliasInputs] = useState<Record<string, string>>({});
  const refreshGapAlerts = useCallback(() => {
    const wedStr = selectedDate.toISOString().slice(0, 10);
    fetch(`/api/crew/detect-gaps?swap_date=${wedStr}`)
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        if (!d) return;
        const newAirports = (d.airports?.new_airports ?? []).map((a: Record<string, unknown>) => ({
          icao: a.icao as string, iata: a.iata as string, suggested: (a.suggested_alias_iata as string) ?? null, suggestedIcao: (a.suggested_alias as string) ?? null, distance: (a.distance_miles as number) ?? null, flights: a.appears_in_flights as number,
        }));
        setGapAlerts({ newAirports, missingPairs: d.cache?.missing_pairs?.length ?? 0 });
      })
      .catch(() => {});
  }, [selectedDate]);
  useEffect(() => { refreshGapAlerts(); }, [refreshGapAlerts]);
  const iataToIcao = (iata: string) => {
    const u = iata.toUpperCase();
    if (u.length === 4) return u;
    return `K${u}`;
  };
  /** Save one or more commercial airport aliases for an FBO.
   *  Single: handleAddAlias("KVNY", "BUR")
   *  Multiple: handleAddAlias("KVNY", "BUR,LAX,SNA") */
  const handleAddAlias = async (fboIcao: string, commercialIata: string, commercialIcao?: string | null) => {
    // Support comma-separated for multiple aliases
    const iataList = commercialIata.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
    const icaoList = iataList.map((iata) => commercialIcao ?? (iata.length === 3 ? `K${iata}` : iata));

    setAddingAlias(fboIcao);
    try {
      const res = await fetch("/api/crew/airport-aliases", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fbo_icao: fboIcao,
          commercial_icaos: icaoList,
          preferred_icao: icaoList[0],
        }),
      });
      if (res.ok) {
        setAddedAliases(prev => new Set(prev).add(fboIcao));
        addToast("success", `Alias saved: ${fboIcao} → ${icaoList.join(", ")}`);
        setTimeout(refreshGapAlerts, 500);
      } else {
        const err = await res.json().catch(() => ({}));
        addToast("error", `Failed to save alias: ${err.error ?? res.statusText}`);
      }
    } catch (e) {
      addToast("error", `Failed to save alias: ${e instanceof Error ? e.message : "unknown error"}`);
    }
    setAddingAlias(null);
  };
  // Excluded tails (MX, owner-flown, etc.)
  const [excludedTails, setExcludedTails] = useState<Set<string>>(new Set());
  // ICS fleet (all tails from ics_sources)
  const [icsFleet, setIcsFleet] = useState<{ label: string; aircraft_type: string }[]>([]);
  useEffect(() => {
    fetch("/api/admin/ics-sources")
      .then((r) => r.ok ? r.json() : { sources: [] })
      .then((d) => setIcsFleet((d.sources ?? []).map((s: Record<string, unknown>) => ({ label: s.label as string, aircraft_type: s.aircraft_type as string }))))
      .catch(() => {});
  }, []);
  // Added tails (uncrewed aircraft added to the swap plan)
  const [addedTails, setAddedTails] = useState<{ tail: string; type: string; location: string }[]>([]);
  // Required crew pairings (CA + trainee on same tail)
  const [requiredPairings, setRequiredPairings] = useState<{ pic: string; sic: string; reason: string }[]>([]);
  const [pairingCrewFilter, setPairingCrewFilter] = useState("");
  const [batchPairingSics, setBatchPairingSics] = useState<Set<string>>(new Set());
  // Coordinator constraints (force tail, force pair, force fleet)
  const [swapConstraints, setSwapConstraints] = useState<SwapConstraint[]>([]);
  // Slack directive suggestions (from AI scan of swap chat)
  const [slackSuggestions, setSlackSuggestions] = useState<(SwapConstraint & { _reason?: string })[]>([]);
  const [slackScanLoading, setSlackScanLoading] = useState(false);
  const [slackScanError, setSlackScanError] = useState<string | null>(null);

  // Review tab: crew overrides
  const [airportOverrides, setAirportOverrides] = useState<Record<string, string>>({}); // crew name → temp airport
  const [unavailableCrew, setUnavailableCrew] = useState<Set<string>>(new Set());
  const [reviewChecks, setReviewChecks] = useState<Record<string, boolean>>({
    roster_reviewed: false,
    airports_reviewed: false,
    volunteers_reviewed: false,
    exclusions_reviewed: false,
    calendar_reviewed: false,
  });
  // Phase 5-6: Strategy
  const [strategy, setStrategy] = useState<"offgoing_first" | "oncoming_first">("offgoing_first");
  // Day selector: per-tail day assignment and multi-day planning
  const [selectedSwapDays, setSelectedSwapDays] = useState<SwapDay[]>(["wednesday"]);
  const [tailSwapDays, setTailSwapDays] = useState<Record<string, SwapDay>>({});
  const [activePlanDay, setActivePlanDay] = useState<SwapDay>("wednesday"); // which day's plan is shown
  const [dayPlans, setDayPlans] = useState<Record<string, SwapPlanResult>>({});
  // Legacy aliases for backwards compat
  const tuesdayPlan = dayPlans["tuesday"] ?? null;
  const wednesdayPlan = dayPlans["wednesday"] ?? null;
  // Daily pairs are now managed as force_pair constraints with day field in swapConstraints
  // Tabs
  const [activeTab, setActiveTab] = useState<"setup" | "review" | "plan" | "impacts">("setup");
  // Toasts
  const [toasts, setToasts] = useState<Toast[]>([]);
  const addToast = useCallback((type: Toast["type"], msg: string) => {
    const id = ++_toastId;
    setToasts((prev) => [...prev, { id, type, msg }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 4000);
  }, []);
  const removeToast = useCallback((id: number) => setToasts((prev) => prev.filter((t) => t.id !== id)), []);
  // Locked tails (manual assignments the optimizer won't touch)
  const [lockedTails, setLockedTails] = useState<Set<string>>(new Set());
  // Crew Info data from Excel sync
  const [crewInfoData, setCrewInfoData] = useState<CrewInfoData | null>(null);
  // Google Sheets week selector
  const [availableWeeks, setAvailableWeeks] = useState<string[]>([]);
  const [selectedWeek, setSelectedWeek] = useState<string>("");
  // Sheet validation state
  const [sheetValidation, setSheetValidation] = useState<ValidationResult | null>(null);
  // Name resolution state
  const [syncCounter, setSyncCounter] = useState(0);
  const [showAliasAdmin, setShowAliasAdmin] = useState(false);
  // FREEZE sheet import
  const [freezeTabs, setFreezeTabs] = useState<string[]>([]);
  const [loadingFreeze, setLoadingFreeze] = useState(false);
  const [showFreezeMenu, setShowFreezeMenu] = useState(false);
  const freezeMenuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    fetch("/api/crew/sheet-weeks").then(r => r.ok ? r.json() : { weeks: [] }).then(d => {
      setAvailableWeeks(d.weeks ?? []);
      setFreezeTabs(d.freeze_tabs ?? []);
      // Default to most recent week (first in list)
      if (d.weeks?.length > 0 && !selectedWeek) setSelectedWeek(d.weeks[0]);
    }).catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Close freeze menu on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (freezeMenuRef.current && !freezeMenuRef.current.contains(e.target as Node)) {
        setShowFreezeMenu(false);
      }
    }
    if (showFreezeMenu) document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [showFreezeMenu]);
  const [syncingCrewInfo, setSyncingCrewInfo] = useState(false);

  // Aircraft type lookup: derived from icsFleet (already fetched above — no duplicate call)
  const tailAircraftTypes = useMemo(() => {
    const map: Record<string, string> = {};
    for (const s of icsFleet) {
      if (s.label && s.aircraft_type) map[s.label] = s.aircraft_type;
    }
    return map;
  }, [icsFleet]);

  // Flight picker modal state
  const [selectedCrewSlot, setSelectedCrewSlot] = useState<{
    tailNumber: string;
    role: "PIC" | "SIC";
    direction: "oncoming" | "offgoing";
    crewMemberId: string;
    crewName: string;
    homeAirports: string[];
    swapLocation: string;
    firstLegDep?: string | null;
    lastLegArr?: string | null;
  } | null>(null);

  function handleFlightSelection(selection: FlightPickerSelection) {
    if (!swapPlan || !selectedCrewSlot) return;
    const { tailNumber, role, direction } = selectedCrewSlot;

    // Compute duty_off_time based on direction
    let dutyOffTime: string | null = null;
    if (direction === "oncoming") {
      // Oncoming crew: duty ends at last leg arrival for this tail
      dutyOffTime = selectedCrewSlot.lastLegArr ?? null;
    } else {
      // Offgoing crew: duty ends when they arrive home (commercial flight arrival)
      dutyOffTime = selection.arrival_time ?? null;
    }

    // Calculate crew rest for day-before positioning
    const isDayBefore = selection.is_day_before ?? false;
    let crewRestHours: number | undefined;
    if (isDayBefore && selection.arrival_time && selectedCrewSlot.firstLegDep) {
      const arrMs = new Date(selection.arrival_time).getTime();
      const depMs = new Date(selectedCrewSlot.firstLegDep).getTime();
      crewRestHours = Math.round(((depMs - arrMs) / (1000 * 60 * 60)) * 10) / 10;
    }

    setSwapPlan((prev) => {
      if (!prev) return prev;
      const newRows = prev.rows.map((r) => {
        if (r.tail_number !== tailNumber || r.role !== role || r.direction !== direction) return r;
        const dayBeforeWarnings: string[] = [];
        if (isDayBefore) {
          dayBeforeWarnings.push(`Day-before positioning${crewRestHours != null ? ` — ${crewRestHours}hr crew rest` : ""}`);
          if (crewRestHours != null && crewRestHours < 10) {
            dayBeforeWarnings.push(`⚠ Crew rest ${crewRestHours}hr may be below minimum`);
          }
        }
        return {
          ...r,
          swap_location: selectedCrewSlot.swapLocation || r.swap_location,
          travel_type: selection.type as CrewSwapRow["travel_type"],
          flight_number: selection.flight_number,
          departure_time: selection.departure_time,
          arrival_time: selection.arrival_time,
          travel_from: selection.travel_from,
          travel_to: selection.travel_to,
          cost_estimate: selection.cost_estimate,
          duration_minutes: selection.duration_minutes,
          available_time: selection.available_time,
          duty_on_time: isDayBefore ? null : selection.duty_on_time, // day-before: duty starts next day, not travel day
          duty_off_time: dutyOffTime,
          backup_flight: selection.backup_flight,
          is_day_before: isDayBefore,
          crew_rest_hours: crewRestHours,
          warnings: dayBeforeWarnings,
          notes: isDayBefore ? `Day before${selection.date_label ?? ""} — manually selected` : "Manually selected transport",
        };
      });

      const newCost = newRows.reduce((s, r) => s + (r.cost_estimate ?? 0), 0);
      return { ...prev, rows: newRows, total_cost: newCost };
    });

    setSelectedCrewSlot(null);
    addToast("success", `Transport updated for ${selectedCrewSlot.crewName} on ${tailNumber}${isDayBefore ? " (day before)" : ""}`);
  }

  async function handleSwapPointChange(tail: string, newSwapPoint: string) {
    if (!swapPlan) return;

    // Get crew assignments for this tail
    const tailRows = swapPlan.rows.filter((r) => r.tail_number === tail);
    const crewRows = tailRows.filter((r) => r.name); // only rows with assigned crew

    if (crewRows.length === 0) {
      // No crew assigned — just update swap_location
      setSwapPlan((prev) => {
        if (!prev) return prev;
        const newRows = prev.rows.map((r) => r.tail_number === tail ? { ...r, swap_location: newSwapPoint } : r);
        return { ...prev, rows: newRows };
      });
      addToast("success", `${tail} swap point changed to ${newSwapPoint}`);
      return;
    }

    addToast("warning", `Recomputing transport for ${tail} @ ${newSwapPoint}...`);

    // Immediately show "searching..." state for all crew on this tail
    setSwapPlan((prev) => {
      if (!prev) return prev;
      const newRows = prev.rows.map((r) => {
        if (r.tail_number !== tail) return r;
        return {
          ...r,
          swap_location: newSwapPoint,
          travel_type: "none" as const,
          flight_number: null,
          departure_time: null,
          arrival_time: null,
          available_time: null,
          duty_on_time: null,
          duty_off_time: null,
          cost_estimate: null,
          duration_minutes: null,
          backup_flight: null,
          warnings: [],
          notes: `Searching flights to ${newSwapPoint}...`,
        };
      });
      return { ...prev, rows: newRows };
    });

    // Get tail flight times
    const swapDateStr = selectedDate.toISOString().slice(0, 10);
    const tailFlightsSorted = flights.filter((f) =>
      f.tail_number === tail && f.scheduled_departure?.startsWith(swapDateStr)
    ).sort((a, b) => (a.scheduled_departure ?? "").localeCompare(b.scheduled_departure ?? ""));
    const firstLegDep = tailFlightsSorted[0]?.scheduled_departure ?? null;
    const lastLegArr = tailFlightsSorted[tailFlightsSorted.length - 1]?.scheduled_arrival ?? null;

    const destIcao = newSwapPoint.length === 3 ? `K${newSwapPoint}` : newSwapPoint;

    try {
      // Fetch transport options for ALL crew on this tail in parallel
      const results = await Promise.all(
        crewRows.map(async (row) => {
          const crewMember = crew.find((c) => c.name === row.name && c.role === row.role)
            ?? crew.find((c) => c.name === row.name);
          if (!crewMember) return { row, best: null };

          const params = new URLSearchParams({
            crew_member_id: crewMember.id,
            destination_icao: destIcao,
            swap_date: swapDateStr,
            direction: row.direction,
          });
          if (firstLegDep) params.set("first_leg_dep", firstLegDep);
          if (lastLegArr) params.set("last_leg_arr", lastLegArr);

          try {
            const res = await fetch(`/api/crew/transport-options?${params}`);
            if (!res.ok) return { row, best: null };
            const data = await res.json();
            const options = (data.options ?? []) as Array<{
              type: string; flight_number: string | null; depart_at: string | null;
              arrive_at: string | null; fbo_arrive_at: string | null; duty_on_at: string | null;
              cost_estimate: number; duration_minutes: number | null; backup_flight: string | null;
              score: number; feasibility: { duty_hours: number | null; duty_ok: boolean };
            }>;
            const feasible = options.filter(o => o.feasibility.duty_ok);
            const best = feasible.length > 0
              ? feasible.reduce((a, b) => a.score >= b.score ? a : b)
              : options.length > 0 ? options.reduce((a, b) => a.score >= b.score ? a : b) : null;
            return { row, best };
          } catch {
            return { row, best: null };
          }
        })
      );

      // Apply results
      setSwapPlan((prev) => {
        if (!prev) return prev;
        const newRows = prev.rows.map((r) => {
          if (r.tail_number !== tail) return r;
          const match = results.find((res) =>
            res.row.name === r.name && res.row.direction === r.direction && res.row.role === r.role
          );
          if (!match) return { ...r, swap_location: newSwapPoint };

          if (match.best) {
            const bo = match.best;
            return {
              ...r,
              swap_location: newSwapPoint,
              travel_type: bo.type as CrewSwapRow["travel_type"],
              flight_number: bo.flight_number,
              departure_time: bo.depart_at,
              arrival_time: bo.arrive_at,
              available_time: bo.fbo_arrive_at,
              duty_on_time: bo.duty_on_at,
              duty_off_time: r.direction === "oncoming" ? lastLegArr : (bo.arrive_at ?? null),
              cost_estimate: bo.cost_estimate,
              duration_minutes: bo.duration_minutes,
              backup_flight: bo.backup_flight,
              warnings: !bo.feasibility.duty_ok ? ["Duty day exceeds limit"] : [],
              notes: `Auto-selected best option to ${newSwapPoint}`,
            };
          }
          return {
            ...r,
            swap_location: newSwapPoint,
            travel_type: "none" as const,
            flight_number: null,
            departure_time: null,
            arrival_time: null,
            available_time: null,
            duty_on_time: null,
            duty_off_time: null,
            cost_estimate: null,
            duration_minutes: null,
            backup_flight: null,
            warnings: ["No transport found for new swap point"],
            notes: `No flights found to ${newSwapPoint}`,
          };
        });
        const newCost = newRows.reduce((s, r) => s + (r.cost_estimate ?? 0), 0);
        return { ...prev, rows: newRows, total_cost: newCost };
      });

      const solved = results.filter(r => r.best).length;
      const totalCost = results.reduce((s, r) => s + (r.best?.cost_estimate ?? 0), 0);
      addToast("success", `${tail} @ ${newSwapPoint}: ${solved}/${results.length} crew solved, $${totalCost.toLocaleString()}`);
    } catch (e) {
      addToast("error", `Recompute failed: ${e instanceof Error ? e.message : "unknown"}`);
    }
  }

  async function handleCrewSwapPointChange(tail: string, role: "PIC" | "SIC", direction: "oncoming" | "offgoing", row: CrewSwapRow, newSwapPoint: string) {
    if (!swapPlan) return;

    // Immediately update the row to show "searching..." state
    setSwapPlan((prev) => {
      if (!prev) return prev;
      const newRows = prev.rows.map((r) => {
        if (r.tail_number !== tail || r.name !== row.name || r.direction !== direction) return r;
        return {
          ...r,
          swap_location: newSwapPoint,
          travel_type: "none" as const,
          flight_number: null,
          departure_time: null,
          arrival_time: null,
          available_time: null,
          duty_on_time: null,
          cost_estimate: null,
          duration_minutes: null,
          backup_flight: null,
          warnings: [],
          notes: `Searching flights to ${newSwapPoint}...`,
        };
      });
      return { ...prev, rows: newRows };
    });

    // Look up crew member for the API call
    const crewMember = crew.find((c) => c.name === row.name && c.role === role)
      ?? crew.find((c) => c.name === row.name);
    if (!crewMember) {
      addToast("error", `Crew member "${row.name}" not found in roster`);
      return;
    }

    try {
      // Fetch transport options for this crew at the new swap point
      const swapDateStr = selectedDate.toISOString().slice(0, 10);
      const tailFlights = flights.filter((f) =>
        f.tail_number === tail && f.scheduled_departure?.startsWith(swapDateStr)
      ).sort((a, b) => (a.scheduled_departure ?? "").localeCompare(b.scheduled_departure ?? ""));
      const firstLegDep = tailFlights[0]?.scheduled_departure ?? null;
      const lastLegArr = tailFlights[tailFlights.length - 1]?.scheduled_arrival ?? null;

      const params = new URLSearchParams({
        crew_member_id: crewMember.id,
        destination_icao: newSwapPoint.length === 3 ? `K${newSwapPoint}` : newSwapPoint,
        swap_date: swapDateStr,
        direction,
      });
      if (firstLegDep) params.set("first_leg_dep", firstLegDep);
      if (lastLegArr) params.set("last_leg_arr", lastLegArr);

      const res = await fetch(`/api/crew/transport-options?${params}`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }

      let data = await res.json();
      type TransportOpt = {
        type: string; flight_number: string | null; depart_at: string | null;
        arrive_at: string | null; fbo_arrive_at: string | null; duty_on_at: string | null;
        cost_estimate: number; duration_minutes: number | null; backup_flight: string | null;
        origin_iata: string; destination_iata: string | null; score: number;
        feasibility: { duty_hours: number | null; duty_ok: boolean };
      };

      // If flights weren't seeded for this airport, seed on-demand and retry
      if (data.flights_not_seeded && data.unseeded_pairs?.length > 0) {
        setSwapPlan((prev) => {
          if (!prev) return prev;
          return { ...prev, rows: prev.rows.map((r) =>
            r.tail_number === tail && r.name === row.name && r.direction === direction
              ? { ...r, notes: `Seeding flights to ${newSwapPoint}... (first time lookup)` }
              : r,
          )};
        });

        try {
          const seedRes = await fetch("/api/crew/seed-flights", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ swap_date: swapDateStr, pairs: data.unseeded_pairs }),
          });
          if (seedRes.ok) {
            // Retry transport-options now that flights are cached
            const retryRes = await fetch(`/api/crew/transport-options?${params}`);
            if (retryRes.ok) {
              data = await retryRes.json();
            }
          }
        } catch {
          // Seeding failed — continue with ground-only options
        }
      }

      const options = (data.options ?? []) as TransportOpt[];

      // Pick the best feasible option (highest score, duty_ok)
      const feasible = options.filter(o => o.feasibility.duty_ok);
      const best = feasible.length > 0
        ? feasible.reduce((a, b) => a.score >= b.score ? a : b)
        : options.length > 0 ? options.reduce((a, b) => a.score >= b.score ? a : b) : null;

      // Compute duty_off_time: oncoming = last leg arrival, offgoing = commercial arrival home
      const bestDutyOff = best
        ? (direction === "oncoming" ? lastLegArr : best.arrive_at)
        : null;

      setSwapPlan((prev) => {
        if (!prev) return prev;
        const newRows = prev.rows.map((r) => {
          if (r.tail_number !== tail || r.name !== row.name || r.direction !== direction) return r;
          if (best) {
            return {
              ...r,
              swap_location: newSwapPoint,
              travel_type: best.type as CrewSwapRow["travel_type"],
              flight_number: best.flight_number,
              departure_time: best.depart_at,
              arrival_time: best.arrive_at,
              available_time: best.fbo_arrive_at,
              duty_on_time: best.duty_on_at,
              duty_off_time: bestDutyOff,
              cost_estimate: best.cost_estimate,
              duration_minutes: best.duration_minutes,
              backup_flight: best.backup_flight,
              warnings: !best.feasibility.duty_ok ? ["Duty day exceeds limit"] : [],
              notes: `Auto-selected best option to ${newSwapPoint}`,
            };
          }
          return {
            ...r,
            swap_location: newSwapPoint,
            travel_type: "none" as const,
            flight_number: null,
            departure_time: null,
            arrival_time: null,
            available_time: null,
            duty_on_time: null,
            duty_off_time: null,
            cost_estimate: null,
            duration_minutes: null,
            backup_flight: null,
            warnings: ["No transport found for new swap point"],
            notes: `No flights found to ${newSwapPoint}`,
          };
        });
        const newCost = newRows.reduce((s, r) => s + (r.cost_estimate ?? 0), 0);
        return { ...prev, rows: newRows, total_cost: newCost };
      });

      if (best) {
        addToast("success", `${row.name} → ${newSwapPoint}: ${best.flight_number ?? best.type} $${best.cost_estimate}`);
      } else {
        addToast("warning", `No transport found for ${row.name} → ${newSwapPoint}`);
      }
    } catch (e) {
      addToast("error", `Transport search failed: ${e instanceof Error ? e.message : "unknown"}`);
    }
  }

  function openFlightPicker(tail: string, role: "PIC" | "SIC", direction: "oncoming" | "offgoing", row: CrewSwapRow) {
    // Look up crew member ID from crew roster by name (try exact role first, then any role)
    const crewMember = crew.find((c) => c.name === row.name && c.role === role)
      ?? crew.find((c) => c.name === row.name);
    if (!crewMember) {
      addToast("error", `Crew member "${row.name}" not found in roster`);
      return;
    }

    // If swap_location was changed via per-crew dropdown, persist cleared state immediately
    // This clears stale flight data so the user sees the row is pending new transport
    if (row.swap_location) {
      setSwapPlan((prev) => {
        if (!prev) return prev;
        const newRows = prev.rows.map((r) => {
          if (r.tail_number === tail && r.name === row.name && r.direction === direction && r.swap_location !== row.swap_location) {
            return {
              ...r,
              swap_location: row.swap_location,
              // Clear stale transport when swap airport changes
              flight_number: row.flight_number,
              departure_time: row.departure_time,
              arrival_time: row.arrival_time,
              available_time: row.available_time,
              duty_on_time: row.duty_on_time,
              cost_estimate: row.cost_estimate,
              duration_minutes: row.duration_minutes,
              travel_type: row.travel_type,
              backup_flight: row.backup_flight,
              alt_flights: row.alt_flights,
              warnings: row.warnings,
              notes: row.notes,
            };
          }
          return r;
        });
        const newCost = newRows.reduce((s, r) => s + (r.cost_estimate ?? 0), 0);
        return { ...prev, rows: newRows, total_cost: newCost };
      });
    }

    // Get first/last leg times for this tail on swap day
    const swapDateStr = selectedDate.toISOString().slice(0, 10);
    const tailFlights = flights.filter((f) =>
      f.tail_number === tail &&
      f.scheduled_departure?.startsWith(swapDateStr)
    ).sort((a, b) => (a.scheduled_departure ?? "").localeCompare(b.scheduled_departure ?? ""));

    const firstLegDep = tailFlights[0]?.scheduled_departure ?? null;
    const lastLegArr = tailFlights[tailFlights.length - 1]?.scheduled_arrival ?? null;

    setSelectedCrewSlot({
      tailNumber: tail,
      role,
      direction,
      crewMemberId: crewMember.id,
      crewName: row.name,
      homeAirports: row.home_airports,
      swapLocation: row.swap_location ?? "",
      firstLegDep,
      lastLegArr,
    });
  }

  function toggleLockTail(tail: string) {
    setLockedTails((prev) => {
      const next = new Set(prev);
      if (next.has(tail)) next.delete(tail); else next.add(tail);
      return next;
    });
  }

  function assignCrew(tail: string, role: "PIC" | "SIC", name: string | null) {
    if (!swapPlan) return;
    setSwapPlan((prev) => {
      if (!prev) return prev;
      const newRows = [...prev.rows];

      if (name === null) {
        // Unassign: remove the oncoming row for this tail+role
        const idx = newRows.findIndex((r) => r.tail_number === tail && r.role === role && r.direction === "oncoming");
        if (idx >= 0) newRows.splice(idx, 1);
      } else {
        // If pulling from another tail, clear that tail's assignment first
        const prevIdx = newRows.findIndex((r) => r.name === name && r.role === role && r.direction === "oncoming" && r.tail_number !== tail);
        if (prevIdx >= 0) {
          const prevTail = newRows[prevIdx].tail_number;
          newRows.splice(prevIdx, 1);
          console.log(`[CrossTail] Pulled ${name} from ${prevTail} → ${tail}`);
        }

        // Find the pool entry for context
        const poolEntry = (role === "PIC" ? oncomingPool?.pic : oncomingPool?.sic)?.find((p) => p.name === name);
        const existing = newRows.findIndex((r) => r.tail_number === tail && r.role === role && r.direction === "oncoming");
        const offRow = newRows.find((r) => r.tail_number === tail && r.direction === "offgoing");

        const newRow: CrewSwapRow = {
          name,
          home_airports: poolEntry?.home_airports ?? [],
          role,
          direction: "oncoming",
          aircraft_type: offRow?.aircraft_type ?? "unknown",
          tail_number: tail,
          swap_location: offRow?.swap_location ?? null,
          all_swap_points: offRow?.all_swap_points,
          travel_type: "none",
          flight_number: null,
          departure_time: null,
          arrival_time: null,
          travel_from: null,
          travel_to: null,
          cost_estimate: null,
          duration_minutes: null,
          available_time: null,
          duty_on_time: null,
          duty_off_time: null,
          is_checkairman: poolEntry?.is_checkairman ?? false,
          checkairman_types: [],
          is_skillbridge: poolEntry?.is_skillbridge ?? false,
          grade: 3,
          volunteer_status: null,
          notes: "Manually assigned",
          warnings: ["Manual assignment — transport not calculated"],
          alt_flights: [],
          backup_flight: null,
          score: 0,
          confirmed: false,
        };

        if (existing >= 0) {
          newRows[existing] = newRow;
        } else {
          newRows.push(newRow);
        }
      }

      return { ...prev, rows: newRows };
    });

    // Auto-lock the tail when manually assigning
    if (name !== null) {
      setLockedTails((prev) => new Set(prev).add(tail));
      // Check if this was a cross-tail pull
      const pulledFrom = swapPlan?.rows.find((r) => r.name === name && r.role === role && r.direction === "oncoming" && r.tail_number !== tail);
      if (pulledFrom) {
        addToast("warning", `${name} pulled from ${pulledFrom.tail_number} → ${tail} (both tails updated)`);
      } else {
        addToast("success", `${name} assigned to ${tail} (locked)`);
      }
    }
  }

  /** Manual override of FBO arrival time for ground transport rows.
   *  Auto-calculates departure-from-home = FBO arrival - travel duration - 90min buffer. */
  function handleArrivalOverride(tail: string, role: "PIC" | "SIC", direction: "oncoming" | "offgoing", newTimeHHMM: string) {
    if (!swapPlan) return;
    setSwapPlan((prev) => {
      if (!prev) return prev;
      const newRows = prev.rows.map((r) => {
        if (r.tail_number !== tail || r.role !== role || r.direction !== direction) return r;
        // Build a new ISO timestamp using the existing date but overridden HH:MM
        const base = r.available_time ?? r.arrival_time ?? r.departure_time;
        if (!base) return r;
        const d = new Date(base);
        const [hh, mm] = newTimeHHMM.split(":").map(Number);
        d.setHours(hh, mm, 0, 0);
        const fboArrivalIso = d.toISOString();

        // Calculate departure from home: FBO arrival - travel time - 90min buffer
        const FBO_BUFFER_MIN = 90;
        const travelMin = r.duration_minutes ?? 60;
        const departHome = new Date(d.getTime() - (travelMin + FBO_BUFFER_MIN) * 60000);
        const departIso = departHome.toISOString();
        const departHH = String(departHome.getHours()).padStart(2, "0");
        const departMM = String(departHome.getMinutes()).padStart(2, "0");

        return {
          ...r,
          available_time: fboArrivalIso,
          arrival_time: fboArrivalIso,
          departure_time: departIso,
          notes: `FBO arrival ${newTimeHHMM} → depart home ${departHH}:${departMM} (${travelMin}min travel + 90min buffer)`,
        };
      });
      return { ...prev, rows: newRows };
    });
  }

  // ─── Confirm/tentative toggles ──────────────────────────────────────────
  /** Toggle a single row's confirmed status */
  function toggleConfirmRow(tail: string, role: "PIC" | "SIC", direction: "oncoming" | "offgoing") {
    setSwapPlan((prev) => {
      if (!prev) return prev;
      const newRows = prev.rows.map((r) => {
        if (r.tail_number === tail && r.role === role && r.direction === direction && r.travel_type !== "none") {
          return { ...r, confirmed: !r.confirmed };
        }
        return r;
      });
      return { ...prev, rows: newRows };
    });
  }

  /** Confirm all crew on a specific tail */
  function confirmTail(tail: string) {
    setSwapPlan((prev) => {
      if (!prev) return prev;
      const newRows = prev.rows.map((r) => {
        if (r.tail_number === tail && r.travel_type !== "none") {
          return { ...r, confirmed: true };
        }
        return r;
      });
      return { ...prev, rows: newRows };
    });
  }

  /** Confirm all rows that have transport (travel_type !== "none") */
  function confirmAll() {
    setSwapPlan((prev) => {
      if (!prev) return prev;
      const newRows = prev.rows.map((r) => {
        if (r.travel_type !== "none") return { ...r, confirmed: true };
        return r;
      });
      return { ...prev, rows: newRows };
    });
  }

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
      link.download = `swap-plan-${selectedDate.toISOString().slice(0, 10)}.png`;
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
    XLSX.writeFile(wb, `swap-plan-${selectedDate.toISOString().slice(0, 10)}.xlsx`);
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
      const dateStr = selectedDate.toISOString().slice(0, 10);
      const res = await fetch(`/api/crew/routes?date=${dateStr}`);
      if (!res.ok) return;
      const data = await res.json();
      setRouteStatus(data);
    } catch {
      // ignore
    }
  }, [selectedDate]);

  useEffect(() => {
    loadRouteStatus();
  }, [loadRouteStatus]);

  // Load volunteer preferences for selected Wednesday
  const loadVolunteers = useCallback(async () => {
    try {
      const dateStr = selectedDate.toISOString().slice(0, 10);
      const res = await fetch(`/api/crew/volunteers?swap_date=${dateStr}`);
      if (!res.ok) return;
      const data = await res.json();
      setVolunteers(data.volunteers ?? []);
    } catch { /* ignore */ }
  }, [selectedDate]);

  useEffect(() => { loadVolunteers(); }, [loadVolunteers]);

  // Load swap points
  const loadSwapPoints = useCallback(async () => {
    setLoadingSwapPoints(true);
    try {
      const dateStr = selectedDate.toISOString().slice(0, 10);
      const res = await fetch(`/api/crew/swap-points?swap_date=${dateStr}`);
      if (!res.ok) return;
      const data = await res.json();
      setSwapPoints(data.tails ?? []);
    } catch { /* ignore */ }
    finally { setLoadingSwapPoints(false); }
  }, [selectedDate]);

  // Load flight change alerts
  const loadAlerts = useCallback(async () => {
    try {
      const dateStr = selectedDate.toISOString().slice(0, 10);
      const res = await fetch(`/api/crew/swap-alerts?swap_date=${dateStr}`);
      if (!res.ok) return;
      const data = await res.json();
      setSwapAlerts(data.alerts ?? []);
      setAlertCount(data.unacknowledged_count ?? 0);
    } catch { /* ignore */ }
  }, [selectedDate]);

  useEffect(() => { loadAlerts(); }, [loadAlerts]);

  // Parse volunteer thread on-demand
  async function parseVolunteers() {
    setParsingVolunteers(true);
    try {
      const res = await fetch("/api/crew/volunteers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ swap_date: selectedDate.toISOString().slice(0, 10) }),
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
      const dateStr = selectedDate.toISOString().slice(0, 10);
      const res = await fetch(`/api/crew/swap-plan?swap_date=${dateStr}`);
      if (!res.ok) return;
      const data = await res.json();
      if (data.plan) {
        const plan = data.plan as SavedPlan;
        // Backfill confirmed field for old plans that don't have it
        if (plan.plan_data?.rows) {
          for (const row of plan.plan_data.rows) {
            if (row.confirmed === undefined) row.confirmed = false;
          }
        }
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
  }, [selectedDate]);

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
          swap_date: selectedDate.toISOString().slice(0, 10),
          plan_data: { ...swapPlan, constraints: swapConstraints.length > 0 ? swapConstraints : undefined },
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
        // Server-side: run analysis to update DB, then fetch full results with suggestions
        await fetch("/api/crew/swap-plan/impact", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ swap_date: selectedDate.toISOString().slice(0, 10) }),
        });
        // Now fetch full impact list (includes suggestions + resolution tracking)
        const getRes = await fetch(`/api/crew/swap-plan/impact?swap_date=${selectedDate.toISOString().slice(0, 10)}`);
        if (getRes.ok) {
          const data = await getRes.json();
          setPlanImpacts(data.impacts?.map((imp: PlanImpact & { id?: string; swap_leg_alerts?: { detected_at?: string } }, i: number) => ({
            ...imp,
            id: imp.id ?? `temp-${i}`,
            detected_at: imp.swap_leg_alerts?.detected_at ?? imp.detected_at ?? null,
          })) ?? []);
          const unresolved = (data.impacts ?? []).filter((i: PlanImpact) => !i.resolved).length;
          addToast(unresolved > 0 ? "warning" : "success", unresolved > 0 ? `${unresolved} active impact(s)` : "No active impacts");
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

  async function resolveImpact(impactId: string, resolutionType: string) {
    try {
      const res = await fetch("/api/crew/swap-plan/impact", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: impactId, resolution_type: resolutionType }),
      });
      if (res.ok) {
        setPlanImpacts((prev) =>
          prev.map((imp) =>
            imp.id === impactId
              ? { ...imp, resolved: true, resolution_type: resolutionType, resolved_at: new Date().toISOString() }
              : imp,
          ),
        );
        addToast("success", `Impact ${resolutionType.replace(/_/g, " ")}`);
      }
    } catch {
      addToast("error", "Failed to resolve impact");
    }
  }

  // Auto-check impacts when plan is loaded and there are unacknowledged alerts
  useEffect(() => {
    if (savedPlanMeta && alertCount > 0 && !checkingImpacts) {
      checkImpacts();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedPlanMeta, alertCount]);

  // ── Schedule change auto-polling (2-minute interval) ────────────────
  const prevAlertCountRef = useRef(0);
  useEffect(() => {
    if (activeTab !== "plan" && activeTab !== "impacts") return;
    const swapDateStr = selectedDate.toISOString().slice(0, 10);

    const poll = async () => {
      try {
        const res = await fetch(`/api/crew/swap-alerts?swap_date=${swapDateStr}`);
        if (!res.ok) return;
        const data = await res.json();
        const newCount = data.unacknowledged_count ?? 0;

        if (newCount > prevAlertCountRef.current) {
          const delta = newCount - prevAlertCountRef.current;
          addToast("warning", `${delta} new flight change(s) detected`);
          setAlertCount(newCount);

          // Auto-run impact analysis if we have a saved plan
          if (savedPlanMeta && !checkingImpacts) {
            checkImpacts();
          }
        }
        prevAlertCountRef.current = newCount;
      } catch { /* silently fail polling */ }
    };

    // Initial poll
    poll();
    const interval = setInterval(poll, 120_000); // 2 min
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, selectedDate, savedPlanMeta]);

  // Load plan version history
  async function loadPlanHistory() {
    try {
      const dateStr = selectedDate.toISOString().slice(0, 10);
      const res = await fetch(`/api/crew/swap-plan?swap_date=${dateStr}&version=all`);
      if (!res.ok) return;
      const data = await res.json();
      setPlanVersions(data.versions ?? []);
    } catch { /* ignore */ }
  }

  // Clear all plan versions for this swap date (testing only)
  async function clearAllVersions() {
    const dateStr = selectedDate.toISOString().slice(0, 10);
    if (!confirm(`Delete ALL saved plans for ${dateStr}? This cannot be undone.`)) return;
    if (!confirm(`Are you absolutely sure? All versions will be permanently deleted.`)) return;
    try {
      const res = await fetch(`/api/crew/swap-plan?swap_date=${dateStr}`, { method: "DELETE" });
      if (res.ok) {
        setSavedPlanMeta(null);
        setPlanVersions([]);
        setPlanImpacts([]);
        setShowHistory(false);
        addToast("success", `All plan versions for ${dateStr} deleted`);
      } else {
        addToast("error", "Failed to delete versions");
      }
    } catch { addToast("error", "Failed to delete versions"); }
  }

  // Load a specific historical version
  async function loadVersion(versionId: string) {
    setLoadingVersion(true);
    try {
      const dateStr = selectedDate.toISOString().slice(0, 10);
      const res = await fetch(`/api/crew/swap-plan?swap_date=${dateStr}&version_id=${versionId}`);
      if (!res.ok) { addToast("error", "Failed to load version"); return; }
      const data = await res.json();
      if (data.plan?.plan_data) {
        const planData = data.plan.plan_data as SwapPlanResult;
        // Backfill confirmed field for old plans
        if (planData.rows) {
          for (const row of planData.rows) {
            if (row.confirmed === undefined) row.confirmed = false;
          }
        }
        setSwapPlan({ ...planData, ok: true });
        setSavedPlanMeta({
          id: data.plan.id,
          version: data.plan.version,
          created_at: data.plan.created_at,
        });
        if (data.plan.swap_assignments) setSwapAssignments(data.plan.swap_assignments);
        if (data.plan.oncoming_pool) setOncomingPool(data.plan.oncoming_pool);
        setPlanImpacts([]);
        addToast("success", `Loaded plan v${data.plan.version}`);
        setShowHistory(false);
      }
    } catch { addToast("error", "Failed to load version"); }
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
      // Strip oncoming crew from affected (unlocked) tails so optimizer can reassign
      const lockTailSet = new Set(lockTails);
      if (filteredAssignments) {
        filteredAssignments = Object.fromEntries(
          Object.entries(filteredAssignments).map(([tail, sa]) => {
            if (lockTailSet.has(tail)) return [tail, sa];
            return [tail, { ...sa, oncoming_pic: null, oncoming_sic: null }];
          })
        );
      }
      const res = await fetch("/api/crew/optimize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          swap_date: selectedDate.toISOString().slice(0, 10),
          swap_assignments: filteredAssignments ?? undefined,
          oncoming_pool: oncomingPool ?? undefined,
          strategy,
          lock_tails: lockTails,
          locked_rows: lockedRows,
          constraints: swapConstraints.length > 0 ? swapConstraints : undefined,
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
  // Returns true on success, false on failure
  async function computeRoutes(): Promise<boolean> {
    setComputingRoutes(true);
    try {
      const res = await fetch("/api/crew/routes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ swap_date: selectedDate.toISOString().slice(0, 10) }),
      });
      const data = await safeJson(res, "Route computation failed");
      if (res.ok) {
        await loadRouteStatus();
        return true;
      } else {
        setOptimizeError(data.error ?? "Route computation failed");
        return false;
      }
    } catch (e) {
      setOptimizeError(e instanceof Error ? e.message : "Route computation failed");
      return false;
    } finally {
      setComputingRoutes(false);
    }
  }

  const [seedingFlights, setSeedingFlights] = useState(false);
  async function seedFlights() {
    setSeedingFlights(true);
    try {
      const res = await fetch("/api/crew/seed-flights", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ swap_date: selectedDate.toISOString().slice(0, 10), mode: "fill" }),
      });
      const data = await safeJson(res, "Flight seeding failed");
      if (res.ok) {
        // Refresh gap alerts after seeding
        refreshGapAlerts();
      } else {
        setOptimizeError(data.error ?? "Flight seeding failed");
      }
    } catch (e) {
      setOptimizeError(e instanceof Error ? e.message : "Flight seeding failed");
    } finally {
      setSeedingFlights(false);
    }
  }

  // Auto-detect rotation from JetInsight flights
  // Returns true on success, false on failure
  async function detectRotation(): Promise<boolean> {
    setDetectingRotation(true);
    setOptimizeError(null);
    try {
      const dateStr = selectedDate.toISOString().slice(0, 10);
      const res = await fetch(`/api/crew/detect-rotation?date=${dateStr}`);
      const data = await safeJson(res, "Rotation detection failed");
      if (!res.ok) {
        setOptimizeError(data.error ?? "Rotation detection failed");
        return false;
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
      return true;
    } catch (e) {
      setOptimizeError(e instanceof Error ? e.message : "Rotation detection failed");
      return false;
    } finally {
      setDetectingRotation(false);
    }
  }

  // Load FREEZE sheet assignments as locked starting points
  async function loadFreezeSheet(tab: string) {
    setLoadingFreeze(true);
    setShowFreezeMenu(false);
    try {
      const res = await fetch(`/api/crew/freeze?tab=${encodeURIComponent(tab)}`);
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: "Failed to load FREEZE sheet" }));
        addToast("error", data.error ?? "Failed to load FREEZE sheet");
        return;
      }
      const data = await res.json();
      const entries = data.entries as Array<{
        name: string;
        role: "PIC" | "SIC";
        tail_number: string | null;
        swap_location: string | null;
        flight_number: string | null;
        depart_time: string | null;
        arrival_time: string | null;
        price: number | null;
        home_airports: string[];
      }>;
      if (!entries || entries.length === 0) {
        addToast("warning", "FREEZE sheet is empty — no assignments found");
        return;
      }

      // Convert FreezeEntry[] → SwapAssignment records + locked tails + locked rows
      const newAssignments: Record<string, SwapAssignment> = { ...(swapAssignments ?? {}) };
      const newLocked = new Set(lockedTails);
      const freezeRows: CrewSwapRow[] = [];
      let assignedCount = 0;

      for (const entry of entries) {
        if (!entry.tail_number || !entry.name) continue;
        // Skip header rows that slipped through parsing
        if (entry.name.toUpperCase().includes("PILOT") || entry.name.toUpperCase().includes("COMMAND")) continue;
        const tail = entry.tail_number;
        if (!newAssignments[tail]) {
          newAssignments[tail] = { oncoming_pic: null, oncoming_sic: null, offgoing_pic: null, offgoing_sic: null };
        }
        if (entry.role === "PIC") {
          newAssignments[tail].oncoming_pic = entry.name;
        } else {
          newAssignments[tail].oncoming_sic = entry.name;
        }
        newLocked.add(tail);
        assignedCount++;

        // Determine transport type from flight number
        const fn = (entry.flight_number ?? "").trim().toLowerCase();
        let travelType: CrewSwapRow["travel_type"] = "none";
        if (fn.includes("uber")) travelType = "uber";
        else if (fn.includes("rental")) travelType = "rental_car";
        else if (fn.includes("drive") || fn.includes("self")) travelType = "drive";
        else if (/[a-z]{1,3}\d+/i.test(fn)) travelType = "commercial";

        // Build a locked row with transport data from the sheet
        freezeRows.push({
          name: entry.name,
          home_airports: entry.home_airports ?? [],
          role: entry.role,
          direction: "oncoming",
          aircraft_type: "unknown",
          tail_number: tail,
          swap_location: entry.swap_location,
          all_swap_points: entry.swap_location ? [entry.swap_location] : [],
          travel_type: travelType,
          flight_number: entry.flight_number,
          departure_time: entry.depart_time,
          arrival_time: entry.arrival_time,
          travel_from: entry.home_airports?.[0] ?? null,
          travel_to: entry.swap_location,
          cost_estimate: entry.price,
          duration_minutes: null,
          available_time: entry.arrival_time,
          duty_on_time: entry.depart_time,
          duty_off_time: null,
          is_checkairman: false,
          checkairman_types: [],
          is_skillbridge: false,
          grade: 3,
          volunteer_status: null,
          notes: (entry as Record<string, unknown>).notes as string | null ?? "From FREEZE sheet",
          warnings: [],
          alt_flights: [],
          backup_flight: null,
          score: 100,
          confirmed: false,
        });
      }

      setSwapAssignments(newAssignments);
      try { localStorage.setItem("swap_assignments", JSON.stringify(newAssignments)); } catch {}
      setLockedTails(newLocked);

      // If we have a swap plan, merge the freeze rows into it as locked
      if (swapPlan) {
        // Remove existing oncoming rows for locked tails, replace with freeze data
        const unlockedRows = swapPlan.rows.filter(r =>
          !(r.direction === "oncoming" && newLocked.has(r.tail_number))
        );
        const mergedRows = [...freezeRows, ...unlockedRows];
        setSwapPlan({ ...swapPlan, rows: mergedRows });
      } else {
        // Create a new plan from freeze data
        const totalCost = freezeRows.reduce((s, r) => s + (r.cost_estimate ?? 0), 0);
        setSwapPlan({
          ok: true,
          swap_date: selectedDate.toISOString().slice(0, 10),
          rows: freezeRows,
          warnings: ["Plan loaded from FREEZE sheet — run Optimize to fill gaps"],
          routes_used: 0,
          total_cost: totalCost,
          plan_score: 100,
          solved_count: freezeRows.filter(r => r.travel_type !== "none").length,
          unsolved_count: freezeRows.filter(r => r.travel_type === "none").length,
        });
      }
      addToast("success", `Loaded ${assignedCount} crew from FREEZE sheet (${newLocked.size} tails locked, ${freezeRows.filter(r => r.travel_type !== "none").length} with transport)`);
    } catch (e) {
      addToast("error", e instanceof Error ? e.message : "Failed to load FREEZE sheet");
    } finally {
      setLoadingFreeze(false);
    }
  }

  // Upload Excel roster
  async function syncFromGoogleSheet() {
    setSyncingCrewInfo(true);
    setUploading(true);
    setUploadError(null);
    try {
      const res = await fetch("/api/crew/roster/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source: "master_sheet",
          swap_date: selectedDate.toISOString().slice(0, 10),
          week: selectedWeek || undefined,
        }),
      });
      const data = await safeJson(res, "Google Sheets sync failed");

      if (!res.ok) {
        setUploadError(data.error ?? "Sync failed");
        addToast("error", data.error ?? "Google Sheets sync failed");
      } else {
        setUploadResult({
          ok: true,
          total_parsed: data.roster?.total ?? 0,
          unique_crew: data.roster?.active ?? 0,
          upserted: data.roster?.upserted ?? 0,
          errors: data.errors,
          summary: buildSummaryFromAssignments(data.swap_assignments),
          swap_assignments: data.swap_assignments,
          oncoming_pool: data.oncoming_pool,
        });

        if (data.swap_assignments && Object.keys(data.swap_assignments).length > 0) {
          setSwapAssignments(data.swap_assignments);
          try { localStorage.setItem("swap_assignments", JSON.stringify(data.swap_assignments)); } catch {}
        }
        if (data.oncoming_pool) {
          setOncomingPool(data.oncoming_pool);
          try { localStorage.setItem("oncoming_pool", JSON.stringify(data.oncoming_pool)); } catch {}
        }

        setCrewInfoData({
          bad_pairings: data.bad_pairings ?? [],
          checkairmen: data.checkairmen ?? [],
          recurrency_299: data.recurrency_299 ?? [],
          pic_swap_table: data.pic_swap_table ?? [],
          crewing_checklist: data.crewing_checklist ?? null,
          calendar_weeks: data.calendar_weeks ?? [],
          target_week_crew: data.target_week_crew ?? null,
          different_airports: data.different_airports ?? [],
          roster: data.roster ?? undefined,
        });

        setRotationSource("excel");
        await loadCrew();
        addToast("success", `Synced from Google Sheet: ${data.roster?.active ?? 0} crew, ${data.checkairmen?.length ?? 0} CAs`);
        setSyncCounter((c) => c + 1);
      }
    } catch (e) {
      setUploadError(e instanceof Error ? e.message : "Sync failed");
      addToast("error", "Google Sheets sync failed");
    } finally {
      setSyncingCrewInfo(false);
      setUploading(false);
    }
  }

  async function syncCrewInfo(file: File) {
    setSyncingCrewInfo(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("swap_date", selectedDate.toISOString().slice(0, 10));
      const res = await fetch("/api/crew/roster/sync", { method: "POST", body: fd });
      if (res.ok) {
        const data = await res.json();
        setCrewInfoData({
          bad_pairings: data.bad_pairings ?? [],
          checkairmen: data.checkairmen ?? [],
          recurrency_299: data.recurrency_299 ?? [],
          pic_swap_table: data.pic_swap_table ?? [],
          crewing_checklist: data.crewing_checklist ?? null,
          calendar_weeks: data.calendar_weeks ?? [],
          target_week_crew: data.target_week_crew ?? null,
          different_airports: data.different_airports ?? [],
          roster: data.roster ?? undefined,
        });
        addToast("success", `Crew info synced: ${data.checkairmen?.length ?? 0} CAs, ${data.bad_pairings?.length ?? 0} bad pairings`);
      }
    } catch {
      // Sync is supplementary — don't block the main upload
    } finally {
      setSyncingCrewInfo(false);
    }
  }

  async function handleUpload(file: File) {
    setUploading(true);
    setUploadError(null);
    setUploadResult(null);
    setSyncingCrewInfo(true);
    try {
      // Use the sync endpoint as primary — handles CREW INFO workbook + legacy weekly sheets
      const fd = new FormData();
      fd.append("file", file);
      fd.append("swap_date", selectedDate.toISOString().slice(0, 10));

      const res = await fetch("/api/crew/roster/sync", { method: "POST", body: fd });
      const data = await safeJson(res, "Upload failed");

      if (!res.ok) {
        setUploadError(data.error ?? "Upload failed");
      } else {
        // Set upload result (backwards-compatible shape)
        setUploadResult({
          ok: true,
          total_parsed: data.roster?.total ?? 0,
          unique_crew: data.roster?.active ?? 0,
          upserted: data.roster?.upserted ?? 0,
          errors: data.errors,
          summary: buildSummaryFromAssignments(data.swap_assignments),
          swap_assignments: data.swap_assignments,
          oncoming_pool: data.oncoming_pool,
        });

        if (data.swap_assignments && Object.keys(data.swap_assignments).length > 0) {
          setSwapAssignments(data.swap_assignments);
          try { localStorage.setItem("swap_assignments", JSON.stringify(data.swap_assignments)); } catch {}
        }
        if (data.oncoming_pool) {
          setOncomingPool(data.oncoming_pool);
          try { localStorage.setItem("oncoming_pool", JSON.stringify(data.oncoming_pool)); } catch {}
        }

        // Set crew info data (bad pairings, checkairmen, calendar, etc.)
        setCrewInfoData({
          bad_pairings: data.bad_pairings ?? [],
          checkairmen: data.checkairmen ?? [],
          recurrency_299: data.recurrency_299 ?? [],
          pic_swap_table: data.pic_swap_table ?? [],
          crewing_checklist: data.crewing_checklist ?? null,
          calendar_weeks: data.calendar_weeks ?? [],
          target_week_crew: data.target_week_crew ?? null,
          different_airports: data.different_airports ?? [],
          roster: data.roster ?? undefined,
        });

        setRotationSource("excel");
        await loadCrew();
        addToast("success", `Synced ${data.roster?.active ?? 0} crew, ${data.checkairmen?.length ?? 0} CAs, ${data.bad_pairings?.length ?? 0} conflicts`);
      }
    } catch (e) {
      setUploadError(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setUploading(false);
      setSyncingCrewInfo(false);
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
      const wedFlights = sorted.filter((f) => isWednesday(f.scheduled_departure, selectedDate));
      const lastKnown = sorted.filter((f) => f.arrival_icao).pop()?.arrival_icao ?? null;
      schedules.push({ tail, wedFlights, lastKnown });
    }

    return schedules.sort((a, b) => a.tail.localeCompare(b.tail));
  }, [flights, selectedDate]);

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
      // Strip oncoming crew from unlocked tails so the optimizer can reassign freely.
      // Without this, previously assigned oncoming crew "stick" to their tails because
      // assignOncomingCrew() only fills empty slots. Locked tails keep their assignments.
      if (filteredAssignments) {
        filteredAssignments = Object.fromEntries(
          Object.entries(filteredAssignments).map(([tail, sa]) => {
            if (lockedTails.has(tail)) return [tail, sa]; // preserve locked
            return [tail, { ...sa, oncoming_pic: null, oncoming_sic: null }];
          })
        );
      }
      // If tails are locked, pass them + their rows so optimizer skips them
      const lockTailsArr = lockedTails.size > 0 && swapPlan ? [...lockedTails] : undefined;
      const lockedRows = lockTailsArr && swapPlan ? swapPlan.rows.filter((r) => lockedTails.has(r.tail_number)) : undefined;

      // Check if we need split-day optimization (some tails assigned to non-Wednesday days)
      const nonWedDayMap = new Map<SwapDay, Set<string>>();
      for (const [t, d] of Object.entries(tailSwapDays)) {
        if (d !== "wednesday") {
          if (!nonWedDayMap.has(d)) nonWedDayMap.set(d, new Set());
          nonWedDayMap.get(d)!.add(t);
        }
      }
      const hasSplitDays = nonWedDayMap.size > 0;
      // Legacy alias for downstream references
      const tueTails = nonWedDayMap.get("tuesday") ?? new Set<string>();

      // Convert daily pairs for this optimization day into required_pairings format
      const allPairings = [...requiredPairings];

      // Helper: run one optimization for a specific day's tails
      async function optimizeForDay(
        dayTails: Set<string> | null, // null = all tails
        dayLabel: SwapDay,
        swapDateStr: string,
      ): Promise<{ ok: boolean; data: Record<string, unknown> | null }> {
        // Filter assignments to only this day's tails
        let dayAssignments = filteredAssignments;
        if (dayTails && dayAssignments) {
          dayAssignments = Object.fromEntries(
            Object.entries(dayAssignments).filter(([tail]) => dayTails.has(tail))
          );
        }

        // Build required_pairings from allPairings + day-specific force_pair constraints
        const dayPairings = [
          ...allPairings,
          ...swapConstraints
            .filter((c): c is SwapConstraint & { type: "force_pair" } => c.type === "force_pair" && (!c.day || c.day === dayLabel))
            .map(c => ({ pic: c.crew_a, sic: c.crew_b, reason: c.reason ?? `Pair (${dayLabel})` })),
        ];

        const res = await fetch("/api/crew/optimize", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            swap_date: swapDateStr,
            swap_assignments: dayAssignments ?? undefined,
            oncoming_pool: oncomingPool ?? undefined,
            strategy,
            lock_tails: lockTailsArr,
            locked_rows: lockedRows,
            required_pairings: dayPairings.length > 0 ? dayPairings : undefined,
            constraints: swapConstraints.length > 0 ? swapConstraints : undefined,
            current_swap_day: dayLabel,
          }),
        });
        const text = await res.text();
        try {
          const data = JSON.parse(text);
          return { ok: res.ok, data };
        } catch {
          return { ok: false, data: { error: `Server error: ${text.slice(0, 200)}` } };
        }
      }

      if (hasSplitDays) {
        // ── Split-day optimization: run each assigned day separately ──
        const wedDate = selectedDate.toISOString().slice(0, 10);
        const dayOffsets: Record<SwapDay, number> = {
          monday: -2, tuesday: -1, wednesday: 0, thursday: 1, friday: 2, saturday: 3, sunday: 4,
        };

        const allTails = new Set(Object.keys(filteredAssignments ?? {}));
        // Tails assigned to non-Wed days
        const assignedToOtherDays = new Set<string>();
        for (const tails of nonWedDayMap.values()) {
          for (const t of tails) assignedToOtherDays.add(t);
        }
        const wedTails = new Set([...allTails].filter(t => !assignedToOtherDays.has(t)));

        // Build optimization jobs: one per unique day + Wednesday for remaining tails
        const dayJobs: { day: SwapDay; tails: Set<string>; date: string }[] = [];
        for (const [day, tails] of nonWedDayMap.entries()) {
          const dateStr = new Date(selectedDate.getTime() + dayOffsets[day] * 86400_000).toISOString().slice(0, 10);
          dayJobs.push({ day, tails, date: dateStr });
        }
        dayJobs.push({ day: "wednesday", tails: wedTails, date: wedDate });

        const results = await Promise.all(
          dayJobs.map(j => optimizeForDay(j.tails, j.day, j.date).then(r => ({ ...r, ...j }))),
        );

        const failed = results.find(r => !r.ok);
        if (failed) {
          const err = failed.data as { error?: string; validation?: { errors: { message: string }[] } };
          if (err?.validation) {
            const vErrors = err.validation.errors;
            setOptimizeError(`Validation failed:\n${vErrors.map(e => e.message).join("\n")}`);
            addToast("error", `${vErrors.length} validation error(s)`);
          } else {
            setOptimizeError(err?.error ?? "Optimization failed");
            addToast("error", err?.error ?? "Optimization failed");
          }
        } else {
          const newDayPlans: Partial<Record<SwapDay, SwapPlanResult>> = {};
          let allRows: CrewSwapRow[] = [];
          let totalCost = 0;
          const daySummary: string[] = [];

          for (const r of results) {
            const plan = r.data as SwapPlanResult;
            newDayPlans[r.day] = plan;
            const rows = plan.rows ?? [];
            allRows = [...allRows, ...rows];
            totalCost += plan.total_cost ?? 0;
            daySummary.push(`${DAY_LABELS[r.day]} (${rows.length} crew)`);
          }

          setDayPlans(prev => ({ ...prev, ...newDayPlans }));
          const merged = {
            ...(results.find(r => r.day === "wednesday")?.data as SwapPlanResult ?? results[0].data as SwapPlanResult),
            rows: allRows,
            total_cost: totalCost,
            solved_count: allRows.filter(r => r.travel_type !== "none").length,
            unsolved_count: allRows.filter(r => r.travel_type === "none").length,
          } as SwapPlanResult;
          setSwapPlan(merged);
          setActiveTab("plan");
          addToast("success", `Split-day optimized: ${daySummary.join(", ")}, $${merged.total_cost.toLocaleString()}`);
        }
      } else {
        // ── Single-day optimization (standard Wednesday) ──
        const { ok, data } = await optimizeForDay(null, "wednesday", selectedDate.toISOString().slice(0, 10));
        if (!data) { setOptimizeError("No response"); return; }

      if (!ok) {
        // Handle validation errors with detailed messages
        if (data.validation) {
          const vErrors = (data.validation as { errors: { message: string }[] }).errors;
          const vWarnings = (data.validation as { warnings?: { message: string }[] }).warnings ?? [];
          const errMsg = vErrors.map((e: { message: string }) => e.message).join("\n");
          setOptimizeError(`Validation failed:\n${errMsg}`);
          addToast("error", `${vErrors.length} validation error${vErrors.length > 1 ? "s" : ""} — fix before optimizing`);
          if (vWarnings.length > 0) {
            addToast("warning", `${vWarnings.length} warning${vWarnings.length > 1 ? "s" : ""}: ${vWarnings[0]?.message ?? ""}`);
          }
        } else {
          setOptimizeError((data as { error?: string }).error ?? "Optimization failed");
          addToast("error", (data as { error?: string }).error ?? "Optimization failed");
        }
      } else {
        setSwapPlan(data as SwapPlanResult);
        setActiveTab("plan");
        // Show validation warnings from successful optimization
        const vw = (data as { validation?: { warnings?: { message: string }[] } }).validation?.warnings;
        if (vw && vw.length > 0) {
          addToast("warning", `${vw.length} data quality warning${vw.length > 1 ? "s" : ""}`);
        }
        addToast("success", `Optimized: ${(data as SwapPlanResult).solved_count ?? 0} solved, $${((data as SwapPlanResult).total_cost ?? 0).toLocaleString()}`);
      }
      } // end single-day else
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Optimization failed";
      setOptimizeError(msg);
      addToast("error", msg);
    } finally {
      setOptimizing(false);
    }
  }

  // One-click full optimize: detect rotation → seed flights → compute routes → optimize
  async function runFullOptimize() {
    setOptimizing(true);
    setOptimizeError(null);
    try {
      // Step 1: Auto-detect rotation
      // Always run to ensure oncoming pool is populated (sheet sync may not have oncoming data yet)
      setOptimizeStatus("Detecting rotation...");
      const rotationOk = await detectRotation();
      if (!rotationOk) {
        setOptimizeStatus(null);
        return;
      }

      // Step 2: Compute routes — seeds HasData flight cache for swap day + next day
      // (covers both oncoming and offgoing Thursday morning flights in one pass)
      setOptimizeStatus("Computing routes...");
      const routesOk = await computeRoutes();
      if (!routesOk) {
        setOptimizeStatus(null);
        return;
      }

      // Step 3: Run optimizer
      setOptimizeStatus("Optimizing...");
      await runOptimizer();

      setOptimizeStatus(null);
    } catch (e) {
      setOptimizeError(e instanceof Error ? e.message : "Optimization failed");
      setOptimizeStatus(null);
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
    setSelectedDate((prev) => {
      const next = new Date(prev);
      next.setDate(prev.getDate() + delta * 7);
      return next;
    });
  }

  function shiftDay(delta: number) {
    setSelectedDate((prev) => {
      const next = new Date(prev);
      next.setDate(prev.getDate() + delta);
      return next;
    });
  }

  const isWednesdaySelected = selectedDate.getDay() === 3;

  return (
    <div className="space-y-4">
      {/* Header + Week Selector + Stepper */}
      <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
        <div className="flex items-center gap-6">
          <div>
            <h2 className="text-lg font-bold text-gray-900">Crew Swap Planning</h2>
            <p className="text-sm text-gray-500 flex items-center gap-2">
              <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-semibold ${isWednesdaySelected ? "bg-green-100 text-green-700" : "bg-orange-100 text-orange-700"}`}>
                {isWednesdaySelected ? "Rotation Swap" : "Ad-hoc Move"}
              </span>
              {selectedDate.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}
            </p>
          </div>
          <WorkflowStepper steps={[
            { label: "Upload", done: !!(uploadResult || swapAssignments) },
            { label: "Routes", done: !!(routeStatus && routeStatus.total_routes > 0) },
            { label: "Optimize", done: !!swapPlan },
            { label: "Save", done: !!savedPlanMeta },
          ]} />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button onClick={() => shiftWeek(-1)} className="px-3 py-1.5 text-sm font-medium border rounded-lg hover:bg-gray-50" title="Previous Wednesday">
            &laquo; Wk
          </button>
          <button onClick={() => shiftDay(-1)} className="px-3 py-1.5 text-sm font-medium border rounded-lg hover:bg-gray-50" title="Previous day">
            &larr;
          </button>
          <input
            type="date"
            value={selectedDate.toISOString().slice(0, 10)}
            onChange={(e) => {
              const d = new Date(e.target.value + "T00:00:00");
              if (!isNaN(d.getTime())) setSelectedDate(d);
            }}
            className="px-2 py-1 text-sm font-medium border rounded-lg bg-white text-gray-700 hover:bg-gray-50 cursor-pointer"
          />
          <button onClick={() => shiftDay(1)} className="px-3 py-1.5 text-sm font-medium border rounded-lg hover:bg-gray-50" title="Next day">
            &rarr;
          </button>
          <button onClick={() => shiftWeek(1)} className="px-3 py-1.5 text-sm font-medium border rounded-lg hover:bg-gray-50" title="Next Wednesday">
            Wk &raquo;
          </button>
          <button onClick={() => setSelectedDate(getNextWednesday())} className="px-3 py-1.5 text-sm font-medium border rounded-lg hover:bg-gray-50 bg-blue-50 text-blue-700" title="Jump to next Wednesday">
            Next Wed
          </button>
        </div>
        {/* Multi-day selector */}
        <DaySelector
          selectedDays={selectedSwapDays}
          onDaysChange={setSelectedSwapDays}
        />
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
                saved {new Date(savedPlanMeta.created_at).toLocaleString(undefined, { weekday: "short", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false })}
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
              onClick={() => { loadPlanHistory(); setShowHistory(!showHistory); }}
              className="px-3 py-1.5 text-xs font-medium rounded-lg border bg-white hover:bg-gray-50"
            >
              History
            </button>
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

      {/* Version History Panel */}
      {showHistory && planVersions.length > 0 && (
        <div className="rounded-lg border bg-white shadow-sm overflow-hidden mb-2">
          <div className="px-4 py-2 bg-gray-50 border-b">
            <span className="text-xs font-semibold text-gray-600 uppercase">Plan History</span>
            <button
              onClick={clearAllVersions}
              className="text-[10px] px-2 py-1 rounded bg-red-50 text-red-600 hover:bg-red-100 font-medium"
            >
              Clear All
            </button>
          </div>
          <div className="divide-y max-h-48 overflow-y-auto">
            {planVersions.map((v) => (
              <div key={v.id} className={`px-4 py-2 flex items-center justify-between hover:bg-gray-50 ${
                v.status === "active" ? "bg-green-50/50" : ""
              }`}>
                <div className="flex items-center gap-3">
                  <span className="text-sm font-bold text-gray-800">v{v.version}</span>
                  <span className="text-xs text-gray-500">
                    {new Date(v.created_at).toLocaleString(undefined, { weekday: "short", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false })}
                  </span>
                  {v.status === "active" && (
                    <span className="text-[9px] px-1.5 py-0.5 rounded bg-green-100 text-green-700 font-bold">ACTIVE</span>
                  )}
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-xs text-gray-500">${v.total_cost?.toLocaleString() ?? "—"}</span>
                  <span className="text-xs text-gray-500">{v.solved_count ?? 0} solved</span>
                  {v.strategy && <span className="text-[9px] text-gray-400">{v.strategy}</span>}
                  {v.id !== savedPlanMeta?.id && (
                    <button
                      onClick={() => loadVersion(v.id)}
                      disabled={loadingVersion}
                      className="px-2 py-1 text-[10px] font-medium rounded bg-blue-50 text-blue-700 hover:bg-blue-100"
                    >
                      {loadingVersion ? "..." : "Load"}
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Tab Bar */}
      <div className="flex border-b">
        {([
          { key: "setup" as const, label: "Setup", badge: null },
          { key: "review" as const, label: "Review", badge: Object.values(reviewChecks).every(Boolean) ? "\u2713" : `${Object.values(reviewChecks).filter(Boolean).length}/5` },
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
            {availableWeeks.length > 0 && (
              <select
                value={selectedWeek}
                onChange={(e) => setSelectedWeek(e.target.value)}
                className="text-xs border rounded-lg px-2 py-1.5 bg-white text-gray-700"
              >
                {availableWeeks.map(w => (
                  <option key={w} value={w}>{w}</option>
                ))}
              </select>
            )}
            <button
              onClick={syncFromGoogleSheet}
              disabled={uploading || syncingCrewInfo || sheetValidation?.valid === false}
              className={`px-3 py-1.5 text-xs font-medium border rounded-lg ${
                uploading || syncingCrewInfo || sheetValidation?.valid === false ? "bg-gray-100 text-gray-400" : "bg-emerald-50 text-emerald-700 hover:bg-emerald-100 border-emerald-200"
              }`}
              title={sheetValidation?.valid === false ? "Fix sheet errors before syncing" : undefined}
            >
              {syncingCrewInfo ? "Syncing..." : "Sync from Sheet"}
            </button>
            {freezeTabs.length > 0 && (
              <div className="relative" ref={freezeMenuRef}>
                <button
                  onClick={() => setShowFreezeMenu(!showFreezeMenu)}
                  disabled={loadingFreeze}
                  className={`px-3 py-1.5 text-xs font-medium border rounded-lg ${
                    loadingFreeze ? "bg-gray-100 text-gray-400" : "bg-amber-50 text-amber-700 hover:bg-amber-100 border-amber-200"
                  }`}
                >
                  {loadingFreeze ? "Loading..." : "Load FREEZE"}
                </button>
                {showFreezeMenu && (
                  <div className="absolute right-0 top-full mt-1 bg-white border rounded-lg shadow-lg z-50 min-w-[240px] max-h-60 overflow-y-auto">
                    {freezeTabs.map(tab => (
                      <button
                        key={tab}
                        onClick={() => loadFreezeSheet(tab)}
                        className="w-full text-left px-3 py-2 text-xs hover:bg-amber-50 border-b last:border-b-0 text-gray-700"
                      >
                        {tab}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
            <label className={`px-3 py-1.5 text-xs font-medium border rounded-lg cursor-pointer ${
              uploading ? "bg-gray-100 text-gray-400" : "bg-blue-50 text-blue-700 hover:bg-blue-100 border-blue-200"
            }`}>
              {uploading ? "Syncing..." : "Upload .xlsx"}
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
          {/* Sheet validation panel — validates raw data when a week tab is selected */}
          {selectedWeek && (
            <div className="mt-2 space-y-2">
              <SheetValidationPanel
                selectedWeek={selectedWeek}
                onValidationComplete={setSheetValidation}
              />
              <NameResolutionPanel
                selectedWeek={selectedWeek}
                syncCounter={syncCounter}
              />
            </div>
          )}
          {/* Name alias admin link */}
          <button
            onClick={() => setShowAliasAdmin(true)}
            className="mt-1 text-[10px] text-gray-400 hover:text-blue-600 underline"
          >
            Manage name aliases
          </button>
        </div>
        {showAliasAdmin && <NameAliasAdmin onClose={() => setShowAliasAdmin(false)} />}

        {uploadResult && (
          <div className="px-4 py-3 bg-green-50 border-b border-green-200 text-sm">
            <span className="text-green-700 font-medium">Roster uploaded: </span>
            <span className="text-green-600">
              {uploadResult.total_parsed} parsed, {uploadResult.unique_crew} unique, {uploadResult.upserted} upserted
            </span>
            {uploadResult.summary && Object.values(uploadResult.summary).some(v => v > 0) && (
              <span className="text-green-500 ml-2 text-xs">
                (On-PIC: {uploadResult.summary.oncoming_pic ?? 0}, On-SIC: {uploadResult.summary.oncoming_sic ?? 0},
                 Off-PIC: {uploadResult.summary.offgoing_pic ?? 0}, Off-SIC: {uploadResult.summary.offgoing_sic ?? 0})
              </span>
            )}
            {uploadResult.swap_assignments && (
              <span className="text-green-500 ml-2 text-xs">
                | {Object.keys(uploadResult.swap_assignments).length} tails
                {oncomingPool
                  ? ` | Pool: ${oncomingPool.pic.length} PICs, ${oncomingPool.sic.length} SICs to assign`
                  : uploadResult.oncoming_pool
                    ? ` | Pool: ${uploadResult.oncoming_pool.pic.length} PICs, ${uploadResult.oncoming_pool.sic.length} SICs to assign`
                    : ""}
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
                  <th className="px-4 py-2">Grade</th>
                  <th className="px-4 py-2">Home</th>
                  <th className="px-4 py-2">Aircraft</th>
                  <th className="px-4 py-2">Flags</th>
                  <th className="px-4 py-2">Notes</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {crew.map((c) => {
                  const gradeColors: Record<number, string> = {
                    1: "bg-red-100 text-red-700 border-red-200",
                    2: "bg-amber-100 text-amber-700 border-amber-200",
                    3: "bg-gray-100 text-gray-600 border-gray-200",
                    4: "bg-green-100 text-green-700 border-green-200",
                  };
                  const gradeLabels: Record<number, string> = { 1: "1", 2: "2", 3: "3", 4: "4" };
                  const caTypes = c.checkairman_types ?? [];
                  const caLabel = caTypes.length === 0 ? "CA"
                    : caTypes.includes("citation_x") && caTypes.includes("challenger") ? "CA"
                    : caTypes.includes("citation_x") ? "CA-CX"
                    : caTypes.includes("challenger") ? "CA-CL" : "CA";
                  return (
                  <tr key={c.id} className="hover:bg-gray-50">
                    <td className="px-4 py-2 font-medium text-gray-900">{c.name}</td>
                    <td className="px-4 py-2">
                      <span className={`text-xs px-2 py-0.5 rounded font-medium ${
                        c.role === "PIC" ? "bg-blue-100 text-blue-700" : "bg-purple-100 text-purple-700"
                      }`}>
                        {c.role}
                      </span>
                    </td>
                    <td className="px-4 py-2">
                      <select
                        value={c.grade ?? 3}
                        onChange={async (e) => {
                          const newGrade = parseInt(e.target.value);
                          const prev = c.grade;
                          // Optimistic update
                          setCrew((prev2) => prev2.map((cr) => cr.id === c.id ? { ...cr, grade: newGrade } : cr));
                          try {
                            const res = await fetch("/api/crew/roster/update-field", {
                              method: "PATCH",
                              headers: { "Content-Type": "application/json" },
                              body: JSON.stringify({ id: c.id, field: "grade", value: newGrade }),
                            });
                            if (!res.ok) throw new Error("Failed");
                          } catch {
                            setCrew((prev2) => prev2.map((cr) => cr.id === c.id ? { ...cr, grade: prev } : cr));
                          }
                        }}
                        className={`text-xs px-1.5 py-0.5 rounded border cursor-pointer ${gradeColors[c.grade ?? 3] ?? gradeColors[3]}`}
                      >
                        <option value={1}>1 - Needs work</option>
                        <option value={2}>2 - New</option>
                        <option value={3}>3 - Solid</option>
                        <option value={4}>4 - Expert</option>
                      </select>
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
                        {c.is_checkairman && <span className="text-xs px-1.5 py-0.5 rounded bg-amber-100 text-amber-700">{caLabel}</span>}
                        {c.is_skillbridge && <span className="text-xs px-1.5 py-0.5 rounded bg-teal-100 text-teal-700">SB</span>}
                        {c.restrictions?.no_international && <span className="text-xs px-1.5 py-0.5 rounded bg-red-100 text-red-700">No Intl</span>}
                      </div>
                    </td>
                    <td className="px-4 py-2 text-xs text-gray-400 max-w-[200px] truncate">
                      {c.notes ?? "—"}
                    </td>
                  </tr>
                  );
                })}
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

      {/* Crew Info Panel (from CREW INFO Excel sync) */}
      {crewInfoData && (
        <CrewInfoPanel data={crewInfoData} />
      )}
      {!crewInfoData && uploadResult && (
        <div className="rounded-lg border border-dashed border-indigo-200 bg-indigo-50/30 p-3 flex items-center justify-between">
          <div className="text-[11px] text-indigo-600">
            Sync <span className="font-bold">CREW INFO 2026</span> to see bad pairings, checkairmen, and calendar data.
          </div>
          <div className="flex gap-2 shrink-0">
            <button
              onClick={syncFromGoogleSheet}
              disabled={syncingCrewInfo}
              className={`px-3 py-1.5 text-xs font-medium border rounded-lg ${
                syncingCrewInfo ? "bg-gray-100 text-gray-400" : "bg-emerald-50 text-emerald-700 hover:bg-emerald-100 border-emerald-200"
              }`}
            >
              {syncingCrewInfo ? "Syncing..." : "Sync from Sheet"}
            </button>
            <label className={`px-3 py-1.5 text-xs font-medium border rounded-lg cursor-pointer ${
              syncingCrewInfo ? "bg-gray-100 text-gray-400" : "bg-indigo-50 text-indigo-700 hover:bg-indigo-100 border-indigo-200"
            }`}>
              {syncingCrewInfo ? "Syncing..." : "Upload .xlsx"}
              <input
                type="file"
                accept=".xlsx,.xls"
                className="hidden"
                disabled={syncingCrewInfo}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) syncCrewInfo(f);
                  e.target.value = "";
                }}
              />
            </label>
          </div>
        </div>
      )}

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

      {/* Gap Detection Alerts */}
      {gapAlerts && (gapAlerts.newAirports.length > 0 || gapAlerts.missingPairs > 0) && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 space-y-2">
          <div className="flex items-center gap-2">
            <span className="text-xs font-bold text-amber-800 uppercase tracking-wider">Coverage Gaps Detected</span>
          </div>
          {gapAlerts.newAirports.length > 0 && (
            <div className="text-xs text-amber-700 space-y-1">
              <div className="font-medium">New airports with no commercial alias ({gapAlerts.newAirports.length}):</div>
              {gapAlerts.newAirports.map(a => (
                <div key={a.icao} className="flex items-center gap-2 ml-2">
                  <span className="font-mono font-bold">{a.iata}</span>
                  <span className="text-amber-500">({a.flights} flights)</span>
                  {addedAliases.has(a.icao) ? (
                    <span className="text-green-600 font-medium">&#10003; Added</span>
                  ) : a.suggested ? (
                    <>
                      <span className="text-amber-600">suggested: <span className="font-mono font-bold">{a.suggested}</span> ({a.distance}mi)</span>
                      <button
                        onClick={() => handleAddAlias(a.icao, a.suggested!, a.suggestedIcao)}
                        disabled={addingAlias === a.icao}
                        className="text-[9px] px-1.5 py-0.5 bg-green-100 text-green-700 hover:bg-green-200 rounded font-medium disabled:opacity-50"
                      >
                        {addingAlias === a.icao ? "..." : "Add"}
                      </button>
                    </>
                  ) : (
                    <>
                      <span className="text-red-600">no nearby commercial airport found</span>
                      <input
                        type="text"
                        placeholder="IATA"
                        maxLength={4}
                        className="w-12 text-[9px] px-1 py-0.5 border rounded font-mono uppercase"
                        value={manualAliasInputs[a.icao] ?? ""}
                        onChange={e => setManualAliasInputs(prev => ({ ...prev, [a.icao]: e.target.value.toUpperCase() }))}
                      />
                      <button
                        onClick={() => {
                          const val = (manualAliasInputs[a.icao] ?? "").trim();
                          if (val.length >= 2) handleAddAlias(a.icao, val);
                        }}
                        disabled={addingAlias === a.icao || !(manualAliasInputs[a.icao]?.trim()?.length >= 2)}
                        className="text-[9px] px-1.5 py-0.5 bg-green-100 text-green-700 hover:bg-green-200 rounded font-medium disabled:opacity-50"
                      >
                        {addingAlias === a.icao ? "..." : "Add"}
                      </button>
                    </>
                  )}
                </div>
              ))}
            </div>
          )}
          {gapAlerts.missingPairs > 0 && (
            <div className="flex items-center gap-3 text-xs text-amber-700">
              <span><span className="font-medium">{gapAlerts.missingPairs.toLocaleString()} city pairs</span> not yet cached for {selectedDate.toISOString().slice(0, 10)}.</span>
              <button
                onClick={computeRoutes}
                disabled={computingRoutes || seedingFlights}
                className={`px-3 py-1 rounded-md font-medium whitespace-nowrap ${
                  computingRoutes || seedingFlights ? "bg-gray-200 text-gray-400" : "bg-amber-600 text-white hover:bg-amber-700"
                }`}
              >
                {computingRoutes || seedingFlights ? "Computing..." : "Compute Routes Now"}
              </button>
            </div>
          )}
        </div>
      )}

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

      {/* ═══ REVIEW TAB ═══ */}
      {activeTab === "review" && <>

      <div className="space-y-3">
        {/* Section 1: Roster Changes */}
        <div className="rounded-lg border bg-white shadow-sm overflow-hidden">
          <div className="px-4 py-3 bg-gray-50 border-b flex items-center justify-between">
            <div className="flex items-center gap-2">
              <input type="checkbox" checked={reviewChecks.roster_reviewed}
                onChange={(e) => setReviewChecks((p) => ({ ...p, roster_reviewed: e.target.checked }))}
                className="rounded border-gray-300" />
              <h3 className="text-sm font-semibold text-gray-700 uppercase tracking-wider">1. Roster Changes</h3>
            </div>
            <span className="text-[10px] text-gray-400">{crew.length} active crew</span>
          </div>
          <div className="p-4 text-xs space-y-2">
            {crew.length > 0 ? (
              <>
                <div className="grid grid-cols-4 gap-3">
                  <div className="rounded bg-green-50 p-2 text-center">
                    <div className="text-lg font-bold text-green-700">{crew.filter((c) => c.active).length}</div>
                    <div className="text-gray-500">Active</div>
                  </div>
                  <div className="rounded bg-red-50 p-2 text-center">
                    <div className="text-lg font-bold text-red-700">{crew.filter((c) => !c.active).length}</div>
                    <div className="text-gray-500">Inactive</div>
                  </div>
                  <div className="rounded bg-teal-50 p-2 text-center">
                    <div className="text-lg font-bold text-teal-700">{crew.filter((c) => c.is_skillbridge).length}</div>
                    <div className="text-gray-500">SkillBridge</div>
                  </div>
                  <div className="rounded bg-purple-50 p-2 text-center">
                    <div className="text-lg font-bold text-purple-700">{crew.filter((c) => c.is_checkairman).length}</div>
                    <div className="text-gray-500">Checkairmen</div>
                  </div>
                </div>
                {unavailableCrew.size > 0 && (
                  <div className="text-amber-600">Marked unavailable: {[...unavailableCrew].join(", ")}</div>
                )}
              </>
            ) : (
              <div className="text-gray-400">Upload Crew Info Excel on Setup tab first.</div>
            )}
          </div>
        </div>

        {/* Section 2: Different Airports */}
        <div className="rounded-lg border bg-white shadow-sm overflow-hidden">
          <div className="px-4 py-3 bg-gray-50 border-b flex items-center justify-between">
            <div className="flex items-center gap-2">
              <input type="checkbox" checked={reviewChecks.airports_reviewed}
                onChange={(e) => setReviewChecks((p) => ({ ...p, airports_reviewed: e.target.checked }))}
                className="rounded border-gray-300" />
              <h3 className="text-sm font-semibold text-gray-700 uppercase tracking-wider">2. Different Airports</h3>
            </div>
            <span className="text-[10px] text-gray-400">Crew NOT at home base this week</span>
          </div>
          <div className="p-4 text-xs">
            {crewInfoData?.different_airports && crewInfoData.different_airports.length > 0 ? (
              <div className="space-y-1">
                {crewInfoData.different_airports.map((da, i) => (
                  <div key={i} className="flex items-center gap-3 py-1 border-b border-gray-100 last:border-0">
                    <span className="font-medium text-gray-900 w-40">{da.name}</span>
                    {da.coming_from && (
                      <span className="text-blue-600">from{" "}
                        <input type="text" defaultValue={da.coming_from}
                          className="w-12 text-xs border-b border-blue-300 bg-transparent text-blue-700 font-bold text-center"
                          onBlur={(e) => {
                            const val = e.target.value.toUpperCase().trim();
                            if (val && val !== da.coming_from) {
                              setAirportOverrides((p) => ({ ...p, [da.name]: val }));
                            }
                          }}
                        />
                      </span>
                    )}
                    {da.going_to && (
                      <span className="text-green-600">to{" "}
                        <input type="text" defaultValue={da.going_to}
                          className="w-12 text-xs border-b border-green-300 bg-transparent text-green-700 font-bold text-center"
                          onBlur={(e) => {
                            const val = e.target.value.toUpperCase().trim();
                            if (val && val !== da.going_to) {
                              setAirportOverrides((p) => ({ ...p, [da.name]: val }));
                            }
                          }}
                        />
                      </span>
                    )}
                    {da.notes && <span className="text-gray-400 text-[10px]">— {da.notes}</span>}
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-gray-400">No different airport entries for this week.</div>
            )}
            <div className="mt-3 pt-2 border-t">
              <div className="text-[10px] font-bold text-gray-500 uppercase mb-1">Add Override</div>
              <div className="flex gap-2">
                <select className="text-xs border rounded px-2 py-1 bg-white flex-1"
                  onChange={(e) => {
                    if (e.target.value) {
                      const name = e.target.value;
                      const airport = prompt(`Enter temporary airport for ${name} (e.g., ATL):`);
                      if (airport) {
                        setAirportOverrides((p) => ({ ...p, [name]: airport.toUpperCase() }));
                      }
                      e.target.value = "";
                    }
                  }}
                >
                  <option value="">Select crew member...</option>
                  {crew.filter((c) => c.active).map((c) => (
                    <option key={c.id} value={c.name}>{c.name} ({c.home_airports.join("/")})</option>
                  ))}
                </select>
              </div>
              {Object.keys(airportOverrides).length > 0 && (
                <div className="mt-2 space-y-1">
                  {Object.entries(airportOverrides).map(([name, apt]) => (
                    <div key={name} className="flex items-center gap-2 text-xs">
                      <span className="font-medium">{name}</span>
                      <span className="text-amber-600">→ temporarily at {apt}</span>
                      <button onClick={() => setAirportOverrides((p) => { const n = { ...p }; delete n[name]; return n; })}
                        className="text-red-400 hover:text-red-600">&times;</button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Section 3: Volunteer Preferences */}
        <div className="rounded-lg border bg-white shadow-sm overflow-hidden">
          <div className="px-4 py-3 bg-gray-50 border-b flex items-center justify-between">
            <div className="flex items-center gap-2">
              <input type="checkbox" checked={reviewChecks.volunteers_reviewed}
                onChange={(e) => setReviewChecks((p) => ({ ...p, volunteers_reviewed: e.target.checked }))}
                className="rounded border-gray-300" />
              <h3 className="text-sm font-semibold text-gray-700 uppercase tracking-wider">3. Volunteer Preferences</h3>
            </div>
            <span className="text-[10px] text-gray-400">{volunteers.length} responses</span>
          </div>
          <div className="p-4 text-xs">
            {volunteers.length > 0 ? (
              <div className="grid grid-cols-3 gap-4">
                <div>
                  <div className="font-bold text-green-700 mb-1">Early ({volunteers.filter((v) => v.parsed_preference === "early" || v.parsed_preference === "early_and_late").length})</div>
                  {volunteers.filter((v) => v.parsed_preference === "early" || v.parsed_preference === "early_and_late").map((v, i) => (
                    <div key={i} className="py-0.5 text-gray-700">{(v.crew_members as { name?: string } | null)?.name ?? `Unmatched (${v.slack_user_id})`}</div>
                  ))}
                </div>
                <div>
                  <div className="font-bold text-amber-700 mb-1">Late ({volunteers.filter((v) => v.parsed_preference === "late" || v.parsed_preference === "early_and_late").length})</div>
                  {volunteers.filter((v) => v.parsed_preference === "late" || v.parsed_preference === "early_and_late").map((v, i) => (
                    <div key={i} className="py-0.5 text-gray-700">{(v.crew_members as { name?: string } | null)?.name ?? `Unmatched (${v.slack_user_id})`}</div>
                  ))}
                </div>
                <div>
                  <div className="font-bold text-purple-700 mb-1">Standby ({volunteers.filter((v) => v.parsed_preference === "standby").length})</div>
                  {volunteers.filter((v) => v.parsed_preference === "standby").map((v, i) => (
                    <div key={i} className="py-0.5 text-gray-700">
                      {(v.crew_members as { name?: string } | null)?.name ?? `Unmatched (${v.slack_user_id})`}
                      {v.notes && <span className="text-gray-400 ml-1">— {v.notes}</span>}
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <div className="text-gray-400">No volunteer responses. Click Parse Slack Thread on Setup tab.</div>
            )}
          </div>
        </div>

        {/* Section 4: Tail Exclusions */}
        <div className="rounded-lg border bg-white shadow-sm overflow-hidden">
          <div className="px-4 py-3 bg-gray-50 border-b flex items-center justify-between">
            <div className="flex items-center gap-2">
              <input type="checkbox" checked={reviewChecks.exclusions_reviewed}
                onChange={(e) => setReviewChecks((p) => ({ ...p, exclusions_reviewed: e.target.checked }))}
                className="rounded border-gray-300" />
              <h3 className="text-sm font-semibold text-gray-700 uppercase tracking-wider">4. Exclusions</h3>
            </div>
            <span className="text-[10px] text-gray-400">{excludedTails.size} tails excluded</span>
          </div>
          <div className="p-4 text-xs">
            <div className="text-[10px] font-bold text-gray-500 uppercase mb-2">Exclude tails (MX, owner-flown, etc.)</div>
            <div className="flex flex-wrap gap-1.5">
              {tailSchedules.map((ts) => (
                <button key={ts.tail}
                  onClick={() => setExcludedTails((prev) => {
                    const next = new Set(prev);
                    if (next.has(ts.tail)) next.delete(ts.tail); else next.add(ts.tail);
                    return next;
                  })}
                  className={`px-2 py-1 rounded text-[10px] font-mono font-bold border ${
                    excludedTails.has(ts.tail)
                      ? "bg-red-100 border-red-300 text-red-700 line-through"
                      : "bg-white border-gray-200 text-gray-700 hover:bg-gray-50"
                  }`}
                >
                  {ts.tail}
                </button>
              ))}
            </div>
            {excludedTails.size > 0 && (
              <div className="mt-2 text-amber-600">
                Excluded: {[...excludedTails].join(", ")} — these tails will be skipped by the optimizer
              </div>
            )}
            <div className="mt-3 pt-2 border-t">
              <div className="text-[10px] font-bold text-gray-500 uppercase mb-2">Mark crew unavailable</div>
              <div className="flex flex-wrap gap-1.5">
                {crew.filter((c) => c.active).slice(0, 50).map((c) => (
                  <button key={c.id}
                    onClick={() => setUnavailableCrew((prev) => {
                      const next = new Set(prev);
                      if (next.has(c.name)) next.delete(c.name); else next.add(c.name);
                      return next;
                    })}
                    className={`px-1.5 py-0.5 rounded text-[9px] border ${
                      unavailableCrew.has(c.name)
                        ? "bg-red-100 border-red-300 text-red-700 line-through"
                        : "bg-white border-gray-200 text-gray-600 hover:bg-gray-50"
                    }`}
                  >
                    {c.name}
                  </button>
                ))}
              </div>
            </div>
            <div className="mt-3 pt-2 border-t">
              <div className="text-[10px] font-bold text-gray-500 uppercase mb-2">Add Uncrewed Aircraft</div>
              <div className="text-[10px] text-gray-400 mb-2">Aircraft in the fleet but not currently in the swap plan (no crew assigned)</div>
              {(() => {
                // Tails in swap plan or flight schedule
                const plannedTails = new Set([
                  ...tailSchedules.map((ts) => ts.tail),
                  ...Object.keys(swapAssignments ?? {}),
                  ...addedTails.map((t) => t.tail),
                ]);
                const uncrewed = icsFleet.filter((t) => !plannedTails.has(t.label));

                if (uncrewed.length === 0) return <div className="text-gray-400 text-[10px]">All fleet aircraft are in the schedule.</div>;

                return (
                  <div className="space-y-1">
                    <div className="flex flex-wrap gap-1.5">
                      {uncrewed.map((t) => {
                        const acLabel = t.aircraft_type === "C750" ? "CX" : t.aircraft_type === "CL30" ? "CL" : t.aircraft_type;
                        return (
                          <button key={t.label}
                            onClick={() => {
                              const loc = prompt(`Enter current location for ${t.label} (airport code, e.g., OPF):`);
                              if (loc) {
                                setAddedTails((prev) => [...prev, { tail: t.label, type: t.aircraft_type, location: loc.toUpperCase() }]);
                                addToast("success", `${t.label} added @ ${loc.toUpperCase()} — will need crew assigned`);
                              }
                            }}
                            className="px-2 py-1 rounded text-[10px] font-mono font-bold border bg-blue-50 border-blue-200 text-blue-700 hover:bg-blue-100"
                          >
                            + {t.label} [{acLabel}]
                          </button>
                        );
                      })}
                    </div>
                    {addedTails.length > 0 && (
                      <div className="mt-2 space-y-1">
                        {addedTails.map((t, i) => (
                          <div key={i} className="flex items-center gap-2 text-xs">
                            <span className="font-mono font-bold">{t.tail}</span>
                            <span className="text-gray-500">@ {t.location}</span>
                            <span className={`text-[9px] px-1 py-0.5 rounded ${t.type === "C750" ? "bg-green-100 text-green-700" : "bg-yellow-100 text-yellow-700"}`}>
                              {t.type === "C750" ? "Cit X" : "CL"}
                            </span>
                            <span className="text-green-600">Added — needs oncoming crew</span>
                            <button onClick={() => setAddedTails((prev) => prev.filter((_, j) => j !== i))}
                              className="text-red-400 hover:text-red-600">&times;</button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })()}
            </div>
          </div>
        </div>

        {/* Section 5: Calendar Preview */}
        <div className="rounded-lg border bg-white shadow-sm overflow-hidden">
          <div className="px-4 py-3 bg-gray-50 border-b flex items-center justify-between">
            <div className="flex items-center gap-2">
              <input type="checkbox" checked={reviewChecks.calendar_reviewed}
                onChange={(e) => setReviewChecks((p) => ({ ...p, calendar_reviewed: e.target.checked }))}
                className="rounded border-gray-300" />
              <h3 className="text-sm font-semibold text-gray-700 uppercase tracking-wider">5. Oncoming Rotation</h3>
            </div>
            <span className="text-[10px] text-gray-400">
              {crewInfoData?.target_week_crew ? `Rotation ${crewInfoData.target_week_crew.rotation}` : "—"}
            </span>
          </div>
          <div className="p-4 text-xs">
            {crewInfoData?.target_week_crew ? (
              <div className="space-y-2">
                <div className="font-medium text-gray-700">{crewInfoData.target_week_crew.date_range} (Rotation {crewInfoData.target_week_crew.rotation})</div>
                <div className="grid grid-cols-2 gap-4">
                  {(["pic", "sic"] as const).map((role) => {
                    const rd = crewInfoData.target_week_crew![role];
                    const dualCount = rd.dual.length;
                    const cxTotal = rd.citation_x.length + dualCount;
                    const clTotal = rd.challenger.length + dualCount;
                    return (
                      <div key={role}>
                        <div className="font-bold text-gray-600 mb-1">{role === "pic" ? "Captains (PICs)" : "First Officers (SICs)"}</div>
                        <div className="text-[10px] text-green-700 mb-0.5">
                          Citation X ({rd.citation_x.length}{dualCount > 0 ? ` + ${dualCount} dual = ${cxTotal}` : ""}): {rd.citation_x.join(", ")}
                        </div>
                        <div className="text-[10px] text-yellow-700 mb-0.5">
                          Challenger ({rd.challenger.length}{dualCount > 0 ? ` + ${dualCount} dual = ${clTotal}` : ""}): {rd.challenger.join(", ")}
                        </div>
                        {dualCount > 0 && (
                          <div className="text-[10px] text-purple-700">Dual-Rated ({dualCount}): {rd.dual.join(", ")}</div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : (
              <div className="text-gray-400">Upload Crew Info Excel to see calendar data.</div>
            )}
          </div>
        </div>

        {/* Section 6: Unified Constraints & Pairings */}
        <PairConstraintEditor
          constraints={swapConstraints}
          onConstraintsChange={setSwapConstraints}
          selectedSwapDays={selectedSwapDays}
          crew={crew}
          tails={swapAssignments ? Object.keys(swapAssignments).sort() : [...new Set(flights.filter(f => f.tail_number).map(f => f.tail_number!))].sort()}
          onScanSlack={async () => {
            setSlackScanLoading(true);
            setSlackScanError(null);
            try {
              const res = await fetch("/api/crew/parse-directives", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ swap_date: selectedDate.toISOString().slice(0, 10) }),
              });
              const data = await res.json();
              if (!res.ok) { setSlackScanError(data.error ?? "Scan failed"); return; }
              const newSugs = (data.directives ?? []).filter((d: SwapConstraint & { _reason?: string }) =>
                !swapConstraints.some((c) => {
                  if (c.type !== d.type) return false;
                  if (c.type === "force_tail" && d.type === "force_tail") return c.crew_name === d.crew_name && c.tail === d.tail;
                  if (c.type === "force_pair" && d.type === "force_pair") return (c.crew_a === d.crew_a && c.crew_b === d.crew_b) || (c.crew_a === d.crew_b && c.crew_b === d.crew_a);
                  if (c.type === "force_fleet" && d.type === "force_fleet") return c.crew_name === d.crew_name && c.aircraft_type === d.aircraft_type;
                  return false;
                })
              );
              setSlackSuggestions(newSugs);
            } catch (e) { setSlackScanError(e instanceof Error ? e.message : "Scan failed"); }
            finally { setSlackScanLoading(false); }
          }}
          slackScanLoading={slackScanLoading}
          slackSuggestions={slackSuggestions}
          onAcceptSuggestion={(i) => {
            const s = slackSuggestions[i];
            if (s) {
              const constraint = { ...s } as SwapConstraint;
              delete (constraint as Record<string, unknown>)._reason;
              setSwapConstraints((prev) => [...prev, constraint]);
              setSlackSuggestions((prev) => prev.filter((_, j) => j !== i));
            }
          }}
          onDismissSuggestion={(i) => setSlackSuggestions((prev) => prev.filter((_, j) => j !== i))}
        />
        {slackScanError && (
          <div className="text-[11px] text-red-600 bg-red-50 border border-red-200 rounded px-3 py-2 -mt-2">
            Scan error: {slackScanError}
          </div>
        )}


        {/* Section 7: Swap Day Assignment (per-tail) */}
        <div className="rounded-lg border p-4 space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-gray-700 uppercase tracking-wider">8. Swap Day Assignment</h3>
            <span className="text-xs text-gray-400">Assign tails to any weekday swap</span>
          </div>
          <p className="text-xs text-gray-500">
            Default: all tails swap on Wednesday. Assign specific tails to other weekdays for staggered swaps or better flight options.
          </p>
          {(() => {
            const weekdays: SwapDay[] = ["monday", "tuesday", "wednesday", "thursday", "friday"];
            const dayColors: Record<string, { label: string; bg: string; text: string; btn: string }> = {
              monday:    { label: "Mon", bg: "bg-purple-50", text: "text-purple-600", btn: "text-purple-500 hover:text-purple-700" },
              tuesday:   { label: "Tue", bg: "bg-blue-50", text: "text-blue-600", btn: "text-blue-500 hover:text-blue-700" },
              wednesday: { label: "Wed", bg: "bg-green-50", text: "text-green-600", btn: "text-green-500 hover:text-green-700" },
              thursday:  { label: "Thu", bg: "bg-amber-50", text: "text-amber-600", btn: "text-amber-500 hover:text-amber-700" },
              friday:    { label: "Fri", bg: "bg-red-50", text: "text-red-600", btn: "text-red-500 hover:text-red-700" },
            };
            const allTails = [...new Set(flights.filter(f => f.tail_number).map(f => f.tail_number!))].sort();
            const assignedTails = new Set(Object.keys(tailSwapDays));

            return (
              <div className="grid grid-cols-5 gap-2">
                {weekdays.map(day => {
                  const dc = dayColors[day];
                  const isDefault = day === "wednesday";
                  const dayTails = isDefault
                    ? allTails.filter(t => !assignedTails.has(t) && !excludedTails.has(t))
                    : Object.entries(tailSwapDays).filter(([, d]) => d === day).map(([t]) => t);

                  return (
                    <div key={day}>
                      <div className={`text-xs font-semibold ${dc.text} mb-1`}>
                        {dc.label}{isDefault ? " (default)" : ""}
                      </div>
                      <div className="space-y-1 max-h-40 overflow-auto">
                        {dayTails.map(tail => (
                          <div key={tail} className={`flex items-center justify-between ${isDefault ? "bg-gray-50" : dc.bg} rounded px-2 py-0.5`}>
                            <span className="font-mono text-xs text-gray-700">{tail}</span>
                            {isDefault ? (
                              <select
                                className="text-[9px] border rounded px-1 py-0.5 bg-white text-gray-500"
                                value=""
                                onChange={(e) => {
                                  if (e.target.value) setTailSwapDays(prev => ({ ...prev, [tail]: e.target.value as SwapDay }));
                                }}
                              >
                                <option value="">→</option>
                                {weekdays.filter(d => d !== "wednesday").map(d => (
                                  <option key={d} value={d}>{dayColors[d].label}</option>
                                ))}
                              </select>
                            ) : (
                              <button
                                onClick={() => setTailSwapDays(prev => { const n = { ...prev }; delete n[tail]; return n; })}
                                className="text-[10px] text-red-500 hover:text-red-700"
                              >
                                ✕
                              </button>
                            )}
                          </div>
                        ))}
                        {dayTails.length === 0 && !isDefault && (
                          <span className="text-[10px] text-gray-400 italic">—</span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            );
          })()}
        </div>

        {/* Section 8 was daily pairs — now consolidated into Section 6 above */}

        {/* Ready to optimize */}
        <div className={`rounded-lg border-2 p-4 text-center ${
          Object.values(reviewChecks).every(Boolean) ? "border-green-300 bg-green-50" : "border-amber-300 bg-amber-50"
        }`}>
          <div className="text-sm font-medium text-gray-700 mb-2">
            {Object.values(reviewChecks).every(Boolean)
              ? "All checks complete — ready to optimize!"
              : `${Object.values(reviewChecks).filter(Boolean).length}/5 checks completed`}
          </div>
          <button
            onClick={() => setActiveTab("plan")}
            className={`px-6 py-2 text-sm font-medium rounded-lg ${
              Object.values(reviewChecks).every(Boolean)
                ? "bg-blue-600 text-white hover:bg-blue-700"
                : "bg-gray-200 text-gray-600 hover:bg-gray-300"
            }`}
          >
            Go to Plan Tab &rarr;
          </button>
        </div>
      </div>

      </>}

      {/* ═══ PLAN TAB ═══ */}
      {activeTab === "plan" && <>

      {/* Swap Optimizer */}
      <div className="rounded-lg border bg-white shadow-sm overflow-hidden">
        {/* Sticky toolbar */}
        <div className="sticky top-0 z-20 bg-white/95 backdrop-blur-sm border-b shadow-sm px-4 py-3 flex flex-wrap items-center justify-between gap-2">
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
                {routeStatus.last_computed && ` (${new Date(routeStatus.last_computed).toLocaleString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false })})`}
                {routeStatus.is_stale && " — stale"}
              </span>
            )}
            {/* Load FREEZE button (also on Plan tab for visibility) */}
            {freezeTabs.length > 0 && (
              <div className="relative">
                <button
                  onClick={() => { if (freezeTabs.length === 1) loadFreezeSheet(freezeTabs[0]); else setShowFreezeMenu(!showFreezeMenu); }}
                  disabled={loadingFreeze}
                  className={`px-2.5 py-1.5 text-[10px] font-medium border rounded-lg ${loadingFreeze ? "bg-gray-100 text-gray-400" : "bg-amber-50 text-amber-700 hover:bg-amber-100 border-amber-200"}`}
                >
                  {loadingFreeze ? "Loading..." : "Load FREEZE"}
                </button>
                {showFreezeMenu && freezeTabs.length > 1 && (
                  <div className="absolute right-0 top-full mt-1 bg-white border rounded-lg shadow-lg z-50 min-w-[240px]">
                    {freezeTabs.map(tab => (
                      <button key={tab} onClick={() => loadFreezeSheet(tab)} className="w-full text-left px-3 py-2 text-xs hover:bg-amber-50 border-b last:border-b-0 text-gray-700">{tab}</button>
                    ))}
                  </div>
                )}
              </div>
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
              onClick={runFullOptimize}
              disabled={optimizing || computingRoutes || seedingFlights || detectingRotation || sheetValidation?.valid === false}
              className={`px-4 py-1.5 text-xs font-semibold border rounded-lg ${
                optimizing || computingRoutes || seedingFlights || detectingRotation || sheetValidation?.valid === false
                  ? "bg-gray-100 text-gray-400 border-gray-200"
                  : "bg-blue-600 text-white hover:bg-blue-700 border-blue-600 shadow-sm"
              }`}
              title={sheetValidation?.valid === false ? "Fix sheet errors before optimizing" : "Auto-detect rotation → seed flights → compute routes → optimize"}
            >
              {optimizing ? (optimizeStatus ?? "Optimizing...") : "Optimize"}
            </button>
            <button
              onClick={() => setShowAdvanced(!showAdvanced)}
              className="px-2 py-1.5 text-[10px] font-medium text-gray-400 hover:text-gray-600"
              title="Show individual step buttons"
            >
              {showAdvanced ? "▾ Advanced" : "▸ Advanced"}
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
                  <button
                    onClick={() => setSwapView("assign")}
                    className={`px-2.5 py-1.5 text-xs font-medium border-l ${swapView === "assign" ? "bg-purple-50 text-purple-700" : "bg-white text-gray-500 hover:bg-gray-50"}`}
                  >
                    Assign
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
                {/* Confirm All button */}
                {(() => {
                  const solvedRows = swapPlan.rows.filter(r => r.travel_type !== "none");
                  const tentativeCount = solvedRows.filter(r => !r.confirmed).length;
                  if (tentativeCount === 0) return null;
                  return (
                    <button
                      onClick={confirmAll}
                      className="px-3 py-1.5 text-xs font-medium border rounded-lg bg-green-50 text-green-700 hover:bg-green-100 border-green-200"
                      title={`Confirm all ${tentativeCount} tentative crew`}
                    >
                      Confirm All ({tentativeCount})
                    </button>
                  );
                })()}
              </>
            )}
          </div>
        </div>

        {/* Advanced: individual step buttons */}
        {showAdvanced && (
          <div className="px-4 py-2 bg-gray-50 border-b flex items-center gap-2 text-[10px]">
            <span className="text-gray-400 font-medium mr-1">Manual steps:</span>
            <button
              onClick={detectRotation}
              disabled={detectingRotation || optimizing}
              className={`px-2.5 py-1 font-medium border rounded ${
                detectingRotation ? "bg-gray-100 text-gray-400" : "bg-green-50 text-green-700 hover:bg-green-100 border-green-200"
              }`}
            >
              {detectingRotation ? "Detecting..." : "Auto-Detect Rotation"}
            </button>
            <button
              onClick={computeRoutes}
              disabled={computingRoutes || seedingFlights || optimizing}
              className={`px-2.5 py-1 font-medium border rounded ${
                computingRoutes || seedingFlights ? "bg-gray-100 text-gray-400" : "bg-amber-50 text-amber-700 hover:bg-amber-100 border-amber-200"
              }`}
              title="Seed flight cache + compute routes for all crew-to-swap pairs (swap day + next day)"
            >
              {computingRoutes || seedingFlights ? "Computing Routes..." : "Compute Routes"}
            </button>
            <button
              onClick={() => runOptimizer()}
              disabled={optimizing || computingRoutes || sheetValidation?.valid === false}
              className={`px-2.5 py-1 font-medium border rounded ${
                optimizing || sheetValidation?.valid === false ? "bg-gray-100 text-gray-400" : "bg-blue-50 text-blue-700 hover:bg-blue-100 border-blue-200"
              }`}
            >
              {optimizing ? "Optimizing..." : "Run Optimizer Only"}
            </button>
          </div>
        )}

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
                {/* Confirmed / tentative summary */}
                {(() => {
                  const solvedRows = swapPlan.rows.filter(r => r.travel_type !== "none");
                  const confirmedCount = solvedRows.filter(r => r.confirmed).length;
                  const tentativeCount = solvedRows.length - confirmedCount;
                  if (solvedRows.length === 0) return null;
                  return (
                    <span className={`text-xs font-medium px-1.5 py-0.5 rounded ${
                      tentativeCount === 0 ? "bg-green-100 text-green-700" : "bg-yellow-100 text-yellow-700"
                    }`}>
                      {confirmedCount} confirmed / {tentativeCount} tentative
                    </span>
                  );
                })()}
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
                    Saved v{savedPlanMeta.version} — {new Date(savedPlanMeta.created_at).toLocaleString(undefined, { weekday: "short", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false })}
                  </span>
                )}
                {planImpacts.filter(i => !i.resolved).length > 0 && (
                  <span className="text-xs font-bold text-red-700 px-2 py-0.5 rounded bg-red-100">
                    {planImpacts.filter(i => i.severity === "critical").length} critical / {planImpacts.filter(i => !i.resolved).length} impacts
                  </span>
                )}
              </div>
            </div>

            {/* Impact action bar — only show when a plan has been saved */}
            {savedPlanMeta && planImpacts.filter(i => !i.resolved).length > 0 && (
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
                {(swapPlan.two_pass.pass3_solved ?? 0) > 0 && (
                  <div className="mt-1">
                    <span className="text-green-700 text-xs font-medium">
                      Pass 3: +{swapPlan.two_pass.pass3_solved} tails via {swapPlan.two_pass.pass3_standby_used?.length ?? 0} standby crew [relaxed constraints]
                    </span>
                    <div className="mt-0.5 flex flex-wrap gap-2">
                      {swapPlan.two_pass.pass3_standby_used?.map((s, i) => (
                        <span key={i} className="inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded bg-green-100 text-green-700">
                          {s.name} ({s.role}) pulled from standby for {s.tail}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
                {(swapPlan.two_pass.feedback_loop_solved ?? 0) > 0 && (
                  <div className="mt-1">
                    <span className="text-orange-700 text-xs font-medium">
                      Feedback Loop: +{swapPlan.two_pass.feedback_loop_solved} tails via {swapPlan.two_pass.feedback_loop_iterations} reassignment(s)
                    </span>
                    <div className="mt-0.5 flex flex-wrap gap-2">
                      {swapPlan.two_pass.feedback_loop_swaps?.map((s, i) => (
                        <span key={i} className="inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded bg-orange-100 text-orange-700">
                          {s.crew_moved} ({s.role}) {s.from_tail} → {s.to_tail}{s.new_swap_point ? ` @ ${s.new_swap_point}` : ""}, backfill: {s.backfilled_by}
                        </span>
                      ))}
                    </div>
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

            {/* Diagnostics: why unsolved? */}
            {swapPlan.diagnostics && swapPlan.diagnostics.unsolved_tails.length > 0 && (
              <div className="px-4 py-2 bg-red-50 border-b space-y-2">
                <div className="text-xs font-semibold text-red-800">Unsolved Diagnostics</div>
                <div className="space-y-1">
                  {swapPlan.diagnostics.unsolved_tails.map((d, i) => (
                    <div key={i} className="text-xs text-red-700">
                      <span className="font-medium">{d.tail} {d.role}:</span> {d.reason}
                      <span className="text-red-400 ml-1">({d.total_crew_checked} crew checked)</span>
                    </div>
                  ))}
                </div>
                {swapPlan.diagnostics.type_mismatch_blockers.length > 0 && (
                  <div className="mt-1 p-2 bg-red-100 rounded text-xs text-red-800">
                    <span className="font-semibold">Type mismatch blockers</span> — these tails could be solved by cross-type assignment:
                    {swapPlan.diagnostics.type_mismatch_blockers.map((b, i) => (
                      <div key={i} className="ml-2">{b.tail} ({b.role}): needs <span className="font-medium">{b.tail_type}</span>, pool has [{b.crew_types_available.join(", ")}]</div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Day comparison toggle (when multi-day optimization is active) */}
            {Object.keys(dayPlans).length >= 2 && (
              <DayResultsTabs
                dayPlans={dayPlans as Record<string, { ok: boolean; swap_date: string; rows: { name: string; tail_number: string; role: string; direction: string; travel_type: string; cost_estimate?: number | null; score?: number }[]; total_cost: number; plan_score: number; solved_count?: number; unsolved_count?: number }>}
                activePlanDay={activePlanDay}
                onSelectDay={(day) => {
                  setActivePlanDay(day);
                  if (dayPlans[day]) setSwapPlan(dayPlans[day]);
                }}
                onSelectCombined={() => {
                  const plans = Object.values(dayPlans);
                  if (plans.length === 0) return;
                  const merged = {
                    ...plans[0],
                    rows: plans.flatMap((p) => p.rows ?? []),
                    total_cost: plans.reduce((s, p) => s + (p.total_cost ?? 0), 0),
                  } as SwapPlanResult;
                  setSwapPlan(merged);
                }}
              />
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

            {/* Volunteer preferences quick reference */}
            {volunteers.length > 0 && (
              <div className="border-b">
                <button
                  onClick={() => setShowVolunteers(!showVolunteers)}
                  className="w-full px-4 py-1.5 text-[10px] text-gray-500 hover:bg-gray-50 flex items-center justify-between"
                >
                  <span>Volunteer Preferences ({volunteers.length})</span>
                  <span>{showVolunteers ? "Hide" : "Show"}</span>
                </button>
                {showVolunteers && (
                  <div className="px-4 py-2 bg-blue-50/30 text-xs space-y-1">
                    <div className="grid grid-cols-3 gap-2">
                      <div>
                        <span className="font-semibold text-green-700">Early: </span>
                        <span className="text-gray-600">
                          {volunteers.filter((v) => v.parsed_preference === "early" || v.parsed_preference === "early_and_late")
                            .map((v) => (v.crew_members as { name?: string } | null)?.name ?? "?").join(", ") || "none"}
                        </span>
                      </div>
                      <div>
                        <span className="font-semibold text-amber-700">Late: </span>
                        <span className="text-gray-600">
                          {volunteers.filter((v) => v.parsed_preference === "late" || v.parsed_preference === "early_and_late")
                            .map((v) => (v.crew_members as { name?: string } | null)?.name ?? "?").join(", ") || "none"}
                        </span>
                      </div>
                      <div>
                        <span className="font-semibold text-purple-700">Standby: </span>
                        <span className="text-gray-600">
                          {volunteers.filter((v) => v.parsed_preference === "standby")
                            .map((v) => (v.crew_members as { name?: string } | null)?.name ?? "?").join(", ") || "none"}
                        </span>
                      </div>
                    </div>
                  </div>
                )}
              </div>
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
                            {new Date(v.created_at).toLocaleString(undefined, { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false })}
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

            {swapView === "assign" ? (
              <AssignView
                rows={swapPlan.rows}
                onAssignCrew={assignCrew}
                onRecomputeTail={(tail) => {
                  const tailRows = swapPlan.rows.filter((r) => r.tail_number === tail);
                  const onPic = tailRows.find((r) => r.direction === "oncoming" && r.role === "PIC");
                  const onSic = tailRows.find((r) => r.direction === "oncoming" && r.role === "SIC");
                  const offPic = tailRows.find((r) => r.direction === "offgoing" && r.role === "PIC");
                  const offSic = tailRows.find((r) => r.direction === "offgoing" && r.role === "SIC");
                  const sp = onPic?.swap_location ?? onSic?.swap_location ?? offPic?.swap_location ?? "";
                  if (sp) handleSwapPointChange(tail, sp);
                }}
                swapDate={selectedDate.toISOString().slice(0, 10)}
                standbyPics={swapPlan.crew_assignment?.standby?.pic ?? []}
                standbySics={swapPlan.crew_assignment?.standby?.sic ?? []}
                tailAircraftTypes={tailAircraftTypes}
              />
            ) : (
              <SwapSheet rows={swapPlan.rows} view={swapView} impacts={savedPlanMeta ? planImpacts : []} impactedTails={savedPlanMeta ? impactedTails : new Set()}
                lockedTails={lockedTails} onLockTail={toggleLockTail} onAssignCrew={assignCrew} pool={oncomingPool}
                onChangeTransport={openFlightPicker} onSwapPointChange={handleSwapPointChange} onCrewSwapPointChange={handleCrewSwapPointChange}
                onArrivalOverride={handleArrivalOverride}
                onToggleConfirm={toggleConfirmRow} onConfirmTail={confirmTail}
                badPairings={crewInfoData?.bad_pairings} checkairmen={crewInfoData?.checkairmen}
                flights={flights} selectedDate={selectedDate} tailAircraftTypes={tailAircraftTypes} />
            )}
          </div>
        )}

        {!swapPlan && !optimizeError && (
          <div className="px-4 py-6 text-center text-sm text-gray-400">
            {loadingPlan ? "Loading saved plan..." : (
              routeStatus && routeStatus.total_routes > 0
                ? `${routeStatus.total_routes.toLocaleString()} flight options cached. Click Optimize to run.`
                : `Upload roster then click Refresh Routes to pre-compute routes for ${selectedDate.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`
            )}
          </div>
        )}
      </div>

      {/* FBO → Commercial Airport Reference */}
      <AirportAliasPanel flights={flights} selectedDate={selectedDate} />

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

        {/* Unacknowledged alerts — grouped by tail + change_type + route to deduplicate */}
        {swapAlerts.filter((a) => !a.acknowledged).length > 0 ? (
          <div className="divide-y">
            {/* Acknowledge All button */}
            <div className="px-4 py-2 bg-gray-50/50 flex justify-end">
              <button
                onClick={async () => {
                  const dateStr = selectedDate.toISOString().slice(0, 10);
                  await fetch("/api/crew/swap-alerts", {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ swap_date: dateStr, acknowledge_all: true }),
                  });
                  await loadAlerts();
                  addToast("success", "All alerts acknowledged");
                }}
                className="px-3 py-1 text-[10px] rounded bg-gray-200 text-gray-600 hover:bg-gray-300 font-medium"
              >
                Acknowledge All ({swapAlerts.filter((a) => !a.acknowledged).length})
              </button>
            </div>
            {/* Group alerts: same tail + change_type + route → show once with count */}
            {(() => {
              const unacked = swapAlerts.filter((a) => !a.acknowledged);
              const groups = new Map<string, typeof unacked>();
              for (const a of unacked) {
                const parseVal = (v: unknown): Record<string, string> | null => {
                  if (!v) return null;
                  try { return typeof v === "string" ? JSON.parse(v) : v as Record<string, string>; } catch { return null; }
                };
                const nv = parseVal(a.new_value);
                const route = nv ? `${nv.departure_icao ?? ""}-${nv.arrival_icao ?? ""}` : "";
                const key = `${a.tail_number}|${a.change_type}|${route}`;
                if (!groups.has(key)) groups.set(key, []);
                groups.get(key)!.push(a);
              }
              return Array.from(groups.values()).map((group) => {
                const a = group[0]; // most recent (already sorted desc)
                const count = group.length;
                return { ...a, _count: count, _groupIds: group.map((g) => g.id) };
              });
            })().map((a) => {
              // Parse the stored JSON values for human-readable display
              const parseVal = (v: unknown): Record<string, string> | null => {
                if (!v) return null;
                try { return typeof v === "string" ? JSON.parse(v) : v as Record<string, string>; } catch { return null; }
              };
              const oldVal = parseVal(a.old_value);
              const newVal = parseVal(a.new_value);
              const icaoToIata = (icao: string) => icao?.length === 4 && icao.startsWith("K") ? icao.slice(1) : icao;
              const fmtDt = (iso: string) => {
                if (!iso) return "";
                const d = new Date(iso);
                return d.toLocaleString(undefined, { weekday: "short", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
              };

              let description = "";
              if (a.change_type === "added" && newVal) {
                const dep = icaoToIata(newVal.departure_icao ?? "");
                const arr = icaoToIata(newVal.arrival_icao ?? "");
                const time = fmtDt(newVal.scheduled_departure ?? "");
                description = `${dep} → ${arr}  ${time}`;
              } else if (a.change_type === "cancelled" && oldVal) {
                const dep = icaoToIata(oldVal.departure_icao ?? "");
                const arr = icaoToIata(oldVal.arrival_icao ?? "");
                description = `${dep} → ${arr} removed`;
              } else if (a.change_type === "time_change" && oldVal && newVal) {
                const dep = icaoToIata(newVal.departure_icao ?? oldVal.departure_icao ?? "");
                const arr = icaoToIata(newVal.arrival_icao ?? oldVal.arrival_icao ?? "");
                const oldTime = fmtDt(oldVal.scheduled_departure ?? "");
                const newTime = fmtDt(newVal.scheduled_departure ?? "");
                description = `${dep} → ${arr}  ${oldTime} → ${newTime}`;
              } else if (a.change_type === "airport_change" && oldVal && newVal) {
                const oldDep = icaoToIata(oldVal.departure_icao ?? "");
                const newDep = icaoToIata(newVal.departure_icao ?? "");
                const oldArr = icaoToIata(oldVal.arrival_icao ?? "");
                const newArr = icaoToIata(newVal.arrival_icao ?? "");
                description = oldDep !== newDep ? `dep ${oldDep} → ${newDep}` : `arr ${oldArr} → ${newArr}`;
              }

              return (
              <div key={a.id} className="px-4 py-3 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <span className={`text-[10px] px-2 py-0.5 rounded font-bold shrink-0 ${
                    a.change_type === "cancelled" ? "bg-red-100 text-red-700"
                    : a.change_type === "time_change" ? "bg-amber-100 text-amber-700"
                    : a.change_type === "airport_change" ? "bg-red-100 text-red-700"
                    : "bg-blue-100 text-blue-700"
                  }`}>
                    {a.change_type.replace("_", " ")}
                  </span>
                  <span className="font-mono font-bold text-sm text-gray-900">{a.tail_number}</span>
                  <span className="text-xs text-gray-700">{description}</span>
                  {(a as unknown as { _count: number })._count > 1 && (
                    <span className="text-[9px] px-1.5 py-0.5 rounded bg-gray-200 text-gray-500 font-medium">
                      {(a as unknown as { _count: number })._count}x
                    </span>
                  )}
                  <span className="text-[10px] text-gray-400 shrink-0">
                    detected {new Date(a.detected_at).toLocaleString(undefined, { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false })}
                  </span>
                </div>
                <button
                  onClick={async () => {
                    const ids = (a as unknown as { _groupIds: string[] })._groupIds ?? [a.id];
                    for (const id of ids) await acknowledgeAlert(id);
                  }}
                  className="px-2.5 py-1 text-xs rounded bg-gray-100 text-gray-600 hover:bg-gray-200 shrink-0"
                >
                  Acknowledge{(a as unknown as { _count: number })._count > 1 ? ` (${(a as unknown as { _count: number })._count})` : ""}
                </button>
              </div>
              );
            })}
          </div>
        ) : (
          <div className="px-4 py-8 text-center text-sm text-gray-400">
            No unacknowledged flight changes for this swap date.
          </div>
        )}
      </div>

      {/* Plan impacts — active */}
      {planImpacts.filter(i => !i.resolved).length > 0 && (
        <div className="rounded-lg border bg-white shadow-sm overflow-hidden">
          <div className="px-4 py-3 bg-red-50 border-b flex items-center justify-between">
            <h3 className="text-sm font-semibold text-red-700 uppercase tracking-wider">
              Active Impacts ({planImpacts.filter(i => !i.resolved).length})
            </h3>
            <button
              onClick={() => { checkImpacts(); }}
              className="px-2.5 py-1 text-[10px] rounded bg-red-100 text-red-700 hover:bg-red-200"
            >
              Refresh
            </button>
          </div>
          <div className="divide-y">
            {planImpacts.filter(i => !i.resolved).map((imp) => (
              <div key={imp.id} className={`px-4 py-3 ${imp.severity === "critical" ? "bg-red-50/50" : imp.severity === "warning" ? "bg-amber-50/50" : "bg-blue-50/50"}`}>
                <div className="flex items-center justify-between mb-1">
                  <div className="flex items-center gap-3">
                    <span className={`text-[10px] px-2 py-0.5 rounded font-bold ${
                      imp.severity === "critical" ? "bg-red-100 text-red-700"
                      : imp.severity === "warning" ? "bg-amber-100 text-amber-700"
                      : "bg-blue-100 text-blue-700"
                    }`}>
                      {imp.severity}
                    </span>
                    <span className="font-mono font-bold text-sm text-gray-900">{imp.tail_number}</span>
                    {imp.detected_at && (
                      <span className="text-[10px] text-gray-400">
                        {new Date(imp.detected_at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false })}
                      </span>
                    )}
                  </div>
                  <div className="flex gap-1.5">
                    <button
                      onClick={() => resolveImpact(imp.id, "no_action_needed")}
                      className="px-2 py-0.5 text-[10px] rounded bg-gray-100 text-gray-600 hover:bg-gray-200"
                    >
                      No Action
                    </button>
                    <button
                      onClick={() => resolveImpact(imp.id, "manual_fix")}
                      className="px-2 py-0.5 text-[10px] rounded bg-green-100 text-green-700 hover:bg-green-200"
                    >
                      Resolved
                    </button>
                    <button
                      onClick={() => resolveImpact(imp.id, "dismissed")}
                      className="px-2 py-0.5 text-[10px] rounded bg-gray-50 text-gray-400 hover:bg-gray-100"
                    >
                      Dismiss
                    </button>
                  </div>
                </div>
                <div className="ml-16">
                  {/* Show the detail once (it's usually the same for all crew on a tail) */}
                  {(() => {
                    const uniqueDetails = [...new Set(imp.affected_crew.map((c) => c.detail))];
                    const crewNames = imp.affected_crew.map((c) => `${c.name} (${c.role} ${c.direction})`);
                    return (
                      <>
                        <div className="text-xs text-gray-700 mb-1">{uniqueDetails.join(" | ")}</div>
                        <div className="text-[10px] text-gray-400">Affects: {crewNames.join(", ")}</div>
                      </>
                    );
                  })()}
                </div>
                {/* Suggestions */}
                {imp.suggestions && imp.suggestions.length > 0 && (
                  <div className="mt-2 ml-16 space-y-1">
                    <div className="text-[10px] text-gray-500 uppercase font-semibold">Suggested Actions</div>
                    {imp.suggestions.map((s, si) => (
                      <div key={si} className="flex items-start gap-2 text-xs">
                        <span className={`mt-0.5 w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                          s.type === "no_action" ? "bg-green-400"
                          : s.type === "earlier_flight" ? "bg-blue-400"
                          : s.type === "ground_transport" ? "bg-purple-400"
                          : s.type === "reoptimize" ? "bg-amber-400"
                          : "bg-gray-400"
                        }`} />
                        <span className="text-gray-700">{s.description}</span>
                        {s.estimated_cost_delta != null && s.estimated_cost_delta > 0 && (
                          <span className="text-gray-400 flex-shrink-0">(~${s.estimated_cost_delta})</span>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Resolved impacts (collapsed) */}
      {planImpacts.filter(i => i.resolved).length > 0 && (
        <details className="rounded-lg border bg-white shadow-sm overflow-hidden">
          <summary className="px-4 py-3 bg-green-50 border-b text-sm font-semibold text-green-700 uppercase tracking-wider cursor-pointer">
            Resolved ({planImpacts.filter(i => i.resolved).length})
          </summary>
          <div className="divide-y">
            {planImpacts.filter(i => i.resolved).map((imp) => (
              <div key={imp.id} className="px-4 py-2 bg-gray-50/50">
                <div className="flex items-center gap-3">
                  <span className="text-[10px] px-2 py-0.5 rounded font-bold bg-green-100 text-green-700">
                    {imp.resolution_type?.replace(/_/g, " ") ?? "resolved"}
                  </span>
                  <span className="font-mono text-sm text-gray-500">{imp.tail_number}</span>
                  <span className="text-xs text-gray-400">
                    {imp.affected_crew.map((c) => c.name).join(", ")}
                  </span>
                  {imp.resolved_at && (
                    <span className="text-[10px] text-gray-400 ml-auto">
                      {new Date(imp.resolved_at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false })}
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </details>
      )}

      </>}

      {/* Toast notifications */}
      <ToastContainer toasts={toasts} onDismiss={removeToast} />

      {/* Flight Picker Modal */}
      {selectedCrewSlot && (
        <FlightPickerModal
          crewMemberId={selectedCrewSlot.crewMemberId}
          crewName={selectedCrewSlot.crewName}
          crewRole={selectedCrewSlot.role}
          homeAirports={selectedCrewSlot.homeAirports}
          destinationIcao={selectedCrewSlot.swapLocation}
          swapDate={selectedDate.toISOString().slice(0, 10)}
          direction={selectedCrewSlot.direction}
          tailNumber={selectedCrewSlot.tailNumber}
          firstLegDep={selectedCrewSlot.firstLegDep}
          lastLegArr={selectedCrewSlot.lastLegArr}
          onSelect={handleFlightSelection}
          onClose={() => setSelectedCrewSlot(null)}
        />
      )}
    </div>
  );
}
