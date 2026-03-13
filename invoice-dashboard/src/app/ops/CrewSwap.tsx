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

// Matches CrewSwapRow from swapOptimizer.ts
type CrewSwapRow = {
  name: string;
  home_airports: string[];
  role: "PIC" | "SIC";
  direction: "oncoming" | "offgoing";
  aircraft_type: string;
  tail_number: string;
  swap_location: string | null;
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
  notes: string | null;
  warnings: string[];
  alt_flights: { flight_number: string; dep: string; arr: string; price: string }[];
  backup_flight: string | null;
  score: number;
};

type SwapPlanResult = {
  ok: boolean;
  swap_date: string;
  rows: CrewSwapRow[];
  warnings: string[];
  commercial_flights_searched: number;
  total_cost: number;
  plan_score: number;
  solved_count?: number;
  unsolved_count?: number;
  crew_assignment?: {
    standby: { pic: string[]; sic: string[] };
    details: { name: string; tail: string; cost: number; reason: string }[];
  };
};

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

function SwapSheet({ rows }: { rows: CrewSwapRow[] }) {
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
          {/* ONCOMING PILOTS */}
          <SectionHeader title="Oncoming Pilots — Pilot In-Command" count={oncomingPics.length} color="bg-green-50 text-green-700 border-t-2 border-green-300" />
          {oncomingPics.map((r, i) => <SwapSheetRow key={`op-${i}`} row={r} />)}

          <SectionHeader title="Oncoming Pilots — Second In-Command" count={oncomingSics.length} color="bg-green-50 text-green-600" />
          {oncomingSics.map((r, i) => <SwapSheetRow key={`os-${i}`} row={r} />)}

          {/* OFFGOING PILOTS */}
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
      return new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", timeZoneName: "short" });
    }

    function travelLabel(r: CrewSwapRow): string {
      if (r.travel_type === "commercial" && r.flight_number) return r.flight_number;
      if (r.travel_type === "uber") return "UBER";
      if (r.travel_type === "rental_car") return "RENTAL";
      if (r.travel_type === "drive") return "DRIVE";
      return "";
    }

    // Header row matches the import format columns + optimizer result columns
    const HEADER = [
      "SB", "Vol", "Name (Home Base)", "", "Tail", "",
      "Swap Location", "Transport", "Dep Time", "Avail/Arr Time",
      "Cost", "Backup", "Notes/Warnings",
    ];

    function dataRow(r: CrewSwapRow): (string | number | null)[] {
      return [
        r.is_skillbridge ? "TRUE" : "",
        "", // volunteer flag not stored on result rows
        crewCell(r),
        "",
        r.tail_number,
        "",
        r.swap_location ?? "",
        travelLabel(r),
        fmtLocal(r.departure_time),
        fmtLocal(r.available_time ?? r.arrival_time),
        r.cost_estimate != null ? `$${r.cost_estimate}` : "",
        r.backup_flight ?? "",
        [...r.warnings, r.notes ?? ""].filter(Boolean).join("; "),
      ];
    }

    const sheetData: (string | number | null)[][] = [];

    // ONCOMING PILOTS
    sheetData.push(["", "", "ONCOMING PILOTS", "", "", "", "", "", "", "", "", "", ""]);
    sheetData.push(["", "", "PILOT IN-COMMAND", "", "", "", "", "", "", "", "", "", ""]);
    sheetData.push(HEADER);
    for (const r of oncomingPics) sheetData.push(dataRow(r));
    sheetData.push([]);
    sheetData.push(["", "", "SECOND IN-COMMAND", "", "", "", "", "", "", "", "", "", ""]);
    sheetData.push(HEADER);
    for (const r of oncomingSics) sheetData.push(dataRow(r));
    sheetData.push([]);

    // OFFGOING PILOTS
    sheetData.push(["", "", "OFFGOING PILOTS", "", "", "", "", "", "", "", "", "", ""]);
    sheetData.push(["", "", "PILOT IN-COMMAND", "", "", "", "", "", "", "", "", "", ""]);
    sheetData.push(HEADER);
    for (const r of offgoingPics) sheetData.push(dataRow(r));
    sheetData.push([]);
    sheetData.push(["", "", "SECOND IN-COMMAND", "", "", "", "", "", "", "", "", "", ""]);
    sheetData.push(HEADER);
    for (const r of offgoingSics) sheetData.push(dataRow(r));

    // Summary row
    sheetData.push([]);
    sheetData.push(["", "", `Total Est. Cost: $${swapPlan.total_cost.toLocaleString()}`, "", "", "",
      `Score: ${swapPlan.plan_score}`, `Solved: ${swapPlan.solved_count ?? 0}`,
      `Unsolved: ${swapPlan.unsolved_count ?? 0}`, "", "", "", ""]);
    if (swapPlan.warnings.length > 0) {
      sheetData.push(["", "", "WARNINGS:", "", "", "", "", "", "", "", "", "", ""]);
      for (const w of swapPlan.warnings) {
        sheetData.push(["", "", w, "", "", "", "", "", "", "", "", "", ""]);
      }
    }

    const ws = XLSX.utils.aoa_to_sheet(sheetData);
    // Set column widths
    ws["!cols"] = [
      { wch: 5 }, { wch: 4 }, { wch: 30 }, { wch: 3 }, { wch: 10 }, { wch: 3 },
      { wch: 12 }, { wch: 18 }, { wch: 14 }, { wch: 14 },
      { wch: 8 }, { wch: 14 }, { wch: 40 },
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

  // Upload Excel roster
  async function handleUpload(file: File) {
    setUploading(true);
    setUploadError(null);
    setUploadResult(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/crew/roster", { method: "POST", body: fd });
      const data = await res.json();
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

  // Run swap optimizer
  async function runOptimizer(includeFlights: boolean) {
    setOptimizing(true);
    setOptimizeError(null);
    try {
      const res = await fetch("/api/crew/optimize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          swap_date: selectedWed.toISOString().slice(0, 10),
          search_flights: includeFlights,
          swap_assignments: swapAssignments ?? undefined,
          oncoming_pool: oncomingPool ?? undefined,
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
      } else {
        setSwapPlan(data);
      }
    } catch (e) {
      setOptimizeError(e instanceof Error ? e.message : "Optimization failed");
    } finally {
      setOptimizing(false);
    }
  }

  function shiftWeek(delta: number) {
    setSelectedWed((prev) => {
      const next = new Date(prev);
      next.setDate(prev.getDate() + delta * 7);
      return next;
    });
  }

  return (
    <div className="space-y-6">
      {/* Header + Week Selector */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-bold text-gray-900">Crew Swap Planning</h2>
          <p className="text-sm text-gray-500">
            Wednesday swap day: {selectedWed.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric" })}
          </p>
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

      {/* Swap Optimizer */}
      <div className="rounded-lg border bg-white shadow-sm overflow-hidden">
        <div className="px-4 py-3 bg-gray-50 border-b flex items-center justify-between">
          <div className="flex items-center gap-3">
            <h3 className="text-sm font-semibold text-gray-700 uppercase tracking-wider">
              Swap Optimizer
            </h3>
            {swapAssignments && (
              <span className="text-[10px] px-2 py-0.5 rounded bg-blue-50 text-blue-600">
                {Object.keys(swapAssignments).length} tails
                {oncomingPool && ` | Pool: ${oncomingPool.pic.length} PICs, ${oncomingPool.sic.length} SICs`}
                {" | "}{Object.values(swapAssignments).filter(a => a.offgoing_pic || a.offgoing_sic).length} offgoing
              </span>
            )}
            {!swapAssignments && (
              <span className="text-[10px] px-2 py-0.5 rounded bg-amber-50 text-amber-600">
                No swap assignments — upload Excel first
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => runOptimizer(false)}
              disabled={optimizing}
              className={`px-3 py-1.5 text-xs font-medium border rounded-lg ${
                optimizing ? "bg-gray-100 text-gray-400" : "bg-green-50 text-green-700 hover:bg-green-100 border-green-200"
              }`}
            >
              {optimizing ? "Optimizing..." : "Optimize (Drive Only)"}
            </button>
            <button
              onClick={() => runOptimizer(true)}
              disabled={optimizing}
              className={`px-3 py-1.5 text-xs font-medium border rounded-lg ${
                optimizing ? "bg-gray-100 text-gray-400" : "bg-blue-50 text-blue-700 hover:bg-blue-100 border-blue-200"
              }`}
            >
              {optimizing ? "Searching..." : "Optimize + Flights"}
            </button>
            {swapPlan && (
              <>
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
                {swapPlan.commercial_flights_searched > 0 && (
                  <span className="text-green-500 text-xs">
                    ({swapPlan.commercial_flights_searched} routes searched)
                  </span>
                )}
                {swapPlan.warnings.length > 0 && (
                  <span className="text-amber-600 text-xs">
                    {swapPlan.warnings.length} warning(s)
                  </span>
                )}
              </div>
            </div>

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

            {/* The swap sheet */}
            <SwapSheet rows={swapPlan.rows} />
          </div>
        )}

        {!swapPlan && !optimizeError && (
          <div className="px-4 py-6 text-center text-sm text-gray-400">
            Click optimize to generate swap recommendations for {selectedWed.toLocaleDateString(undefined, { month: "short", day: "numeric" })}
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
    </div>
  );
}
