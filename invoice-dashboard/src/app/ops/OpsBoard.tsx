"use client";

import { useState, useMemo, useCallback, useEffect } from "react";
import Link from "next/link";
import type { Flight, OpsAlert, NotamPin, CustomNotamAlert } from "@/lib/opsApi";
import type { AllRwysClosedAlert } from "@/lib/runwayData";
import { fmtTimeInTz } from "@/lib/airportTimezones";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fmtTime(s: string | null | undefined): string {
  if (!s) return "—";
  const d = new Date(s);
  if (isNaN(d.getTime())) return s;
  return (
    d.toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZone: "UTC",
    }) + "Z"
  );
}

function fmtDuration(dep: string, arr: string | null): string {
  if (!arr) return "";
  const diff = new Date(arr).getTime() - new Date(dep).getTime();
  if (isNaN(diff) || diff < 0) return "";
  const h = Math.floor(diff / 3600000);
  const m = Math.floor((diff % 3600000) / 60000);
  return `${h}h ${m}m`;
}

function fmtDayLabel(dateStr: string): string {
  const d = new Date(dateStr + "T12:00:00Z");
  const today = new Date();
  const todayStr = [
    today.getUTCFullYear(),
    String(today.getUTCMonth() + 1).padStart(2, "0"),
    String(today.getUTCDate()).padStart(2, "0"),
  ].join("-");
  const tomorrow = new Date(today);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  const tomorrowStr = [
    tomorrow.getUTCFullYear(),
    String(tomorrow.getUTCMonth() + 1).padStart(2, "0"),
    String(tomorrow.getUTCDate()).padStart(2, "0"),
  ].join("-");

  if (dateStr === todayStr) return "Today";
  if (dateStr === tomorrowStr) return "Tomorrow";
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
}

function severityClasses(severity: string) {
  if (severity === "critical") return "bg-red-100 text-red-800 border border-red-200";
  if (severity === "warning") return "bg-amber-100 text-amber-800 border border-amber-200";
  return "bg-blue-100 text-blue-700 border border-blue-200";
}

function severityDot(severity: string) {
  if (severity === "critical") return "bg-red-500";
  if (severity === "warning") return "bg-amber-500";
  return "bg-blue-500";
}

const ALERT_TYPE_LABELS: Record<string, string> = {
  EDCT: "EDCT",
  NOTAM_RUNWAY: "RWY",
  NOTAM_TFR: "TFR",
  NOTAM_AERODROME: "AD",
  NOTAM_AD_RESTRICTED: "AD",
  NOTAM_PPR: "PPR",
  NOTAM_OTHER: "NOTAM",
  OCEANIC_HF: "OCEANIC HF",
  TIGHT_TURN: "TIGHT TURN",
  FBO_MISMATCH: "FBO MISMATCH",
};

// ─── NOTAM helpers ────────────────────────────────────────────────────────────

function icaoToIso(t: string): string {
  const yr = "20" + t.slice(0, 2);
  const mo = t.slice(2, 4);
  const dy = t.slice(4, 6);
  const hr = t.slice(6, 8);
  const mn = t.slice(8, 10);
  return `${yr}-${mo}-${dy} ${hr}:${mn}Z`;
}

function parseNotamTimes(body: string | null): { from: string | null; to: string | null } {
  if (!body) return { from: null, to: null };
  // ICAO format: B) 2603011400 C) 2603151800
  const fromM = body.match(/\bB\)\s*(\d{10})\b/);
  const toM = body.match(/\bC\)\s*(\d{10}|PERM)\b/);
  if (fromM) {
    return {
      from: icaoToIso(fromM[1]),
      to: toM ? (toM[1] === "PERM" ? "PERM" : icaoToIso(toM[1])) : null,
    };
  }
  // Domestic format: 2603011400-2603151800
  const domM = body.match(/\b(\d{10})-(\d{10})\b/);
  if (domM) return { from: icaoToIso(domM[1]), to: icaoToIso(domM[2]) };
  // WEF/TIL format: WEF 2603011400 TIL 2603151800
  const wefM = body.match(/WEF\s+(\d{10})/);
  if (wefM) {
    const tilM = body.match(/TIL\s+(\d{10}|PERM)/);
    return {
      from: icaoToIso(wefM[1]),
      to: tilM ? (tilM[1] === "PERM" ? "PERM" : icaoToIso(tilM[1])) : null,
    };
  }
  // Space-separated 10-digit pairs (e.g. "2603011400 2603151800")
  const spaceM = body.match(/\b(\d{10})\s+(\d{10})\b/);
  if (spaceM) return { from: icaoToIso(spaceM[1]), to: icaoToIso(spaceM[2]) };
  return { from: null, to: null };
}

function fmtNotamDate(iso: string | null, humanFallback: string | null): string | null {
  if (iso) {
    const d = new Date(iso);
    if (!isNaN(d.getTime())) {
      return d.toLocaleString("en-US", {
        month: "short", day: "numeric",
        hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC",
      }) + "Z";
    }
  }
  if (humanFallback) return humanFallback + " UTC";
  return null;
}

// ─── Restricted Airport Alerts ───────────────────────────────────────────────

const RESTRICTED_AIRPORTS: Record<string, { label: string; severity: string; message: string }> = {
  KJAC: {
    label: "KJAC",
    severity: "warning",
    message: "Jackson Hole — Noise-sensitive airport, voluntary curfew 10PM–7AM, terrain-limited approaches",
  },
  KSNA: {
    label: "KSNA",
    severity: "warning",
    message: "John Wayne — Mandatory noise abatement departure procedures, curfew 11PM–7AM",
  },
};

// ─── Airport Timezones (for after-hours detection) ───────────────────────────

const AIRPORT_TZ: Record<string, string> = {
  // Eastern
  KTEB: "America/New_York", KJFK: "America/New_York", KLGA: "America/New_York",
  KPBI: "America/New_York", KFLL: "America/New_York", KMIA: "America/New_York",
  KBCT: "America/New_York", KOPF: "America/New_York", KSWF: "America/New_York",
  KHPN: "America/New_York", KBED: "America/New_York", KBOS: "America/New_York",
  KDCA: "America/New_York", KIAD: "America/New_York", KBWI: "America/New_York",
  KATL: "America/New_York", KCLT: "America/New_York", KRDU: "America/New_York",
  KPDK: "America/New_York", KAGS: "America/New_York", KJAX: "America/New_York",
  KPNS: "America/New_York", KECP: "America/New_York", KPHL: "America/New_York",
  KTPA: "America/New_York", KTTN: "America/New_York", KBUF: "America/New_York",
  KMMU: "America/New_York", KEWR: "America/New_York", KMCO: "America/New_York",
  KFRG: "America/New_York", KYIP: "America/New_York", KROC: "America/New_York",
  KCLE: "America/New_York", KIND: "America/New_York", KILM: "America/New_York",
  KBGR: "America/New_York",
  // Central
  KDAL: "America/Chicago", KDFW: "America/Chicago", KHOU: "America/Chicago",
  KIAH: "America/Chicago", KAUS: "America/Chicago", KSAT: "America/Chicago",
  KADS: "America/Chicago", KFTW: "America/Chicago", KAFW: "America/Chicago",
  KSGR: "America/Chicago", KNEW: "America/Chicago", KMSY: "America/Chicago",
  KORD: "America/Chicago", KMDW: "America/Chicago", KMCI: "America/Chicago",
  KMEM: "America/Chicago", KBNA: "America/Chicago", KLIT: "America/Chicago",
  KOKC: "America/Chicago", KTUL: "America/Chicago", KCRP: "America/Chicago",
  KGGG: "America/Chicago", KACT: "America/Chicago", KTYR: "America/Chicago",
  KLRD: "America/Chicago", KMFE: "America/Chicago", KSUS: "America/Chicago",
  KPWK: "America/Chicago", KOMA: "America/Chicago", KSTL: "America/Chicago",
  KJAN: "America/Chicago",
  // Mountain
  KDEN: "America/Denver", KJAC: "America/Denver", KASE: "America/Denver",
  KEGE: "America/Denver", KGUC: "America/Denver", KABQ: "America/Denver",
  KSLC: "America/Denver", KBOI: "America/Denver", KMTJ: "America/Denver",
  KRIL: "America/Denver", KHDN: "America/Denver", KBIL: "America/Denver",
  KAPA: "America/Denver", KMSO: "America/Denver",
  // Arizona (no DST)
  KPHX: "America/Phoenix", KSDL: "America/Phoenix", KTUS: "America/Phoenix",
  KDVT: "America/Phoenix", KIWA: "America/Phoenix",
  // Pacific
  KSNA: "America/Los_Angeles", KLAX: "America/Los_Angeles", KVNY: "America/Los_Angeles",
  KSFO: "America/Los_Angeles", KOAK: "America/Los_Angeles", KSJC: "America/Los_Angeles",
  KLAS: "America/Los_Angeles", KSAN: "America/Los_Angeles", KPSP: "America/Los_Angeles",
  KSEA: "America/Los_Angeles", KPDX: "America/Los_Angeles", KBUR: "America/Los_Angeles",
  KCMA: "America/Los_Angeles", KTRM: "America/Los_Angeles", KCRQ: "America/Los_Angeles",
  KNUQ: "America/Los_Angeles", KBFI: "America/Los_Angeles", KLGB: "America/Los_Angeles",
};

function getLocalHour(utcIso: string, icao: string | null): number {
  const tz = AIRPORT_TZ[icao ?? ""] ?? "America/Chicago";
  const d = new Date(utcIso);
  return parseInt(d.toLocaleString("en-US", { hour: "numeric", hour12: false, timeZone: tz }));
}

function getLocalTimeStr(utcIso: string, icao: string | null): string {
  const tz = AIRPORT_TZ[icao ?? ""] ?? "America/Chicago";
  const d = new Date(utcIso);
  return d.toLocaleString("en-US", {
    hour: "numeric", minute: "2-digit", hour12: true, timeZone: tz,
  });
}

// ─── 24/7 airports (excluded from after-hours filter) ────────────────────────

