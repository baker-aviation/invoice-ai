"use client";

/**
 * GanttScheduleTab — Weekly flight schedule grid, one row per tail.
 *
 * Columns are calendar days, cells contain flight leg blocks color-coded
 * by type (charter, positioning, maintenance). Inspired by JetInsight's
 * aircraft schedule view.
 */

import { useState, useMemo, useRef } from "react";
import type { Flight, MxNote } from "@/lib/opsApi";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DAYS_TO_SHOW = 9;
const DISPLAY_TZ = "America/New_York";

const TYPE_COLORS: Record<string, { bg: string; border: string; text: string; badge: string }> = {
  Charter:      { bg: "bg-blue-50",    border: "border-blue-200",    text: "text-blue-900",  badge: "bg-blue-500" },
  Revenue:      { bg: "bg-blue-50",    border: "border-blue-200",    text: "text-blue-900",  badge: "bg-blue-500" },
  Owner:        { bg: "bg-emerald-50", border: "border-emerald-200", text: "text-emerald-900", badge: "bg-emerald-500" },
  Positioning:  { bg: "bg-purple-50",  border: "border-purple-200",  text: "text-purple-900", badge: "bg-purple-500" },
  Ferry:        { bg: "bg-purple-50",  border: "border-purple-200",  text: "text-purple-900", badge: "bg-purple-500" },
  Maintenance:  { bg: "bg-red-50",     border: "border-red-200",     text: "text-red-900",   badge: "bg-red-500" },
  "Needs pos":  { bg: "bg-purple-50",  border: "border-purple-200",  text: "text-purple-900", badge: "bg-purple-500" },
  Training:     { bg: "bg-sky-50",     border: "border-sky-200",     text: "text-sky-900",   badge: "bg-sky-500" },
};
const DEFAULT_COLORS = { bg: "bg-gray-50", border: "border-gray-200", text: "text-gray-900", badge: "bg-gray-500" };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Format ICAO to IATA-style display */
function fmtIcao(icao: string | null): string {
  if (!icao) return "?";
  return icao.replace(/^K/, "");
}

/** Get ET date string (YYYY-MM-DD) for a UTC ISO timestamp */
function toETDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-CA", { timeZone: DISPLAY_TZ });
}

/** Format time as local ET (e.g. "2:30p") */
function fmtTime(iso: string): string {
  const d = new Date(iso);
  let h = parseInt(d.toLocaleTimeString("en-US", { hour: "numeric", hour12: false, timeZone: DISPLAY_TZ }));
  const m = d.toLocaleTimeString("en-US", { minute: "2-digit", timeZone: DISPLAY_TZ }).split(":").pop()?.replace(/\D/g, "").padStart(2, "0") ?? "00";
  const ampm = h >= 12 ? "p" : "a";
  if (h > 12) h -= 12;
  if (h === 0) h = 12;
  return m === "00" ? `${h}${ampm}` : `${h}:${m}${ampm}`;
}