const AIRPORTS_24_7 = new Set([
  "KTEB", "KOPF", "KPBI", "KVNY", "KSFO", "KIAD", "KHPN", "KBOS", "KPHL",
  "KBWI", "KFLL", "KSDL", "KTPA", "KSUS", "KAUS", "KDAL", "KHOU", "KJAX",
  "KMIA", "KPDX", "KLAS", "KFTW", "KSAT", "KPWK", "KLAX", "KTTN", "KRDU",
  "KBCT", "KBUF", "KOAK", "KSLC", "KMMU", "KAPA", "KOMA", "KSTL", "KMDW",
  "KILM", "KJFK", "KEWR", "KLGA", "KMCO", "KNUQ", "KFRG", "KBUR", "KYIP",
  "KROC", "KBFI", "KCLE", "KABQ", "KJAN", "KPDK", "KBNA", "KLGB", "KIND",
  "KSAT", "KMSO", "KBGR",
]);

// ─── Baker PPR airports (fetched from database) ─────────────────────────────

function isAfterHours(utcIso: string | null, icao: string | null, fboHours?: Record<string, FboHoursEntry>): boolean {
  if (!utcIso) return false;

  // Check real FBO hours data first
  const fboEntry = icao ? fboHours?.[icao] : null;
  if (fboEntry) {
    if (fboEntry.is24hr) return false;
    if (fboEntry.openMinutes != null && fboEntry.closeMinutes != null) {
      const tz = AIRPORT_TZ[icao ?? ""] ?? "America/Chicago";
      const d = new Date(utcIso);
      const localStr = d.toLocaleString("en-US", { hour: "numeric", minute: "numeric", hour12: false, timeZone: tz });
      const [h, m] = localStr.split(":").map(Number);
      const minuteOfDay = h * 60 + m;
      if (fboEntry.closeMinutes <= fboEntry.openMinutes) {
        return !(minuteOfDay >= fboEntry.openMinutes || minuteOfDay < fboEntry.closeMinutes);
      }
      return minuteOfDay < fboEntry.openMinutes || minuteOfDay >= fboEntry.closeMinutes;
    }
  }

  // Fallback: hardcoded 24/7 list + default 7 AM – 8 PM
  if (icao && AIRPORTS_24_7.has(icao)) return false;
  const hour = getLocalHour(utcIso, icao);
  return hour >= 20 || hour < 7;
}

// ─── Flight type badge colors (matching JetInsight categories) ───────────────

const FLIGHT_TYPE_COLORS: Record<string, string> = {
  Charter:        "bg-green-100 text-green-800",
  Revenue:        "bg-green-100 text-green-800",
  Owner:          "bg-blue-100 text-blue-800",
  Positioning:    "bg-yellow-100 text-yellow-800",
  Maintenance:    "bg-orange-100 text-orange-800",
  Training:       "bg-purple-100 text-purple-800",
  "Ferry/Cargo":  "bg-cyan-100 text-cyan-800",
  "Time off":     "bg-gray-100 text-gray-600",
  Assignment:     "bg-indigo-100 text-indigo-800",
  Transient:      "bg-teal-100 text-teal-800",
  "Needs pos":    "bg-rose-100 text-rose-800",
  "Crew conflict":"bg-red-100 text-red-800",
  Other:          "bg-gray-100 text-gray-700",
};

function flightTypeBadge(flightType: string): string {
  return FLIGHT_TYPE_COLORS[flightType] ?? "bg-gray-100 text-gray-700";
}

// Client-side fallback: infer flight_type from the ICS summary when the
// backend didn't extract one (e.g. flights synced before parser update).
const FLIGHT_TYPE_KEYWORDS = [
  "Charter", "Revenue", "Owner", "Positioning", "Maintenance", "Training",
  "Ferry", "Cargo", "Needs pos", "Crew conflict", "Time off",
  "Assignment", "Transient",
];

function inferFlightType(flight: Flight): string | null {
  if (flight.flight_type) return flight.flight_type;
  const text = flight.summary ?? "";
  // Pattern 1: text after airport pair — "(SDM - SNA) - Positioning"
  const afterPair = text.match(/\([A-Z]{3,4}\s*[-–]\s*[A-Z]{3,4}\)\s*[-–]\s*(.+)$/);
  if (afterPair) {
    const raw = afterPair[1].replace(/\s+flights?\s*$/i, "").trim();
    if (raw) return raw;
  }
  // Pattern 2: text before bracket — "Revenue - [N123] ..."
  const preBracket = text.match(/^([A-Za-z][A-Za-z /]+?)\s*[-–]?\s*\[/);
  if (preBracket) {
    const raw = preBracket[1].replace(/[-–]\s*$/, "").replace(/\s+flights?\s*$/i, "").trim();
    if (raw) return raw;
  }
  // Pattern 3: keyword search
  for (const kw of FLIGHT_TYPE_KEYWORDS) {
    if (new RegExp(`\\b${kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(text)) {
      return kw;
    }
  }
  return null;
}

// ─── Client-side alert types ─────────────────────────────────────────────────

type ClientAlert = {
  key: string;
  flightId: string;
  type: string;
  label: string;
  severity: string;
  message: string;
};

// ─── localStorage dismiss for client alerts ──────────────────────────────────

const DISMISSED_KEY = "ops-dismissed-client-alerts";

function loadDismissed(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = localStorage.getItem(DISMISSED_KEY);
    return raw ? new Set(JSON.parse(raw) as string[]) : new Set();
  } catch { return new Set(); }
}

function saveDismissed(dismissed: Set<string>): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(DISMISSED_KEY, JSON.stringify([...dismissed]));
  } catch { /* ignore */ }
}

// ─── Filter categories ───────────────────────────────────────────────────────

type AlertFilter = "ALL" | "NOTAMS" | "PPR" | "OCEANIC" | "FBO_MISMATCH" | "LATE";

const FILTER_OPTIONS: { key: AlertFilter; label: string; description: string }[] = [
  { key: "ALL", label: "All Flights", description: "Every scheduled flight" },
  { key: "NOTAMS", label: "NOTAMs", description: "Flights with active NOTAMs" },
  { key: "PPR", label: "PPRs", description: "Prior permission required" },
  { key: "OCEANIC", label: "Oceanic HF", description: "Aircraft lacking dual HF on oceanic legs" },
  { key: "FBO_MISMATCH", label: "FBO Mismatch", description: "Consecutive legs with different FBOs at the same airport" },
  { key: "LATE", label: "After Hrs", description: "Departures or arrivals 8 PM – 7 AM local (excl. 24/7 airports)" },
];

// NOTAM sub-filter types
type NotamSubFilter = "ALL_NOTAMS" | "RWY" | "AD" | "TFR" | "PPR_NOTAM";

const NOTAM_SUB_OPTIONS: { key: NotamSubFilter; label: string }[] = [
  { key: "ALL_NOTAMS", label: "All" },
  { key: "RWY", label: "RWY" },
  { key: "AD", label: "AD" },
  { key: "TFR", label: "TFR" },
  { key: "PPR_NOTAM", label: "PPR" },
];

// PPR sub-filter types
type PprSubFilter = "ALL_PPR" | "NOTAM_PPR" | "BAKER_PPR";

const PPR_SUB_OPTIONS: { key: PprSubFilter; label: string }[] = [
  { key: "ALL_PPR", label: "All" },
  { key: "NOTAM_PPR", label: "NOTAM" },
  { key: "BAKER_PPR", label: "Baker PPR List" },
];

// ─── Time horizons ───────────────────────────────────────────────────────────

type TimeRange = "TODAY" | "48H" | "7D" | "30D";

const TIME_RANGES: { key: TimeRange; label: string; hours: number }[] = [
  { key: "TODAY", label: "Today", hours: 24 },
  { key: "48H", label: "48 Hours", hours: 48 },
  { key: "7D", label: "7 Days", hours: 168 },
  { key: "30D", label: "30 Days", hours: 720 },
];

// ─── Alert types we process ──────────────────────────────────────────────────

const ALERT_TYPES_SHOWN = new Set([
  "NOTAM_RUNWAY", "NOTAM_AERODROME", "NOTAM_AD_RESTRICTED",
  "NOTAM_TFR", "NOTAM_PPR", "OCEANIC_HF", "FBO_MISMATCH",
]);

// ─── EDCT expandable row (status box) ────────────────────────────────────────

function fmtEdctLocal(iso: string | null | undefined, depIcao: string | null | undefined): string {
  if (!iso) return "—";
  return fmtTimeInTz(iso, depIcao, true);
}

function EdctRow({ alert, flight, onDismiss, fmtTime }: {
  alert: OpsAlert;
  flight: Flight | null;
  onDismiss: (id: string) => void;
  fmtTime: (s: string) => string;
}) {
  const [open, setOpen] = useState(false);
  const depIcao = alert.departure_icao ?? flight?.departure_icao;

  // Extract program info from body
  const body = alert.body ?? "";
  const programMode = body.match(/Program Delay Mode:\s*(.+)/i)?.[1]?.trim();
  const programStart = body.match(/Program Start Time:\s*(.+)/i)?.[1]?.trim();
  const programEnd = body.match(/Program End Time:\s*(.+)/i)?.[1]?.trim();
  const expectedArrival = body.match(/Expected Arrival Time:\s*(.+)/i)?.[1]?.trim();
  const srcId = alert.source_message_id ?? "";
  const sourceTag = srcId.startsWith("swim-edct-") || srcId.startsWith("faa-edct-")
    ? "FAA"
    : "FF";

  return (
    <div className="bg-white rounded-lg border border-orange-200 text-sm overflow-hidden">
      <div className="flex items-center gap-3 px-3 py-2">
        <button
          type="button"
          onClick={() => setOpen(!open)}
          className="text-gray-400 hover:text-gray-600 transition-colors shrink-0"
        >
          <svg className={`w-3.5 h-3.5 transition-transform ${open ? "rotate-90" : ""}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
        </button>
        <span className={`w-2 h-2 rounded-full shrink-0 ${alert.severity === "critical" ? "bg-red-500" : "bg-orange-500"}`} />
        {flight && (
          <span className="font-mono font-bold text-gray-800 text-xs">
            {flight.departure_icao ?? "????"} → {flight.arrival_icao ?? "????"}
          </span>
        )}
        {(alert.tail_number || flight?.tail_number) && (
          <span className="font-mono text-xs text-gray-600 bg-gray-100 rounded px-1.5 py-0.5">{alert.tail_number || flight?.tail_number}</span>
        )}
        <span className={`text-[10px] font-bold rounded px-1.5 py-0.5 ${
          sourceTag === "FAA" ? "bg-blue-100 text-blue-700" : "bg-amber-100 text-amber-700"
        }`}>{sourceTag}</span>
        <span className="text-xs">
          {(alert.original_departure_time || flight?.scheduled_departure) && (
            <span className="text-gray-500 line-through">{fmtEdctLocal(alert.original_departure_time ?? flight?.scheduled_departure, depIcao)}</span>
          )}
          {(alert.original_departure_time || flight?.scheduled_departure) && <span className="text-gray-400 mx-0.5">→</span>}
          <span className="text-orange-800 font-bold">{fmtEdctLocal(alert.edct_time, depIcao)}</span>
        </span>
        <button
          type="button"
          onClick={() => onDismiss(alert.id)}
          className="ml-auto text-xs text-gray-500 hover:text-green-700 hover:bg-green-50 border border-gray-200 hover:border-green-300 rounded px-1.5 py-0.5 transition-colors"
        >
          Ack
        </button>
      </div>
      {open && (
        <div className="px-3 pb-3 pt-1 border-t border-orange-100 grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-1.5 text-xs text-gray-600">
          {alert.subject && (
            <div className="col-span-2 sm:col-span-3 text-gray-800 font-medium truncate">{alert.subject}</div>
          )}
          <div><span className="text-gray-400">Source:</span> {sourceTag === "FAA" ? "FAA" : "ForeFlight"}</div>
          <div><span className="text-gray-400">Received:</span> {fmtTime(alert.created_at)}</div>
          {(alert.tail_number || flight?.tail_number) && (
            <div><span className="text-gray-400">Tail:</span> {alert.tail_number || flight?.tail_number}</div>
          )}
          {programMode && <div><span className="text-gray-400">Program:</span> {programMode}</div>}
          {programStart && <div><span className="text-gray-400">Program start:</span> {programStart}</div>}
          {programEnd && <div><span className="text-gray-400">Program end:</span> {programEnd}</div>}
          {expectedArrival && <div><span className="text-gray-400">Expected arrival:</span> {expectedArrival}</div>}
          {alert.original_departure_time && (
            <div><span className="text-gray-400">Original dep:</span> {fmtEdctLocal(alert.original_departure_time, depIcao)}</div>
          )}
          {alert.edct_time && (
            <div><span className="text-gray-400">New EDCT:</span> <span className="font-semibold text-orange-700">{fmtEdctLocal(alert.edct_time, depIcao)}</span></div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Alert inline card (server-side NOTAM/EDCT alerts) ──────────────────────

function AlertCard({ alert, onAck, acked, ackedByName, pinned, onTogglePin }: { alert: OpsAlert; onAck: (id: string) => void; acked?: boolean; ackedByName?: string | null; pinned?: boolean; onTogglePin?: (alertId: string, pin: boolean) => void }) {
  const [expanded, setExpanded] = useState(false);
  const [acking, setAcking] = useState(false);

  function handleAck(e: React.MouseEvent) {
    e.stopPropagation();
    setAcking(true);
    onAck(alert.id);
  }

  const isNotam = alert.alert_type.startsWith("NOTAM");
  const notamTimes = isNotam ? parseNotamTimes(alert.body) : null;
  const nd = isNotam ? alert.notam_dates : null;

  const typeLabel = ALERT_TYPE_LABELS[alert.alert_type] ?? alert.alert_type;

  return (
    <div
      className={`rounded-lg border text-sm transition-all ${
        acked
          ? "border-gray-200 bg-gray-50/60 opacity-60"
          : alert.severity === "critical"
            ? "border-red-200 bg-red-50/60"
            : "border-amber-200 bg-amber-50/60"
      }`}
    >
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full px-3 py-2 flex items-center gap-2 text-left hover:bg-white/40 transition-colors"
      >
        <span className={`w-2 h-2 rounded-full shrink-0 ${severityDot(alert.severity)}`} />
        <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-xs font-mono font-semibold ${severityClasses(alert.severity)}`}>
          {typeLabel}
        </span>
        {alert.airport_icao && (
          <span className="font-mono font-semibold text-gray-800 text-xs">{alert.airport_icao}</span>
        )}
        {alert.edct_time && (
          <span className="text-xs">
            <span className="text-gray-500 line-through">{fmtEdctLocal(alert.original_departure_time, alert.departure_icao)}</span>
            {alert.original_departure_time && <span className="text-gray-400 mx-0.5">→</span>}
            <span className="text-orange-700 font-bold">{fmtEdctLocal(alert.edct_time, alert.departure_icao)}</span>
          </span>
        )}
        {/* ── NOTAM effective times (inline) ── */}
        {(nd?.effective_start || nd?.start_date_utc || notamTimes?.from) && (
          <span className="text-xs text-gray-600 font-mono bg-white/80 rounded px-1.5 py-0.5">
            {fmtNotamDate(nd?.effective_start ?? null, nd?.start_date_utc ?? notamTimes?.from ?? null)}
            {(nd?.effective_end || nd?.end_date_utc || notamTimes?.to) && (
              <> → {notamTimes?.to === "PERM" ? "PERM" : fmtNotamDate(nd?.effective_end ?? null, nd?.end_date_utc ?? notamTimes?.to ?? null)}</>
            )}
          </span>
        )}
        <div className="ml-auto flex items-center gap-1.5 shrink-0">
          {onTogglePin && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onTogglePin(alert.id, !pinned); }}
              className={`text-xs rounded px-1.5 py-0.5 transition-colors border ${
                pinned
                  ? "text-amber-700 bg-amber-50 border-amber-300 hover:bg-amber-100"
                  : "text-gray-400 hover:text-amber-600 bg-white border-gray-200 hover:border-amber-300 hover:bg-amber-50"
              }`}
              title={pinned ? "Unpin this NOTAM" : "Pin this NOTAM"}
            >
              {pinned ? "Pinned" : "Pin"}
            </button>
          )}
          {acked ? (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onAck(alert.id);
              }}
              className="text-xs text-gray-400 hover:text-orange-600 bg-gray-100 hover:bg-orange-50 border border-transparent hover:border-orange-200 rounded px-1.5 py-0.5 transition-colors cursor-pointer"
              title="Click to un-acknowledge"
            >
              Ack'd{ackedByName ? ` by ${ackedByName}` : ""}
            </button>
          ) : (
            <button
              type="button"
              onClick={handleAck}
              disabled={acking}
              className="text-xs text-gray-500 hover:text-green-700 hover:bg-green-50 border border-gray-200 hover:border-green-300 rounded px-1.5 py-0.5 transition-colors disabled:opacity-50"
            >
              {acking ? "..." : "Ack"}
            </button>
          )}
          <span className="text-gray-400 text-xs">{expanded ? "▲" : "▼"}</span>
        </div>
      </button>
      {/* ── NOTAM expanded details (issued, effective from/to, status) ── */}
      {expanded && (
        <div className="px-3 pb-2.5 pt-1 text-xs text-gray-700 space-y-1.5 border-t border-gray-200/60">
          {isNotam && (nd?.issued || nd?.issue_date_utc || nd?.effective_start || notamTimes?.from) && (
            <div className="flex gap-4 flex-wrap bg-white border rounded p-2 text-xs">
              {(nd?.issued || nd?.issue_date_utc) && (
                <div>
                  <span className="text-gray-400">Issued: </span>
                  <span className="font-mono font-medium text-gray-700">
                    {fmtNotamDate(nd?.issued ?? null, nd?.issue_date_utc ?? null)}
                  </span>
                </div>
              )}
              {(nd?.effective_start || nd?.start_date_utc || notamTimes?.from) && (
                <div>
                  <span className="text-gray-400">Effective: </span>
                  <span className="font-mono font-medium text-amber-700">
                    {fmtNotamDate(nd?.effective_start ?? null, nd?.start_date_utc ?? notamTimes?.from ?? null)}
                  </span>
                </div>
              )}
              {(nd?.effective_end || nd?.end_date_utc || notamTimes?.to) && (
                <div>
                  <span className="text-gray-400">Expires: </span>
                  <span className="font-mono font-medium text-amber-700">
                    {notamTimes?.to === "PERM"
                      ? "PERM"
                      : fmtNotamDate(nd?.effective_end ?? null, nd?.end_date_utc ?? notamTimes?.to ?? null)}
                  </span>
                </div>
              )}
              {nd?.status && (
                <div>
                  <span className="text-gray-400">Status: </span>
                  <span className={`font-medium ${nd.status === "Active" ? "text-green-700" : "text-gray-600"}`}>
                    {nd.status}
                  </span>
                </div>
              )}
            </div>
          )}
          {alert.subject && <p><span className="font-medium">NOTAM #:</span> {alert.subject}</p>}
          {alert.body && (
            <pre className="whitespace-pre-wrap font-sans text-xs bg-white border rounded p-2 max-h-36 overflow-y-auto">
              {alert.body}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Client alert card (KJAC/KSNA/after-hours — localStorage dismiss) ───────

function ClientAlertCard({ alert, onDismiss, dismissed, dismissedByName, pinned, onTogglePin }: { alert: ClientAlert; onDismiss: (key: string) => void; dismissed?: boolean; dismissedByName?: string | null; pinned?: boolean; onTogglePin?: (key: string, pin: boolean) => void }) {
  const [dismissing, setDismissing] = useState(false);

  function handleDismiss(e: React.MouseEvent) {
    e.stopPropagation();
    setDismissing(true);
    onDismiss(alert.key);
  }

  const isLate = alert.type === "AFTER_HOURS";
  const isRwyClosed = alert.type === "ALL_RWYS_CLOSED";

  return (
    <div
      className={`rounded-lg border text-sm ${
        dismissed
          ? "border-gray-200 bg-gray-50/60 opacity-60"
          : isRwyClosed
            ? "border-red-300 bg-red-50/80"
            : isLate
              ? "border-purple-200 bg-purple-50/60"
              : "border-blue-200 bg-blue-50/60"
      }`}
    >
      <div className="px-3 py-2 flex items-center gap-2">
        <span className={`w-2 h-2 rounded-full shrink-0 ${dismissed ? "bg-gray-400" : isRwyClosed ? "bg-red-600" : isLate ? "bg-purple-500" : "bg-blue-500"}`} />
        <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-xs font-mono font-semibold ${
          dismissed
            ? "bg-gray-100 text-gray-500 border border-gray-200"
            : isRwyClosed
              ? "bg-red-100 text-red-800 border border-red-300"
              : isLate
                ? "bg-purple-100 text-purple-800 border border-purple-200"
                : "bg-blue-100 text-blue-800 border border-blue-200"
        }`}>
          {alert.label}
        </span>
        <span className="text-xs text-gray-700">{alert.message}</span>
        <div className="ml-auto flex items-center gap-1.5 shrink-0">
          {onTogglePin && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onTogglePin(alert.key, !pinned); }}
              className={`text-xs rounded px-1.5 py-0.5 transition-colors border ${
                pinned
                  ? "text-amber-700 bg-amber-50 border-amber-300 hover:bg-amber-100"
                  : "text-gray-400 hover:text-amber-600 bg-white border-gray-200 hover:border-amber-300 hover:bg-amber-50"
              }`}
              title={pinned ? "Unpin" : "Pin"}
            >
              {pinned ? "Pinned" : "Pin"}
            </button>
          )}
          {dismissed ? (
            <span className="text-xs text-gray-400 bg-gray-100 rounded px-1.5 py-0.5">
              Ack'd{dismissedByName ? ` by ${dismissedByName}` : ""}
            </span>
          ) : (
            <button
              type="button"
              onClick={handleDismiss}
              disabled={dismissing}
              className="text-xs text-gray-500 hover:text-green-700 hover:bg-green-50 border border-gray-200 hover:border-green-300 rounded px-1.5 py-0.5 transition-colors disabled:opacity-50"
            >
              {dismissing ? "..." : "Dismiss"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Flight card ──────────────────────────────────────────────────────────────

function FlightCard({
  flight, isAcked, showAcknowledged, showFiltered, suppressedIds, onAck, onAckAll, clientAlerts, dismissedClientAlerts, onDismissClient, userMap, dismissedByMap, pinnedIds, onTogglePin, pinnedKeys, onTogglePinKey,
}: {
  flight: Flight;
  isAcked: (a: OpsAlert, flightId?: string) => boolean;
  showAcknowledged: boolean;
  showFiltered: boolean;
  suppressedIds: Set<string>;
  onAck: (alertId: string, flightId: string) => void;
  onAckAll: (flightId: string, alertIds: string[]) => void;
  clientAlerts: ClientAlert[];
  dismissedClientAlerts: Set<string>;
  onDismissClient: (key: string) => void;
  userMap: Map<string, string>;
  dismissedByMap: Map<string, string>;
  pinnedIds?: Set<string>;
  onTogglePin?: (alertId: string, pin: boolean) => void;
  pinnedKeys?: Set<string>;
  onTogglePinKey?: (key: string, pin: boolean) => void;
}) {
  const fid = flight.id;
  const visibleAlerts = (flight.alerts ?? []).filter((a) => {
    const isSuppressed = suppressedIds.has(a.id);
    if (showFiltered) return isSuppressed;
    if (isSuppressed) return false;
    return showAcknowledged || !isAcked(a, fid);
  });
  const alerts = visibleAlerts;
  const unackedServerAlerts = (flight.alerts ?? []).filter((a) => !isAcked(a, fid) && !suppressedIds.has(a.id));
  const activeClientAlerts = showFiltered ? [] : clientAlerts.filter((ca) => showAcknowledged || !dismissedClientAlerts.has(ca.key));
  const hasRwyClosed = activeClientAlerts.some((ca) => ca.type === "ALL_RWYS_CLOSED");
  const hasCritical = hasRwyClosed || alerts.some((a) => a.severity === "critical");
  const hasWarning = alerts.some((a) => a.severity === "warning");
  const hasLate = activeClientAlerts.some((ca) => ca.type === "AFTER_HOURS");
  const hasAirport = activeClientAlerts.some((ca) => ca.type.startsWith("AIRPORT_"));
  const totalAlertCount = alerts.length + activeClientAlerts.length;
  const [ackingAll, setAckingAll] = useState(false);

  const borderColor = hasCritical
    ? "border-red-300"
    : hasWarning
    ? "border-amber-300"
    : hasLate
    ? "border-purple-300"
    : hasAirport
    ? "border-blue-300"
    : "border-gray-200";

  return (
    <div className={`rounded-xl border ${borderColor} bg-white shadow-sm overflow-hidden`}>
      {/* Header */}
      <div className="px-4 py-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <div className="flex items-center gap-1.5 text-base font-bold font-mono tracking-wide shrink-0">
            {flight.departure_icao ? (
              <Link href={`/ops/airport/${flight.departure_icao}`} className="hover:text-blue-700 hover:underline transition-colors">
                {flight.departure_icao}
              </Link>
            ) : <span>????</span>}
            <span className="text-gray-400 text-sm">→</span>
            {flight.arrival_icao ? (
              <Link href={`/ops/airport/${flight.arrival_icao}`} className="hover:text-blue-700 hover:underline transition-colors">
                {flight.arrival_icao}
              </Link>
            ) : <span>????</span>}
          </div>
          <div className="text-xs text-gray-600 truncate">
            <span className="font-medium">{fmtTime(flight.scheduled_departure)}</span>
            {flight.scheduled_arrival && (
              <span className="text-gray-400">
                {" → "}{fmtTime(flight.scheduled_arrival)}{" "}
                <span className="text-gray-400">({fmtDuration(flight.scheduled_departure, flight.scheduled_arrival)})</span>
              </span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {(() => {
            const ft = inferFlightType(flight);
            return ft ? (
              <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${flightTypeBadge(ft)}`}>
                {ft}
              </span>
            ) : null;
          })()}
          {flight.tail_number && (
            <span className="font-mono text-xs font-semibold text-gray-700 bg-gray-100 rounded px-2 py-1">
              {flight.tail_number}
            </span>
          )}
          {totalAlertCount > 0 ? (
            <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${
              hasCritical ? "bg-red-100 text-red-700"
                : hasWarning ? "bg-amber-100 text-amber-700"
                : hasLate ? "bg-purple-100 text-purple-700"
                : "bg-blue-100 text-blue-700"
            }`}>
              {totalAlertCount}
            </span>
          ) : (
            <span className="text-xs font-medium text-green-700 bg-green-50 px-2 py-0.5 rounded-full">Clear</span>
          )}
          {unackedServerAlerts.length >= 2 && (
            <button
              onClick={() => {
                setAckingAll(true);
                onAckAll(flight.id, unackedServerAlerts.map((a) => a.id));
              }}
              disabled={ackingAll}
              className="text-[10px] font-medium px-2 py-1 rounded bg-gray-100 text-gray-600 hover:bg-green-100 hover:text-green-700 transition-colors disabled:opacity-50"
            >
              {ackingAll ? "..." : "Ack All"}
            </button>
          )}
        </div>
      </div>
      {/* Alerts (server + client) */}
      {totalAlertCount > 0 && (
        <div className="px-3 pb-3 space-y-1.5">
          {alerts.map((a) => <AlertCard key={a.id} alert={a} onAck={(id) => onAck(id, fid)} acked={isAcked(a, fid)} ackedByName={showAcknowledged && a.acknowledged_by ? userMap.get(a.acknowledged_by) ?? null : null} pinned={pinnedIds?.has(a.id)} onTogglePin={onTogglePin} />)}
          {activeClientAlerts.map((ca) => (
            <ClientAlertCard key={ca.key} alert={ca} onDismiss={onDismissClient} dismissed={dismissedClientAlerts.has(ca.key)} dismissedByName={showAcknowledged && dismissedByMap.has(ca.key) ? userMap.get(dismissedByMap.get(ca.key)!) ?? null : null} pinned={pinnedKeys?.has(ca.key)} onTogglePin={onTogglePinKey} />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Day section header ──────────────────────────────────────────────────────

function DayHeader({ dateStr, flightCount, criticalCount, warningCount }: {
  dateStr: string; flightCount: number; criticalCount: number; warningCount: number;
}) {
  return (
    <div className="flex items-center gap-3 pt-4 pb-2 px-1 sticky top-0 bg-gray-50/95 backdrop-blur-sm z-10 border-b border-gray-200">
      <h3 className="font-bold text-sm text-slate-800">{fmtDayLabel(dateStr)}</h3>
      <span className="text-xs text-gray-500 font-mono">{dateStr}</span>
      <div className="flex items-center gap-1.5">
        <span className="text-xs bg-slate-100 text-slate-600 rounded-full px-2 py-0.5">
          {flightCount} flight{flightCount !== 1 ? "s" : ""}
        </span>
        {criticalCount > 0 && (
          <span className="text-xs bg-red-100 text-red-700 font-semibold rounded-full px-2 py-0.5">
            {criticalCount} critical
          </span>
        )}
        {warningCount > 0 && (
          <span className="text-xs bg-amber-100 text-amber-700 font-semibold rounded-full px-2 py-0.5">
            {warningCount} warning
          </span>
        )}
      </div>
    </div>
  );
}

// ─── Add Custom Alert form ───────────────────────────────────────────────────

function AddCustomAlertForm({ onAdd }: { onAdd: (data: { airport_icao?: string; severity: string; subject: string; body?: string; expires_at?: string }) => void }) {
  const [airport, setAirport] = useState("");
  const [severity, setSeverity] = useState("info");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [saving, setSaving] = useState(false);

  return (
    <div className="p-3 border-b border-gray-200 bg-gray-50 space-y-2">
      <div className="flex gap-2 flex-wrap">
        <div>
          <label className="text-[10px] text-gray-500 block">Airport ICAO (optional)</label>
          <input
            value={airport}
            onChange={(e) => setAirport(e.target.value.toUpperCase())}
            placeholder="e.g. KTEB"
            className="block w-24 text-xs border border-gray-300 rounded px-2 py-1"
          />
        </div>
        <div>
          <label className="text-[10px] text-gray-500 block">Severity</label>
          <select
            value={severity}
            onChange={(e) => setSeverity(e.target.value)}
            className="block text-xs border border-gray-300 rounded px-2 py-1"
          >
            <option value="info">Info</option>
            <option value="warning">Warning</option>
            <option value="critical">Critical</option>
          </select>
        </div>
        <div className="flex-1 min-w-[200px]">
          <label className="text-[10px] text-gray-500 block">Subject *</label>
          <input
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            placeholder="Short description"
            maxLength={200}
            className="block w-full text-xs border border-gray-300 rounded px-2 py-1"
          />
        </div>
      </div>
      <div>
        <label className="text-[10px] text-gray-500 block">Details (optional)</label>
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Additional details..."
          rows={2}
          maxLength={2000}
          className="block w-full text-xs border border-gray-300 rounded px-2 py-1 resize-none"
        />
      </div>
      <div className="flex justify-end">
        <button
          type="button"
          disabled={!subject.trim() || saving}
          onClick={async () => {
            setSaving(true);
            await onAdd({ airport_icao: airport || undefined, severity, subject: subject.trim(), body: body.trim() || undefined });
            setSaving(false);
          }}
          className="px-3 py-1 text-xs bg-teal-600 text-white rounded hover:bg-teal-700 disabled:opacity-50"
        >
          {saving ? "Saving..." : "Create Alert"}
        </button>
      </div>
    </div>
  );
}

// ─── Main board ───────────────────────────────────────────────────────────────

// Normalize NOTAM body for dedup: strip airport prefix, daily schedules, phone numbers.
// Domestic "AD AP CLSD DLY 0630-1315" and ICAO "SNA AD AP CLSD" should match.
function normalizeNotamBody(body: string | null, icao: string | null): string {
  if (!body) return "";
  let s = body.toUpperCase().replace(/\s+/g, " ").trim();
  // Strip leading 3-letter FAA location ID (e.g. "BOS ", "ORL ", "SNA ")
  if (icao && icao.length === 4) {
    const faaId = icao.slice(1); // KBOS → BOS
    if (s.startsWith(faaId + " ")) s = s.slice(faaId.length + 1);
  }
  // Strip daily schedule patterns: "DLY 0630-1315", "DLY 0100-1000"
  s = s.replace(/\bDLY\s+\d{4}-\d{4}\b/g, "").trim();
  // Strip phone numbers: "206-296-7334", "617-561-1919"
  s = s.replace(/\b\d{3}-\d{3}-\d{4}\b/g, "").trim();
  // Strip time ranges embedded in body: "0630-1315", "0100-1000" (standalone, not part of runway IDs)
  s = s.replace(/\b\d{4}-\d{4}\b/g, "").trim();
  // Collapse any resulting double spaces
  s = s.replace(/\s+/g, " ").trim();
  return s;
}

function filterAlerts(flights: Flight[]): Flight[] {
  return flights.map((f) => {
    const shown = (f.alerts ?? []).filter((a) => ALERT_TYPES_SHOWN.has(a.alert_type));
    // Deduplicate NOTAMs by normalized body + airport to collapse
    // domestic (03/533) vs ICAO (A5247/26) duplicates from the FAA API.
    // Keep the version with the longer body (more detail, e.g. "DLY 0630-1315").
    const notamByKey = new Map<string, OpsAlert>();
    const nonNotams: OpsAlert[] = [];
    for (const a of shown) {
      if (!a.alert_type.startsWith("NOTAM")) {
        nonNotams.push(a);
        continue;
      }
      const key = `${normalizeNotamBody(a.body, a.airport_icao)}|${a.airport_icao ?? ""}`;
      const existing = notamByKey.get(key);
      if (!existing || (a.body ?? "").length > (existing.body ?? "").length) {
        notamByKey.set(key, a);
      }
    }
    return { ...f, alerts: [...nonNotams, ...notamByKey.values()] };
  });
}

type FboHoursEntry = { is24hr: boolean; openMinutes: number | null; closeMinutes: number | null; hours: string };

export default function OpsBoard({ bakerPprAirports, fboHoursMap = {} }: { bakerPprAirports: string[]; fboHoursMap?: Record<string, FboHoursEntry> }) {
  const now = useMemo(() => new Date(), []);
  const BAKER_PPR_AIRPORTS = useMemo(() => new Set(bakerPprAirports), [bakerPprAirports]);

  // Self-contained 720hr flight + alert fetch (deferred from OpsTabs to only run when this tab is active)
  const [flights, setFlights] = useState<Flight[]>([]);
  const [suppressedRunwayNotamIds, setSuppressedRunwayNotamIds] = useState<string[]>([]);
  const [allRunwaysClosedAlerts, setAllRunwaysClosedAlerts] = useState<AllRwysClosedAlert[]>([]);
  const [alertsLoading, setAlertsLoading] = useState(true);

  useEffect(() => {
    fetch("/api/ops/flights?lookahead_hours=720&lookback_hours=12")
      .then((r) => r.json())
      .then((data) => {
        if (data.flights) setFlights(data.flights);
        if (data.suppressedRunwayNotamIds) setSuppressedRunwayNotamIds(data.suppressedRunwayNotamIds);
        if (data.allRunwaysClosedAlerts) setAllRunwaysClosedAlerts(data.allRunwaysClosedAlerts);
      })
      .catch((err) => console.error("[OpsBoard] alert fetch error:", err))
      .finally(() => setAlertsLoading(false));
  }, []);

  const [activeFilter, setActiveFilter] = useState<AlertFilter>("ALL");
  const [notamSub, setNotamSub] = useState<NotamSubFilter>("ALL_NOTAMS");
  const [pprSub, setPprSub] = useState<PprSubFilter>("ALL_PPR");
  const [flightTypeFilter, setFlightTypeFilter] = useState<Set<string>>(new Set(["Charter", "Revenue", "Positioning"]));
  const [showAllTypes, setShowAllTypes] = useState(false);
  const [activeRange, setActiveRange] = useState<TimeRange>("7D");
  const [localAckedIds, setLocalAckedIds] = useState<Set<string>>(new Set());
  // Per-flight NOTAM acks: Set of "alertId:flightId" composite keys
  const [notamFlightAcks, setNotamFlightAcks] = useState<Set<string>>(new Set());
  const [notamAckUsers, setNotamAckUsers] = useState<Map<string, string>>(new Map());
  const [showAcknowledged, setShowAcknowledged] = useState(false);
  const [showFiltered, setShowFiltered] = useState(false);
  const suppressedIds = useMemo(() => new Set(suppressedRunwayNotamIds), [suppressedRunwayNotamIds]);
  const [pinnedIds, setPinnedIds] = useState<Set<string>>(new Set());
  const [customAlerts, setCustomAlerts] = useState<CustomNotamAlert[]>([]);
  const [showAddCustom, setShowAddCustom] = useState(false);

  const [pinnedKeys, setPinnedKeys] = useState<Set<string>>(new Set());

  // Load pins and custom alerts
  useEffect(() => {
    fetch("/api/ops/notam-pins").then((r) => r.json()).then((d) => {
      const ids = new Set<string>();
      const keys = new Set<string>();
      for (const p of d.pins ?? []) {
        if (p.alert_id) ids.add(p.alert_id);
        if (p.pin_key) keys.add(p.pin_key);
      }
      setPinnedIds(ids);
      setPinnedKeys(keys);
    }).catch(() => {});
    fetch("/api/ops/custom-alerts").then((r) => r.json()).then((d) => {
      setCustomAlerts(d.alerts ?? []);
    }).catch(() => {});
  }, []);

  // Load per-flight NOTAM acks
  useEffect(() => {
    const flightIds = flights.map((f) => f.id);
    if (flightIds.length === 0) return;
    // Batch flight IDs (URL length limit)
    const batches: string[][] = [];
    for (let i = 0; i < flightIds.length; i += 100) {
      batches.push(flightIds.slice(i, i + 100));
    }
    Promise.all(
      batches.map((batch) =>
        fetch(`/api/ops/alerts/notam-ack?flight_ids=${batch.join(",")}`).then((r) => r.json())
      ),
    ).then((results) => {
      const acks = new Set<string>();
      const users = new Map<string, string>();
      for (const r of results) {
        for (const a of r.acks ?? []) {
          const key = `${a.alert_id}:${a.flight_id}`;
          acks.add(key);
          if (a.user_id) users.set(key, a.user_id);
        }
      }
      setNotamFlightAcks(acks);
      setNotamAckUsers(users);
    }).catch(() => {});
  }, [flights]);

  const togglePin = useCallback(async (alertId: string, pin: boolean) => {
    if (pin) {
      await fetch("/api/ops/notam-pins", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ alert_id: alertId }),
      });
      setPinnedIds((prev) => new Set([...prev, alertId]));
    } else {
      await fetch("/api/ops/notam-pins", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ alert_id: alertId }),
      });
      setPinnedIds((prev) => { const n = new Set(prev); n.delete(alertId); return n; });
    }
  }, []);

  const togglePinKey = useCallback(async (key: string, pin: boolean) => {
    if (pin) {
      await fetch("/api/ops/notam-pins", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin_key: key }),
      });
      setPinnedKeys((prev) => new Set([...prev, key]));
    } else {
      await fetch("/api/ops/notam-pins", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin_key: key }),
      });
      setPinnedKeys((prev) => { const n = new Set(prev); n.delete(key); return n; });
    }
  }, []);

  const addCustomAlert = useCallback(async (data: { airport_icao?: string; severity: string; subject: string; body?: string; expires_at?: string }) => {
    const res = await fetch("/api/ops/custom-alerts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    if (res.ok) {
      const { alert } = await res.json();
      setCustomAlerts((prev) => [alert, ...prev]);
      setShowAddCustom(false);
    }
  }, []);

  const archiveCustomAlert = useCallback(async (id: string) => {
    await fetch(`/api/ops/custom-alerts/${id}`, { method: "DELETE" });
    setCustomAlerts((prev) => prev.filter((a) => a.id !== id));
  }, []);
  const [dismissedClientAlerts, setDismissedClientAlerts] = useState<Set<string>>(new Set());
  const [dismissedByMap, setDismissedByMap] = useState<Map<string, string>>(new Map()); // alert_key → userId
  const [userMap, setUserMap] = useState<Map<string, string>>(new Map());

  // Load dismissed client alerts from server on mount
  useEffect(() => {
    fetch("/api/ops/alerts/client-dismiss")
      .then((r) => r.ok ? r.json() : null)
      .then((data) => {
        if (!data?.dismissals) {
          // Fallback to localStorage if server table doesn't exist yet
          setDismissedClientAlerts(loadDismissed());
          return;
        }
        const keys = new Set<string>();
        const byMap = new Map<string, string>();
        for (const d of data.dismissals as { alert_key: string; dismissed_by: string }[]) {
          keys.add(d.alert_key);
          byMap.set(d.alert_key, d.dismissed_by);
        }
        setDismissedClientAlerts(keys);
        setDismissedByMap(byMap);
      })
      .catch(() => {
        // Fallback to localStorage
        setDismissedClientAlerts(loadDismissed());
      });
  }, []);

  // Fetch user map when "All" (show acknowledged) is toggled on
  useEffect(() => {
    if (!showAcknowledged || userMap.size > 0) return;
    fetch("/api/ops/users")
      .then((r) => r.ok ? r.json() : null)
      .then((data) => {
        if (!data?.users) return;
        const map = new Map<string, string>();
        for (const [id, name] of Object.entries(data.users as Record<string, string>)) {
          map.set(id, name);
        }
        setUserMap(map);
      })
      .catch(() => {});
  }, [showAcknowledged]);

  const handleAck = useCallback((alertId: string, flightId: string) => {
    const compositeKey = `${alertId}:${flightId}`;
    const alreadyAcked = notamFlightAcks.has(compositeKey) || localAckedIds.has(compositeKey);

    if (alreadyAcked) {
      // Un-ack: remove from sets and delete server-side
      setNotamFlightAcks((prev) => { const n = new Set(prev); n.delete(compositeKey); return n; });
      setLocalAckedIds((prev) => { const n = new Set(prev); n.delete(compositeKey); return n; });
      if (flightId) {
        fetch("/api/ops/alerts/notam-ack", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ alert_id: alertId, flight_id: flightId }),
        }).catch(() => {});
      }
    } else {
      // Ack: add to sets and persist server-side
      setNotamFlightAcks((prev) => new Set(prev).add(compositeKey));
      setLocalAckedIds((prev) => new Set(prev).add(compositeKey));
      if (flightId) {
        fetch("/api/ops/alerts/notam-ack", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ alert_id: alertId, flight_id: flightId }),
        }).catch(() => {});
      }
    }
  }, [notamFlightAcks, localAckedIds]);

  const handleAckAll = useCallback((flightId: string, alertIds: string[]) => {
    setNotamFlightAcks((prev) => {
      const next = new Set(prev);
      for (const id of alertIds) next.add(`${id}:${flightId}`);
      return next;
    });
    setLocalAckedIds((prev) => {
      const next = new Set(prev);
      for (const id of alertIds) next.add(`${id}:${flightId}`);
      return next;
    });
    // Ack each alert via per-flight endpoint
    for (const id of alertIds) {
      fetch("/api/ops/alerts/notam-ack", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ alert_id: id, flight_id: flightId }),
      }).catch(() => {});
    }
  }, []);

  // An alert is "acknowledged" if:
  // - The alert row itself has acknowledged_at (legacy per-flight alerts), OR
  // - There's a per-flight NOTAM ack for this alert+flight combo
  const isAcked = useCallback(
    (a: OpsAlert, flightId?: string) => {
      if (a.acknowledged_at != null) return true;
      if (flightId) {
        const key = `${a.id}:${flightId}`;
        return notamFlightAcks.has(key) || localAckedIds.has(key);
      }
      return localAckedIds.has(a.id);
    },
    [localAckedIds, notamFlightAcks],
  );

  const handleDismissClient = useCallback((key: string) => {
    // Optimistic update
    setDismissedClientAlerts((prev) => new Set(prev).add(key));
    // Also save to localStorage as fallback
    setDismissedClientAlerts((prev) => { saveDismissed(prev); return prev; });
    // Persist to server
    fetch("/api/ops/alerts/client-dismiss", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key }),
    }).catch(() => {});
  }, []);

  // Apply alert type filtering
  const withFilteredAlerts = useMemo(() => filterAlerts(flights), [flights]);

  // Index all-runways-closed alerts by flight ID
  const rwysClosedByFlight = useMemo(() => {
    const map = new Map<string, AllRwysClosedAlert[]>();
    for (const a of allRunwaysClosedAlerts) {
      if (!map.has(a.flightId)) map.set(a.flightId, []);
      map.get(a.flightId)!.push(a);
    }
    return map;
  }, [allRunwaysClosedAlerts]);

  // Generate client-side alerts (KJAC/KSNA + after-hours + all-rwys-closed)
  const clientAlertsByFlight = useMemo(() => {
    const map = new Map<string, ClientAlert[]>();
    for (const f of withFilteredAlerts) {
      const alerts: ClientAlert[] = [];

      // ALL RUNWAYS CLOSED — critical alert at top
      for (const rc of rwysClosedByFlight.get(f.id) ?? []) {
        const phase = rc.phase === "departure" ? "Departing" : "Landing";
        alerts.push({
          key: `all-rwys-closed-${rc.phase}-${rc.airportIcao}-${f.id}`,
          flightId: f.id,
          type: "ALL_RWYS_CLOSED",
          label: "ALL RWYS CLSD",
          severity: "critical",
          message: `${phase} ${rc.airportIcao} — all runways ≥5000 ft closed ${rc.closureWindow}`,
        });
      }

      // Check departure and arrival against restricted airports
      const seen = new Set<string>();
      for (const icao of [f.departure_icao, f.arrival_icao]) {
        if (icao && RESTRICTED_AIRPORTS[icao] && !seen.has(icao)) {
          seen.add(icao);
          const ra = RESTRICTED_AIRPORTS[icao];
          alerts.push({
            key: `airport-${icao}-${f.id}`,
            flightId: f.id,
            type: `AIRPORT_${icao}`,
            label: ra.label,
            severity: ra.severity,
            message: ra.message,
          });
        }
      }

      // Check after-hours departure (8 PM – 7 AM local at departure airport)
      if (isAfterHours(f.scheduled_departure, f.departure_icao, fboHoursMap)) {
        const localTime = getLocalTimeStr(f.scheduled_departure, f.departure_icao);
        const fboEntry = fboHoursMap[f.departure_icao ?? ""];
        const hoursLabel = fboEntry && !fboEntry.is24hr && fboEntry.hours ? ` (FBO hours: ${fboEntry.hours})` : " — outside 7 AM – 8 PM";
        alerts.push({
          key: `afterhours-dep-${f.id}`,
          flightId: f.id,
          type: "AFTER_HOURS",
          label: "LATE",
          severity: "warning",
          message: `Departing ${f.departure_icao ?? "????"} at ${localTime} local${hoursLabel}`,
        });
      }

      // Check after-hours arrival
      if (isAfterHours(f.scheduled_arrival, f.arrival_icao, fboHoursMap)) {
        const localTime = getLocalTimeStr(f.scheduled_arrival!, f.arrival_icao);
        const fboEntry = fboHoursMap[f.arrival_icao ?? ""];
        const hoursLabel = fboEntry && !fboEntry.is24hr && fboEntry.hours ? ` (FBO hours: ${fboEntry.hours})` : " — outside 7 AM – 8 PM";
        alerts.push({
          key: `afterhours-arr-${f.id}`,
          flightId: f.id,
          type: "AFTER_HOURS",
          label: "LATE",
          severity: "warning",
          message: `Landing ${f.arrival_icao ?? "????"} at ${localTime} local${hoursLabel}`,
        });
      }

      // Baker PPR airports
      const pprSeen = new Set<string>();
      for (const icao of [f.departure_icao, f.arrival_icao]) {
        if (icao && BAKER_PPR_AIRPORTS.has(icao) && !pprSeen.has(icao)) {
          pprSeen.add(icao);
          alerts.push({
            key: `baker-ppr-${icao}-${f.id}`,
            flightId: f.id,
            type: "BAKER_PPR",
            label: "Baker PPR",
            severity: "info",
            message: `${icao} — Baker PPR required`,
          });
        }
      }

      if (alerts.length > 0) {
        map.set(f.id, alerts);
      }
    }
    return map;
  }, [withFilteredAlerts, BAKER_PPR_AIRPORTS, rwysClosedByFlight]);

  // Apply time range
  const cutoff = useMemo(() => {
    const range = TIME_RANGES.find((r) => r.key === activeRange);
    return new Date(now.getTime() + (range?.hours ?? 168) * 3600000);
  }, [activeRange, now]);

  const lookback = useMemo(() => new Date(now.getTime() - 12 * 3600000), [now]);

  const timeFiltered = useMemo(() => {
    return withFilteredAlerts.filter((f) => {
      const dep = new Date(f.scheduled_departure);
      return dep >= lookback && dep <= cutoff;
    });
  }, [withFilteredAlerts, cutoff, lookback]);

  // Apply alert category filter
  const alertFiltered = useMemo(() => {
    if (activeFilter === "ALL") return timeFiltered;

    // NOTAMs filter with sub-toggle
    if (activeFilter === "NOTAMS") {
      const notamTypeMap: Record<NotamSubFilter, string[]> = {
        ALL_NOTAMS: ["NOTAM_RUNWAY", "NOTAM_AERODROME", "NOTAM_AD_RESTRICTED", "NOTAM_TFR", "NOTAM_PPR", "NOTAM_OTHER"],
        RWY: ["NOTAM_RUNWAY"],
        AD: ["NOTAM_AERODROME", "NOTAM_AD_RESTRICTED"],
        TFR: ["NOTAM_TFR"],
        PPR_NOTAM: ["NOTAM_PPR"],
      };
      const types = notamTypeMap[notamSub];
      return timeFiltered.filter((f) => f.alerts?.some((a) => types.includes(a.alert_type)));
    }

    // PPR filter with sub-toggle
    if (activeFilter === "PPR") {
      if (pprSub === "NOTAM_PPR") {
        return timeFiltered.filter((f) => f.alerts?.some((a) => a.alert_type === "NOTAM_PPR"));
      }
      if (pprSub === "BAKER_PPR") {
        return timeFiltered.filter((f) =>
          (f.departure_icao && BAKER_PPR_AIRPORTS.has(f.departure_icao)) ||
          (f.arrival_icao && BAKER_PPR_AIRPORTS.has(f.arrival_icao))
        );
      }
      // ALL_PPR: NOTAM PPRs + Baker PPR airports
      return timeFiltered.filter((f) =>
        f.alerts?.some((a) => a.alert_type === "NOTAM_PPR") ||
        (f.departure_icao && BAKER_PPR_AIRPORTS.has(f.departure_icao)) ||
        (f.arrival_icao && BAKER_PPR_AIRPORTS.has(f.arrival_icao))
      );
    }

    // Oceanic HF filter — flights with OCEANIC_HF alerts
    if (activeFilter === "OCEANIC") {
      return timeFiltered.filter((f) =>
        f.alerts?.some((a) => a.alert_type === "OCEANIC_HF")
      );
    }

    // FBO Mismatch filter — flights with FBO_MISMATCH alerts
    if (activeFilter === "FBO_MISMATCH") {
      return timeFiltered.filter((f) =>
        f.alerts?.some((a) => a.alert_type === "FBO_MISMATCH")
      );
    }

    // After-hours filter (departure or arrival between 8 PM – 7 AM local, excl. 24/7 airports)
    if (activeFilter === "LATE") {
      return timeFiltered.filter((f) =>
        isAfterHours(f.scheduled_departure, f.departure_icao, fboHoursMap) ||
        isAfterHours(f.scheduled_arrival, f.arrival_icao, fboHoursMap)
      );
    }

    return timeFiltered;
  }, [timeFiltered, activeFilter, notamSub, pprSub, BAKER_PPR_AIRPORTS]);

  // Apply flight type filter on top of alert filter
  const filtered = useMemo(() => {
    if (showAllTypes || flightTypeFilter.size === 0) return alertFiltered;
    return alertFiltered.filter((f) => {
      const ft = inferFlightType(f);
      return ft !== null && flightTypeFilter.has(ft);
    });
  }, [alertFiltered, flightTypeFilter, showAllTypes]);

  // Flight type counts (computed from time-filtered flights for pill badges)
  const flightTypeCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const f of timeFiltered) {
      const ft = inferFlightType(f);
      if (ft) counts.set(ft, (counts.get(ft) ?? 0) + 1);
    }
    // Sort by count descending
    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([type, count]) => ({ type, count }));
  }, [timeFiltered]);

  // Group by day
  const byDay = useMemo(() => {
    const map = new Map<string, Flight[]>();
    for (const f of filtered) {
      const day = f.scheduled_departure.slice(0, 10);
      const arr = map.get(day) ?? [];
      arr.push(f);
      map.set(day, arr);
    }
    return Array.from(map.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, dayFlights]) => ({
        date,
        flights: dayFlights.sort((a, b) => a.scheduled_departure.localeCompare(b.scheduled_departure)),
      }));
  }, [filtered]);

  // Stats (exclude suppressed runway NOTAMs from counts)
  const isVisibleInFlight = (a: OpsAlert, fid: string) => !isAcked(a, fid) && !suppressedIds.has(a.id);
  const totalFlights = timeFiltered.length;
  const totalAlerts = timeFiltered.reduce((n, f) => n + (f.alerts?.filter((a) => isVisibleInFlight(a, f.id)).length ?? 0), 0);
  const criticalFlights = timeFiltered.filter((f) => f.alerts?.some((a) => a.severity === "critical" && isVisibleInFlight(a, f.id))).length;
  const warningFlights = timeFiltered.filter((f) =>
    f.alerts?.some((a) => a.severity === "warning" && isVisibleInFlight(a, f.id)) &&
    !f.alerts?.some((a) => a.severity === "critical" && isVisibleInFlight(a, f.id))
  ).length;

  // Alert counts per category (for pill badges)
  const alertCounts = useMemo(() => {
    const counts: Record<string, number> = { NOTAMS: 0, PPR: 0, OCEANIC: 0, FBO_MISMATCH: 0, LATE: 0 };
    const flightsCounted = { NOTAMS: new Set<string>(), PPR: new Set<string>(), OCEANIC: new Set<string>(), FBO_MISMATCH: new Set<string>(), LATE: new Set<string>() };
    for (const f of timeFiltered) {
      // Server alerts — count flights with NOTAM alerts (excluding suppressed runway NOTAMs)
      for (const a of f.alerts ?? []) {
        if (isAcked(a, f.id) || suppressedIds.has(a.id)) continue;
        if (a.alert_type.startsWith("NOTAM") && !flightsCounted.NOTAMS.has(f.id)) {
          counts.NOTAMS++;
          flightsCounted.NOTAMS.add(f.id);
        }
        if (a.alert_type === "NOTAM_PPR" && !flightsCounted.PPR.has(f.id)) {
          counts.PPR++;
          flightsCounted.PPR.add(f.id);
        }
        if (a.alert_type === "OCEANIC_HF" && !flightsCounted.OCEANIC.has(f.id)) {
          counts.OCEANIC++;
          flightsCounted.OCEANIC.add(f.id);
        }
        if (a.alert_type === "FBO_MISMATCH" && !flightsCounted.FBO_MISMATCH.has(f.id)) {
          counts.FBO_MISMATCH++;
          flightsCounted.FBO_MISMATCH.add(f.id);
        }
      }

      // Baker PPR airports (also count under PPR if not already counted)
      if (!flightsCounted.PPR.has(f.id)) {
        if ((f.departure_icao && BAKER_PPR_AIRPORTS.has(f.departure_icao)) ||
            (f.arrival_icao && BAKER_PPR_AIRPORTS.has(f.arrival_icao))) {
          counts.PPR++;
          flightsCounted.PPR.add(f.id);
        }
      }

      // Client alerts (LATE)
      const ca = clientAlertsByFlight.get(f.id) ?? [];
      for (const c of ca) {
        if (dismissedClientAlerts.has(c.key)) continue;
        if (c.type === "AFTER_HOURS" && !flightsCounted.LATE.has(f.id)) {
          counts.LATE++;
          flightsCounted.LATE.add(f.id);
        }
      }
    }
    return counts;
  }, [timeFiltered, isAcked, suppressedIds, clientAlertsByFlight, dismissedClientAlerts, BAKER_PPR_AIRPORTS]);

  // EDCT alerts for status box: unacknowledged, future or within last 24 hours
  const edctAlerts = useMemo(() => {
    const lookback = new Date(now.getTime() - 24 * 3600000);
    const results: { alert: OpsAlert; flight: Flight | null }[] = [];
    for (const f of withFilteredAlerts) {
      for (const a of f.alerts ?? []) {
        if (a.alert_type !== "EDCT") continue;
        if (isAcked(a, f.id)) continue;
        // Show if flight departs in the future or within last 24 hours
        const depTime = new Date(f.scheduled_departure);
        if (depTime >= lookback) {
          results.push({ alert: a, flight: f });
        }
      }
    }
    // Sort by departure time ascending
    results.sort((a, b) => {
      const tA = a.flight?.scheduled_departure ?? a.alert.created_at;
      const tB = b.flight?.scheduled_departure ?? b.alert.created_at;
      return tA.localeCompare(tB);
    });
    return results;
  }, [withFilteredAlerts, isAcked, now]);

  return (
    <div className="p-4 sm:p-6 space-y-4 bg-gray-50 min-h-screen">
      {/* Pinned Alerts */}
      {(pinnedIds.size > 0 || pinnedKeys.size > 0) && (() => {
        const pinnedAlerts: OpsAlert[] = [];
        const pinnedClientAlerts: ClientAlert[] = [];
        for (const f of withFilteredAlerts) {
          for (const a of f.alerts ?? []) {
            if (pinnedIds.has(a.id) && !pinnedAlerts.some((p) => p.id === a.id)) {
              pinnedAlerts.push(a);
            }
          }
          for (const ca of clientAlertsByFlight.get(f.id) ?? []) {
            if (pinnedKeys.has(ca.key) && !pinnedClientAlerts.some((p) => p.key === ca.key)) {
              pinnedClientAlerts.push(ca);
            }
          }
        }
        const totalPinned = pinnedAlerts.length + pinnedClientAlerts.length;
        if (totalPinned === 0) return null;
        return (
          <div className="rounded-xl border-2 border-amber-300 bg-amber-50 shadow-sm overflow-hidden">
            <div className="px-4 py-2.5 border-b bg-amber-100 border-amber-200 flex items-center gap-2">
              <span className="text-sm font-bold text-amber-900">Pinned Alerts</span>
              <span className="text-xs font-semibold bg-amber-200 text-amber-800 rounded-full px-2 py-0.5">
                {totalPinned}
              </span>
            </div>
            <div className="p-3 space-y-2">
              {pinnedAlerts.map((a) => (
                <AlertCard key={a.id} alert={a} onAck={(id) => handleAck(id, "")} pinned onTogglePin={togglePin} />
              ))}
              {pinnedClientAlerts.map((ca) => (
                <ClientAlertCard key={ca.key} alert={ca} onDismiss={handleDismissClient} pinned onTogglePin={togglePinKey} />
              ))}
            </div>
          </div>
        );
      })()}

      {/* Custom Alerts */}
      <div className="rounded-xl border bg-white shadow-sm overflow-hidden">
        <div className="px-4 py-2.5 border-b bg-gray-50 flex items-center gap-2">
          <span className="text-sm font-bold text-gray-800">Custom Alerts</span>
          {customAlerts.length > 0 && (
            <span className="text-xs font-semibold bg-teal-100 text-teal-800 rounded-full px-2 py-0.5">
              {customAlerts.length}
            </span>
          )}
          <button
            type="button"
            onClick={() => setShowAddCustom(!showAddCustom)}
            className="ml-auto text-xs font-medium text-blue-600 hover:text-blue-800"
          >
            {showAddCustom ? "Cancel" : "+ Add Alert"}
          </button>
        </div>
        {showAddCustom && <AddCustomAlertForm onAdd={addCustomAlert} />}
        {customAlerts.length > 0 ? (
          <div className="p-3 space-y-2">
            {customAlerts.map((a) => (
              <div
                key={a.id}
                className={`rounded-lg border text-sm px-3 py-2 flex items-start gap-2 ${
                  a.severity === "critical" ? "border-red-200 bg-red-50/60" :
                  a.severity === "warning" ? "border-amber-200 bg-amber-50/60" :
                  "border-teal-200 bg-teal-50/60"
                }`}
              >
                <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-xs font-mono font-semibold shrink-0 ${
                  a.severity === "critical" ? "bg-red-100 text-red-800 border border-red-200" :
                  a.severity === "warning" ? "bg-amber-100 text-amber-800 border border-amber-200" :
                  "bg-teal-100 text-teal-800 border border-teal-200"
                }`}>
                  Custom
                </span>
                {a.airport_icao && (
                  <span className="font-mono font-semibold text-gray-800 text-xs shrink-0">{a.airport_icao}</span>
                )}
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-medium text-gray-800">{a.subject}</p>
                  {a.body && <p className="text-xs text-gray-600 mt-0.5 line-clamp-2">{a.body}</p>}
                  <p className="text-[10px] text-gray-400 mt-0.5">
                    {a.created_by_name ?? "Unknown"} · {fmtTime(a.created_at)}
                    {a.expires_at && <> · Expires {fmtTime(a.expires_at)}</>}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => archiveCustomAlert(a.id)}
                  className="text-xs text-gray-400 hover:text-red-600 hover:bg-red-50 border border-gray-200 hover:border-red-300 rounded px-1.5 py-0.5 transition-colors shrink-0"
                >
                  Dismiss
                </button>
              </div>
            ))}
          </div>
        ) : !showAddCustom ? (
          <div className="px-4 py-3 text-sm text-gray-500">No custom alerts</div>
        ) : null}
      </div>

      {/* Summary bar */}
      <div className="rounded-xl border bg-white shadow-sm px-5 py-4 flex items-center gap-6 flex-wrap">
        <div>
          <div className="text-xs text-gray-500">Flights</div>
          <div className="text-2xl font-bold">{totalFlights}</div>
        </div>
        <div className="w-px h-10 bg-gray-200" />
        <div>
          <div className="text-xs text-gray-500">Active Alerts</div>
          <div className={`text-2xl font-bold ${totalAlerts > 0 ? "text-slate-700" : "text-gray-400"}`}>
            {totalAlerts}
          </div>
        </div>
        <div className="w-px h-10 bg-gray-200" />
        <div>
          <div className="text-xs text-gray-500">Critical</div>
          <div className={`text-2xl font-bold ${criticalFlights > 0 ? "text-red-600" : "text-gray-400"}`}>
            {criticalFlights}
          </div>
        </div>
        <div className="w-px h-10 bg-gray-200" />
        <div>
          <div className="text-xs text-gray-500">Warnings</div>
          <div className={`text-2xl font-bold ${warningFlights > 0 ? "text-amber-600" : "text-gray-400"}`}>
            {warningFlights}
          </div>
        </div>
        <div className="ml-auto text-xs text-gray-400">
          {alertsLoading ? (
            <span className="text-blue-500 animate-pulse">Loading alerts…</span>
          ) : (
            <>Updated {now.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" })}Z</>
          )}
        </div>
      </div>

      {/* Time range tabs + filter pills */}
      <div className="flex flex-col gap-3">
        <div className="flex flex-col sm:flex-row items-start sm:items-center gap-3">
          {/* Time range tabs */}
          <div className="flex rounded-lg border border-gray-200 bg-white p-0.5 shadow-sm">
            {TIME_RANGES.map((r) => (
              <button
                key={r.key}
                type="button"
                onClick={() => setActiveRange(r.key)}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                  activeRange === r.key
                    ? "bg-slate-800 text-white shadow-sm"
                    : "text-gray-600 hover:text-gray-900 hover:bg-gray-50"
                }`}
              >
                {r.label}
              </button>
            ))}
          </div>

          {/* Filter pills */}
          <div className="flex items-center gap-1.5 flex-wrap">
            {FILTER_OPTIONS.map((opt) => {
              const count = opt.key === "ALL" ? null : alertCounts[opt.key] ?? 0;
              const isActive = activeFilter === opt.key;
              return (
                <button
                  key={opt.key}
                  type="button"
                  onClick={() => setActiveFilter(opt.key)}
                  title={opt.description}
                  className={`inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded-full border transition-colors ${
                    isActive
                      ? opt.key === "LATE"
                        ? "bg-purple-100 text-purple-800 border-purple-300"
                        : "bg-slate-800 text-white border-slate-800"
                      : "bg-white text-gray-600 border-gray-200 hover:border-gray-400 hover:bg-gray-50"
                  }`}
                >
                  {opt.label}
                  {count !== null && count > 0 && (
                    <span className={`inline-flex items-center justify-center min-w-[16px] h-4 px-1 text-[10px] font-bold rounded-full ${
                      isActive
                        ? opt.key === "LATE" ? "bg-purple-200 text-purple-900" : "bg-white/30 text-white"
                        : opt.key === "LATE" ? "bg-purple-100 text-purple-700" : "bg-gray-100 text-gray-600"
                    }`}>
                      {count}
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          {/* Unacknowledged / All / Filtered toggle */}
          <div className="flex rounded-lg border border-gray-200 bg-white p-0.5 shadow-sm ml-auto">
            <button
              type="button"
              onClick={() => { setShowAcknowledged(false); setShowFiltered(false); }}
              className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors ${
                !showAcknowledged && !showFiltered
                  ? "bg-slate-800 text-white shadow-sm"
                  : "text-gray-600 hover:text-gray-900 hover:bg-gray-50"
              }`}
            >
              Unacknowledged
            </button>
            <button
              type="button"
              onClick={() => { setShowAcknowledged(true); setShowFiltered(false); }}
              className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors ${
                showAcknowledged && !showFiltered
                  ? "bg-slate-800 text-white shadow-sm"
                  : "text-gray-600 hover:text-gray-900 hover:bg-gray-50"
              }`}
            >
              All
            </button>
            {suppressedIds.size > 0 && (
              <button
                type="button"
                onClick={() => { setShowFiltered(!showFiltered); setShowAcknowledged(false); }}
                className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors flex items-center gap-1 ${
                  showFiltered
                    ? "bg-orange-500 text-white shadow-sm"
                    : "text-gray-600 hover:text-gray-900 hover:bg-gray-50"
                }`}
              >
                Filtered
                <span className={`inline-flex items-center justify-center min-w-[16px] h-4 px-1 text-[10px] font-bold rounded-full ${
                  showFiltered ? "bg-white/30 text-white" : "bg-orange-100 text-orange-700"
                }`}>
                  {suppressedIds.size}
                </span>
              </button>
            )}
          </div>
        </div>

        {/* Sub-toggle for NOTAMs */}
        {activeFilter === "NOTAMS" && (
          <div className="flex items-center gap-1 pl-1">
            <span className="text-xs text-gray-400 mr-1">Type:</span>
            <div className="flex rounded-lg border border-gray-200 bg-white p-0.5 shadow-sm">
              {NOTAM_SUB_OPTIONS.map((opt) => (
                <button
                  key={opt.key}
                  type="button"
                  onClick={() => setNotamSub(opt.key)}
                  className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors ${
                    notamSub === opt.key
                      ? "bg-amber-600 text-white shadow-sm"
                      : "text-gray-600 hover:text-gray-900 hover:bg-gray-50"
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Sub-toggle for PPRs */}
        {activeFilter === "PPR" && (
          <div className="flex items-center gap-1 pl-1">
            <span className="text-xs text-gray-400 mr-1">Source:</span>
            <div className="flex rounded-lg border border-gray-200 bg-white p-0.5 shadow-sm">
              {PPR_SUB_OPTIONS.map((opt) => (
                <button
                  key={opt.key}
                  type="button"
                  onClick={() => setPprSub(opt.key)}
                  className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors ${
                    pprSub === opt.key
                      ? "bg-amber-600 text-white shadow-sm"
                      : "text-gray-600 hover:text-gray-900 hover:bg-gray-50"
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Flight type filter pills */}
        {flightTypeCounts.length > 0 && (
          <div className="flex items-center gap-1.5 flex-wrap pl-1">
            <span className="text-xs text-gray-400 mr-0.5">Type:</span>
            <button
              type="button"
              onClick={() => { setShowAllTypes(true); setFlightTypeFilter(new Set()); }}
              className={`px-2.5 py-1 text-xs font-medium rounded-full border transition-colors ${
                showAllTypes
                  ? "bg-slate-800 text-white border-slate-800"
                  : "bg-white text-gray-600 border-gray-200 hover:border-gray-400 hover:bg-gray-50"
              }`}
            >
              All
            </button>
            {flightTypeCounts.map(({ type, count }) => {
              const isActive = !showAllTypes && flightTypeFilter.has(type);
              const colors = FLIGHT_TYPE_COLORS[type];
              return (
                <button
                  key={type}
                  type="button"
                  onClick={() => {
                    setShowAllTypes(false);
                    setFlightTypeFilter((prev) => {
                      const next = new Set(prev);
                      if (next.has(type)) {
                        next.delete(type);
                      } else {
                        next.add(type);
                      }
                      return next;
                    });
                  }}
                  className={`inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded-full border transition-colors ${
                    isActive
                      ? colors
                        ? `${colors} border-current`
                        : "bg-slate-800 text-white border-slate-800"
                      : "bg-white text-gray-600 border-gray-200 hover:border-gray-400 hover:bg-gray-50"
                  }`}
                >
                  {type}
                  <span className={`inline-flex items-center justify-center min-w-[16px] h-4 px-1 text-[10px] font-bold rounded-full ${
                    isActive
                      ? "bg-white/30 text-inherit"
                      : "bg-gray-100 text-gray-600"
                  }`}>
                    {count}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Flight cards by day */}
      {filtered.length === 0 ? (
        <div className="rounded-xl border bg-white shadow-sm px-6 py-12 text-center text-gray-400">
          {(activeFilter !== "ALL" || !showAllTypes)
            ? "No flights match the current filter."
            : `No flights scheduled in the selected time range.`}
        </div>
      ) : (
        <div className="space-y-1">
          {byDay.map(({ date, flights: dayFlights }) => {
            const dayCritical = dayFlights.filter((f) =>
              f.alerts?.some((a) => a.severity === "critical" && isVisibleInFlight(a, f.id))
            ).length;
            const dayWarning = dayFlights.filter((f) =>
              f.alerts?.some((a) => a.severity === "warning" && isVisibleInFlight(a, f.id)) &&
              !f.alerts?.some((a) => a.severity === "critical" && isVisibleInFlight(a, f.id))
            ).length;

            return (
              <div key={date}>
                <DayHeader
                  dateStr={date}
                  flightCount={dayFlights.length}
                  criticalCount={dayCritical}
                  warningCount={dayWarning}
                />
                <div className="grid gap-2 pt-2">
                  {dayFlights
                    .filter((f) => !showFiltered || f.alerts?.some((a) => suppressedIds.has(a.id)))
                    .map((f) => (
                    <FlightCard
                      key={f.id}
                      flight={f}
                      isAcked={isAcked}
                      showAcknowledged={showAcknowledged}
                      showFiltered={showFiltered}
                      suppressedIds={suppressedIds}
                      onAck={handleAck}
                      onAckAll={handleAckAll}
                      clientAlerts={clientAlertsByFlight.get(f.id) ?? []}
                      dismissedClientAlerts={dismissedClientAlerts}
                      onDismissClient={handleDismissClient}
                      userMap={userMap}
                      dismissedByMap={dismissedByMap}
                      pinnedIds={pinnedIds}
                      onTogglePin={togglePin}
                      pinnedKeys={pinnedKeys}
                      onTogglePinKey={togglePinKey}
                    />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