/** Format date header (e.g. "Wed Apr 2") */
function fmtDayHeader(dateStr: string): string {
  const d = new Date(dateStr + "T12:00:00");
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

/** Extract charter company from summary field */
function extractCompany(summary: string | null): string | null {
  if (!summary) return null;
  // Pattern: [TAIL] Company Name (DEP - ARR) - type
  const m = summary.match(/\]\s+(.+?)\s+\(/);
  if (m) return m[1];
  return null;
}

/** Type badge letter */
function typeBadge(ft: string | null): string {
  if (!ft) return "?";
  if (ft === "Charter" || ft === "Revenue") return "R";
  if (ft === "Positioning" || ft === "Ferry" || ft === "Needs pos") return "P";
  if (ft === "Maintenance") return "M";
  if (ft === "Owner") return "O";
  if (ft === "Training") return "T";
  return ft[0]?.toUpperCase() ?? "?";
}

/** Generate date strings for N days starting from a given date */
function dateRange(startDate: string, days: number): string[] {
  const result: string[] = [];
  const base = new Date(startDate + "T12:00:00");
  for (let i = 0; i < days; i++) {
    const d = new Date(base);
    d.setDate(base.getDate() + i);
    result.push([d.getFullYear(), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0")].join("-"));
  }
  return result;
}

function todayET(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: DISPLAY_TZ });
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

type Props = {
  flights: Flight[];
  mxNotes?: MxNote[];
};

export default function GanttScheduleTab({ flights, mxNotes }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);

  // Start date for the grid
  const [startDate, setStartDate] = useState(() => {
    // Start from yesterday so today is column 2
    const d = new Date();
    d.setDate(d.getDate() - 1);
    return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0")].join("-");
  });

  const dates = useMemo(() => dateRange(startDate, DAYS_TO_SHOW), [startDate]);
  const today = todayET();

  // Shift the window
  const shiftDays = (n: number) => {
    const d = new Date(startDate + "T12:00:00");
    d.setDate(d.getDate() + n);
    setStartDate([d.getFullYear(), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0")].join("-"));
  };

  const goToToday = () => {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    setStartDate([d.getFullYear(), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0")].join("-"));
  };

  // Build grid data: { tail -> { date -> Flight[] } }
  const { tailDays, tails } = useMemo(() => {
    const dateSet = new Set(dates);
    const tailDays = new Map<string, Map<string, Flight[]>>();

    for (const f of flights) {
      if (!f.tail_number || !f.scheduled_departure) continue;
      const depDate = toETDate(f.scheduled_departure);
      if (!dateSet.has(depDate)) continue;

      if (!tailDays.has(f.tail_number)) tailDays.set(f.tail_number, new Map());
      const dayMap = tailDays.get(f.tail_number)!;
      if (!dayMap.has(depDate)) dayMap.set(depDate, []);
      dayMap.get(depDate)!.push(f);
    }

    // Sort flights within each day by departure time
    for (const dayMap of tailDays.values()) {
      for (const flts of dayMap.values()) {
        flts.sort((a, b) => a.scheduled_departure.localeCompare(b.scheduled_departure));
      }
    }

    // Sort tails alphabetically
    const tails = [...tailDays.keys()].sort();

    return { tailDays, tails };
  }, [flights, dates]);

  // MX notes by tail, keyed by date (for blocks that have start/end times)
  const mxByTailDate = useMemo(() => {
    const map = new Map<string, Map<string, MxNote[]>>();
    for (const n of mxNotes ?? []) {
      if (!n.tail_number || !n.start_time) continue;
      const date = toETDate(n.start_time);
      if (!map.has(n.tail_number)) map.set(n.tail_number, new Map());
      const dayMap = map.get(n.tail_number)!;
      if (!dayMap.has(date)) dayMap.set(date, []);
      dayMap.get(date)!.push(n);
    }
    return map;
  }, [mxNotes]);

  // Date header with range label
  const rangeLabel = (() => {
    const s = new Date(dates[0] + "T12:00:00");
    const e = new Date(dates[dates.length - 1] + "T12:00:00");
    const sMonth = s.toLocaleDateString("en-US", { month: "short" });
    const eMonth = e.toLocaleDateString("en-US", { month: "short" });
    const sDay = s.getDate();
    const eDay = e.getDate();
    const year = s.getFullYear();
    if (sMonth === eMonth) return `${sMonth} ${sDay} - ${eDay}, ${year}`;
    return `${sMonth} ${sDay} - ${eMonth} ${eDay}, ${year}`;
  })();

  return (
    <div className="space-y-3">
      {/* Toolbar */}
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-1">
          <button onClick={() => shiftDays(-7)} className="px-2 py-1 rounded text-sm font-medium border border-gray-300 bg-white hover:bg-gray-50 text-gray-600">&laquo;</button>
          <button onClick={() => shiftDays(-1)} className="px-2 py-1 rounded text-sm font-medium border border-gray-300 bg-white hover:bg-gray-50 text-gray-600">&lsaquo;</button>
          <button onClick={goToToday} className="px-3 py-1 rounded text-sm font-medium border border-gray-300 bg-white hover:bg-gray-50 text-gray-600">Today</button>
          <button onClick={() => shiftDays(1)} className="px-2 py-1 rounded text-sm font-medium border border-gray-300 bg-white hover:bg-gray-50 text-gray-600">&rsaquo;</button>
          <button onClick={() => shiftDays(7)} className="px-2 py-1 rounded text-sm font-medium border border-gray-300 bg-white hover:bg-gray-50 text-gray-600">&raquo;</button>
        </div>
        <h2 className="text-lg font-bold text-gray-800">{rangeLabel}</h2>
        <div className="flex-1" />
        <div className="text-xs text-gray-500">
          <span className="font-semibold text-gray-700">{tails.length}</span> aircraft &middot; All times ET
        </div>
        {/* Legend */}
        <div className="flex items-center gap-2 text-[10px]">
          {[
            { label: "Revenue", color: "bg-blue-500" },
            { label: "Positioning", color: "bg-purple-500" },
            { label: "Owner", color: "bg-emerald-500" },
            { label: "MX", color: "bg-red-500" },
          ].map((l) => (
            <div key={l.label} className="flex items-center gap-1">
              <span className={`w-2.5 h-2.5 rounded-sm ${l.color}`} />
              <span className="text-gray-500">{l.label}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Grid */}
      <div ref={scrollRef} className="overflow-x-auto border border-gray-200 rounded-xl shadow-sm">
        <div className="min-w-[1100px]">
          {/* Header row */}
          <div className="grid border-b border-gray-200 bg-gray-50 sticky top-0 z-10" style={{ gridTemplateColumns: `100px repeat(${DAYS_TO_SHOW}, 1fr)` }}>
            <div className="px-2 py-2 text-xs font-bold text-gray-500 border-r border-gray-200 flex items-center gap-1">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" className="text-gray-400">
                <path d="M21 16v-2l-8-5V3.5a1.5 1.5 0 00-3 0V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5l8 2.5z"/>
              </svg>
            </div>
            {dates.map((d) => (
              <div
                key={d}
                className={`px-2 py-2 text-xs font-bold text-center border-r border-gray-200 last:border-r-0 ${
                  d === today ? "bg-blue-50 text-blue-700" : "text-gray-600"
                }`}
              >
                {fmtDayHeader(d)}
              </div>
            ))}
          </div>

          {/* Tail rows */}
          {tails.map((tail) => {
            const dayMap = tailDays.get(tail)!;
            const mxDayMap = mxByTailDate.get(tail);

            return (
              <div
                key={tail}
                className="grid border-b border-gray-100 hover:bg-gray-50/50 transition-colors"
                style={{ gridTemplateColumns: `100px repeat(${DAYS_TO_SHOW}, 1fr)` }}
              >
                {/* Tail label */}
                <div className="px-2 py-2 border-r border-gray-200 flex flex-col justify-start">
                  <span className="text-xs font-bold text-gray-800 font-mono">{tail}</span>
                </div>

                {/* Day cells */}
                {dates.map((d) => {
                  const dayFlights = dayMap.get(d) ?? [];
                  const dayMx = mxDayMap?.get(d) ?? [];
                  const isToday = d === today;

                  return (
                    <div
                      key={d}
                      className={`px-1 py-1 border-r border-gray-100 last:border-r-0 min-h-[48px] space-y-0.5 overflow-hidden ${
                        isToday ? "bg-blue-50/30" : ""
                      }`}
                    >
                      {/* Flight blocks */}
                      {dayFlights.map((f) => {
                        const colors = TYPE_COLORS[f.flight_type ?? ""] ?? DEFAULT_COLORS;
                        const dep = fmtIcao(f.departure_icao);
                        const arr = fmtIcao(f.arrival_icao);
                        const depTime = fmtTime(f.scheduled_departure);
                        const arrTime = f.scheduled_arrival ? fmtTime(f.scheduled_arrival) : null;
                        const company = extractCompany(f.summary);
                        const badge = typeBadge(f.flight_type);

                        return (
                          <div
                            key={f.id}
                            className={`group relative rounded border px-1.5 py-1 cursor-default ${colors.bg} ${colors.border} ${colors.text}`}
                            title={[
                              `${dep} → ${arr}`,
                              `${depTime}${arrTime ? ` - ${arrTime}` : ""}`,
                              company,
                              f.pic ? `PIC: ${f.pic}` : null,
                              f.sic ? `SIC: ${f.sic}` : null,
                              f.pax_count != null ? `${f.pax_count} pax` : null,
                            ].filter(Boolean).join("\n")}
                          >
                            {/* Top row: route + times */}
                            <div className="flex items-center gap-1 text-[10px] leading-tight">
                              <span className="font-bold">{depTime}</span>
                              <span className="font-mono font-semibold">{dep}</span>
                              <span className="text-gray-400">-</span>
                              <span className="font-mono font-semibold">{arr}</span>
                              {arrTime && <span className="font-bold">{arrTime}</span>}
                              <span className={`ml-auto w-3.5 h-3.5 rounded-sm flex items-center justify-center text-white text-[8px] font-bold ${colors.badge}`}>
                                {badge}
                              </span>
                            </div>

                            {/* Company name */}
                            {company && (
                              <div className="text-[9px] leading-tight truncate opacity-70">
                                {company}{f.pax_count != null && f.pax_count > 0 ? ` (${f.pax_count} pax)` : ""}
                              </div>
                            )}

                            {/* Crew (show on hover via group) */}
                            {(f.pic || f.sic) && (
                              <div className="hidden group-hover:block text-[9px] leading-tight text-gray-500 truncate">
                                {[f.pic, f.sic].filter(Boolean).join(" / ")}
                              </div>
                            )}
                          </div>
                        );
                      })}

                      {/* MX note blocks */}
                      {dayMx.map((n) => (
                        <div
                          key={n.id}
                          className="rounded border px-1.5 py-1 bg-red-50 border-red-200 text-red-900"
                          title={[n.subject, n.description, n.body].filter(Boolean).join("\n")}
                        >
                          <div className="flex items-center gap-1 text-[10px] leading-tight">
                            <span className="font-bold">{fmtIcao(n.airport_icao)}</span>
                            {n.start_time && <span className="text-[9px]">{fmtTime(n.start_time)}</span>}
                            {n.end_time && <><span className="text-gray-400">-</span><span className="text-[9px]">{fmtTime(n.end_time)}</span></>}
                            <span className="ml-auto w-3.5 h-3.5 rounded-sm flex items-center justify-center text-white text-[8px] font-bold bg-red-500">M</span>
                          </div>
                          <div className="text-[9px] leading-tight truncate opacity-70">
                            {n.subject ?? n.description ?? "Maintenance"}
                          </div>
                        </div>
                      ))}
                    </div>
                  );
                })}
              </div>
            );
          })}

          {/* Empty state */}
          {tails.length === 0 && (
            <div className="px-6 py-12 text-center text-gray-400 text-sm">
              No flights in this date range
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
