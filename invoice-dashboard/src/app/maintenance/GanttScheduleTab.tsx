"use client";

/**
 * GanttScheduleTab — Weekly flight schedule grid, one row per tail.
 *
 * Features:
 *  - Flight blocks color-coded by type (charter, positioning, maintenance)
 *  - Van assignment badges on flight blocks (click to assign/change)
 *  - MX note blocks (clickable for details, van assignment, acknowledge)
 *  - Create MX events by clicking "+" on any cell
 *  - MX Queue sidebar showing unscheduled/overdue items
 */

import { useState, useMemo, useRef, useCallback, useEffect } from "react";
import type { Flight, MxNote, MelItem } from "@/lib/opsApi";
import { FIXED_VAN_ZONES } from "@/lib/maintenanceData";
import { getAirportInfo } from "@/lib/airportCoords";
import { createClient as createBrowserSupabase } from "@/lib/supabase/client";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DAYS_TO_SHOW = 7;
const DISPLAY_TZ = "America/New_York";

const VAN_COLORS = [
  "#ef4444","#f97316","#eab308","#22c55e","#14b8a6","#06b6d4",
  "#3b82f6","#6366f1","#8b5cf6","#a855f7","#d946ef","#ec4899",
  "#f43f5e","#78716c","#0ea5e9","#84cc16",
];

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

function fmtIcao(icao: string | null): string {
  if (!icao) return "?";
  return icao.replace(/^K/, "");
}

function toETDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-CA", { timeZone: DISPLAY_TZ });
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  let h = parseInt(d.toLocaleTimeString("en-US", { hour: "numeric", hour12: false, timeZone: DISPLAY_TZ }));
  const m = d.toLocaleTimeString("en-US", { minute: "2-digit", timeZone: DISPLAY_TZ }).split(":").pop()?.replace(/\D/g, "").padStart(2, "0") ?? "00";
  const ampm = h >= 12 ? "p" : "a";
  if (h > 12) h -= 12;
  if (h === 0) h = 12;
  return m === "00" ? `${h}${ampm}` : `${h}:${m}${ampm}`;
}

function fmtDayHeader(dateStr: string): string {
  const d = new Date(dateStr + "T12:00:00");
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

function typeBadge(ft: string | null): string {
  if (!ft) return "?";
  if (ft === "Charter" || ft === "Revenue") return "R";
  if (ft === "Positioning" || ft === "Ferry" || ft === "Needs pos") return "P";
  if (ft === "Maintenance") return "M";
  if (ft === "Owner") return "O";
  if (ft === "Training") return "T";
  return ft[0]?.toUpperCase() ?? "?";
}

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
// Van Picker dropdown
// ---------------------------------------------------------------------------

function VanPicker({ currentVanId, arrivalIcao, pos, onPick, onClose }: {
  currentVanId: number | null;
  arrivalIcao?: string | null;
  pos?: { top: number; left: number } | null;
  onPick: (vanId: number | null) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [onClose]);

  const arrInfo = arrivalIcao ? getAirportInfo(arrivalIcao.replace(/^K/, "")) : null;

  return (
    <div ref={ref}
      className="fixed z-[9999] bg-white border border-gray-200 rounded-lg shadow-xl py-1 w-52 max-h-72 overflow-y-auto text-[10px]"
      style={pos ? { top: pos.top, left: pos.left } : {}}>
      {arrInfo && (
        <div className="px-2 py-1.5 border-b border-gray-100 text-gray-500">
          <span className="font-mono font-bold text-gray-700">{fmtIcao(arrivalIcao!)}</span> — {arrInfo.city}{arrInfo.state ? `, ${arrInfo.state}` : ""}
        </div>
      )}
      {currentVanId != null && (
        <button
          onClick={() => onPick(null)}
          className="w-full text-left px-2 py-1 hover:bg-red-50 text-red-600"
        >
          Remove van
        </button>
      )}
      {FIXED_VAN_ZONES.map((z) => (
        <button
          key={z.vanId}
          onClick={() => onPick(z.vanId)}
          className={`w-full text-left px-2 py-1.5 hover:bg-gray-50 flex items-center gap-1.5 ${
            z.vanId === currentVanId ? "bg-blue-50 font-bold" : ""
          }`}
        >
          <span
            className="w-2.5 h-2.5 rounded-full flex-shrink-0"
            style={{ backgroundColor: VAN_COLORS[(z.vanId - 1) % VAN_COLORS.length] }}
          />
          <span>V{z.vanId}</span>
          <span className="text-gray-400">{z.city}</span>
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// MX Detail Popover
// ---------------------------------------------------------------------------

function MxPopover({ note, pos, onAssignVan, onAcknowledge, onMove, onClose }: {
  note: MxNote;
  pos?: { top: number; left: number } | null;
  onAssignVan: (vanId: number | null) => void;
  onAcknowledge: () => void;
  onMove: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [showVanPicker, setShowVanPicker] = useState(false);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [onClose]);

  return (
    <div ref={ref}
      className="fixed z-[9999] bg-white border border-gray-200 rounded-lg shadow-xl p-3 w-72 text-xs space-y-2"
      style={pos ? { top: pos.top, left: pos.left } : {}}>
      <div className="font-bold text-sm text-gray-800">{note.subject ?? "Maintenance"}</div>
      {note.description && <div className="text-gray-600 whitespace-pre-wrap">{note.description}</div>}
      {note.body && note.body !== note.description && <div className="text-gray-500 whitespace-pre-wrap">{note.body}</div>}
      <div className="flex items-center gap-2 text-gray-500">
        {note.airport_icao && <span className="font-mono">{fmtIcao(note.airport_icao)}</span>}
        {note.start_time && <span>{fmtTime(note.start_time)}</span>}
        {note.end_time && <><span>-</span><span>{fmtTime(note.end_time)}</span></>}
      </div>
      <div className="flex items-center gap-2 pt-1 border-t border-gray-100">
        <div className="relative">
          <button
            onClick={() => setShowVanPicker(!showVanPicker)}
            className="px-2 py-1 rounded border border-gray-200 hover:bg-gray-50 text-[10px]"
          >
            {note.assigned_van ? `V${note.assigned_van}` : "Assign Van"}
          </button>
          {showVanPicker && (
            <VanPicker
              currentVanId={note.assigned_van ?? null}
              onPick={(v) => { onAssignVan(v); setShowVanPicker(false); }}
              onClose={() => setShowVanPicker(false)}
            />
          )}
        </div>
        <button
          onClick={onMove}
          className="px-2 py-1 rounded border border-gray-200 hover:bg-blue-50 text-blue-700 text-[10px]"
        >
          Move
        </button>
        <button
          onClick={onAcknowledge}
          className="px-2 py-1 rounded border border-gray-200 hover:bg-green-50 text-green-700 text-[10px]"
        >
          Acknowledge
        </button>
        <button onClick={onClose} className="ml-auto px-2 py-1 text-gray-400 hover:text-gray-600 text-[10px]">
          Close
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Create MX Form (inline)
// ---------------------------------------------------------------------------

function CreateMxForm({ tail, date, onSubmit, onCancel }: {
  tail: string;
  date: string;
  onSubmit: (data: { subject: string; body?: string; tail_number: string; airport_icao?: string }) => void;
  onCancel: () => void;
}) {
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [airport, setAirport] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onCancel();
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [onCancel]);

  return (
    <div ref={ref} className="absolute top-full left-0 z-50 mt-1 bg-white border border-gray-200 rounded-lg shadow-xl p-3 w-72 text-xs space-y-2">
      <div className="font-bold text-sm text-gray-800">New MX — {tail}</div>
      <div className="text-[10px] text-gray-400">{fmtDayHeader(date)}</div>
      <input
        autoFocus
        placeholder="Subject (required)"
        value={subject}
        onChange={(e) => setSubject(e.target.value)}
        className="w-full px-2 py-1.5 border border-gray-200 rounded text-xs"
      />
      <input
        placeholder="Airport ICAO (optional)"
        value={airport}
        onChange={(e) => setAirport(e.target.value.toUpperCase())}
        className="w-full px-2 py-1.5 border border-gray-200 rounded text-xs font-mono"
      />
      <textarea
        placeholder="Notes (optional)"
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={2}
        className="w-full px-2 py-1.5 border border-gray-200 rounded text-xs resize-none"
      />
      <div className="flex gap-2">
        <button
          disabled={!subject.trim()}
          onClick={() => onSubmit({
            subject: subject.trim(),
            body: body.trim() || undefined,
            tail_number: tail,
            airport_icao: airport.trim() || undefined,
          })}
          className="px-3 py-1.5 rounded bg-red-500 text-white text-[10px] font-medium disabled:opacity-40 hover:bg-red-600"
        >
          Create MX
        </button>
        <button onClick={onCancel} className="px-3 py-1.5 rounded border border-gray-200 text-[10px] hover:bg-gray-50">
          Cancel
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// MX Queue Sidebar
// ---------------------------------------------------------------------------

function MxQueueSidebar({ mxNotes, melItems, onClose, onSchedule }: {
  mxNotes: MxNote[];
  melItems: MelItem[];
  onClose: () => void;
  onSchedule: (noteId: string, tail: string, date: string) => void;
}) {
  const today = todayET();

  const unscheduled = mxNotes.filter((n) => !n.scheduled_date && n.tail_number && !n.acknowledged_at);
  const overdue = mxNotes.filter((n) => n.scheduled_date && n.scheduled_date < today && !n.acknowledged_at);
  const expiringMels = melItems.filter((m) => {
    if (m.status !== "open" || !m.expiration_date) return false;
    const daysLeft = (new Date(m.expiration_date).getTime() - Date.now()) / 86400000;
    return daysLeft <= 7 && daysLeft > 0;
  });

  const totalItems = unscheduled.length + overdue.length + expiringMels.length;

  return (
    <div className="w-72 flex-shrink-0 border-l border-gray-200 bg-gray-50 overflow-y-auto">
      <div className="sticky top-0 bg-gray-50 border-b border-gray-200 px-3 py-2 flex items-center justify-between">
        <span className="text-sm font-bold text-gray-700">MX Queue ({totalItems})</span>
        <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-lg leading-none">&times;</button>
      </div>

      {overdue.length > 0 && (
        <div className="px-3 py-2">
          <div className="text-[10px] font-bold text-red-600 uppercase tracking-wider mb-1">Overdue ({overdue.length})</div>
          {overdue.map((n) => (
            <MxQueueCard key={n.id} note={n} isOverdue />
          ))}
        </div>
      )}

      {unscheduled.length > 0 && (
        <div className="px-3 py-2">
          <div className="text-[10px] font-bold text-amber-600 uppercase tracking-wider mb-1">Unscheduled ({unscheduled.length})</div>
          {unscheduled.map((n) => (
            <MxQueueCard key={n.id} note={n} />
          ))}
        </div>
      )}

      {expiringMels.length > 0 && (
        <div className="px-3 py-2">
          <div className="text-[10px] font-bold text-orange-600 uppercase tracking-wider mb-1">Expiring MELs ({expiringMels.length})</div>
          {expiringMels.map((m) => {
            const daysLeft = Math.ceil((new Date(m.expiration_date!).getTime() - Date.now()) / 86400000);
            return (
              <div key={m.id} className="rounded border border-orange-200 bg-orange-50 p-2 mb-1 text-[10px]">
                <div className="font-bold text-orange-800">{m.tail_number} — {m.mel_reference}</div>
                <div className="text-orange-700 truncate">{m.description}</div>
                <div className="text-orange-500 mt-0.5">{daysLeft}d left · Cat {m.category}</div>
              </div>
            );
          })}
        </div>
      )}

      {totalItems === 0 && (
        <div className="px-3 py-8 text-center text-gray-400 text-xs">No pending MX items</div>
      )}
    </div>
  );
}

function MxQueueCard({ note, isOverdue }: { note: MxNote; isOverdue?: boolean }) {
  const borderColor = isOverdue ? "border-red-200" : "border-amber-200";
  const bgColor = isOverdue ? "bg-red-50" : "bg-amber-50";
  return (
    <div className={`rounded border ${borderColor} ${bgColor} p-2 mb-1 text-[10px]`}>
      <div className={`font-bold ${isOverdue ? "text-red-800" : "text-amber-800"}`}>
        {note.tail_number} {note.airport_icao ? `@ ${fmtIcao(note.airport_icao)}` : ""}
      </div>
      <div className={`truncate ${isOverdue ? "text-red-700" : "text-amber-700"}`}>
        {note.subject ?? note.description ?? "Maintenance"}
      </div>
      {note.scheduled_date && (
        <div className="text-red-500 mt-0.5">Due: {note.scheduled_date}</div>
      )}
      {note.assigned_van && (
        <span className="inline-block mt-0.5 px-1.5 py-0.5 rounded text-white text-[8px] font-bold"
          style={{ backgroundColor: VAN_COLORS[(note.assigned_van - 1) % VAN_COLORS.length] }}>
          V{note.assigned_van}
        </span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tail Detail Popup
// ---------------------------------------------------------------------------

function TailDetailPopup({ tail, mxNotes, aircraftType, pos, onClose, onEditMx, onCreateMx, onAcknowledgeMx }: {
  tail: string;
  mxNotes: MxNote[];
  aircraftType: string;
  pos: { top: number; left: number };
  onClose: () => void;
  onEditMx: (noteId: string, pos: { top: number; left: number }) => void;
  onCreateMx: (data: { subject: string; body?: string; tail_number: string; airport_icao?: string }) => void;
  onAcknowledgeMx: (noteId: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [onClose]);

  const tailNotes = mxNotes.filter((n) => n.tail_number === tail && !n.acknowledged_at);
  const mels = tailNotes.filter((n) => n.subject?.toUpperCase().includes("MEL") || n.description?.toUpperCase().includes("MEL"));
  const otherMx = tailNotes.filter((n) => !n.subject?.toUpperCase().includes("MEL") && !n.description?.toUpperCase().includes("MEL"));

  return (
    <div ref={ref} className="fixed z-[9999] bg-white border border-gray-200 rounded-lg shadow-xl p-4 w-96 max-h-[80vh] overflow-y-auto text-xs"
      style={{ top: "50%", left: "50%", transform: "translate(-50%, -50%)" }}>
      <div className="flex items-center justify-between mb-2">
        <div>
          <span className="font-bold text-sm text-gray-800 font-mono">{tail}</span>
          <span className="ml-2 text-gray-400 text-[10px]">{aircraftType}</span>
        </div>
        <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-lg">&times;</button>
      </div>

      {mels.length > 0 && (
        <div className="mb-2">
          <div className="text-[10px] font-bold text-orange-600 uppercase tracking-wider mb-1">MEL Items ({mels.length})</div>
          {mels.map((n) => {
            const endTime = n.end_time ? new Date(n.end_time) : null;
            const daysLeft = endTime ? Math.ceil((endTime.getTime() - Date.now()) / 86400000) : null;
            return (
              <div key={n.id} className="rounded border border-orange-200 bg-orange-50 p-1.5 mb-1 text-[10px]">
                <div className="flex items-start justify-between">
                  <div className="font-bold text-orange-800">{n.subject ?? "MEL"}</div>
                  <div className="flex items-center gap-1.5 ml-1 flex-shrink-0">
                    <button
                      onClick={(e) => {
                        const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                        onEditMx(n.id, { top: rect.bottom + 4, left: rect.left });
                      }}
                      className="text-blue-500 hover:text-blue-700 text-[9px] font-medium"
                    >Edit</button>
                    <button
                      onClick={() => onAcknowledgeMx(n.id)}
                      className="text-red-400 hover:text-red-600 text-[9px] font-bold leading-none"
                      title="Acknowledge / remove"
                    >&times;</button>
                  </div>
                </div>
                {n.description && <div className="text-orange-700 mt-0.5">{n.description}</div>}
                <div className="text-orange-500 mt-0.5 flex gap-2">
                  {n.airport_icao && <span>{fmtIcao(n.airport_icao)}</span>}
                  {daysLeft !== null && <span className={daysLeft <= 3 ? "text-red-600 font-bold" : ""}>{daysLeft}d left</span>}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {otherMx.length > 0 && (
        <div>
          <div className="text-[10px] font-bold text-red-600 uppercase tracking-wider mb-1">MX Notes ({otherMx.length})</div>
          {otherMx.map((n) => (
            <div key={n.id} className="rounded border border-red-200 bg-red-50 p-1.5 mb-1 text-[10px]">
              <div className="flex items-start justify-between">
                <div className="font-bold text-red-800">{n.subject ?? n.description ?? "Maintenance"}</div>
                <div className="flex items-center gap-1.5 ml-1 flex-shrink-0">
                  <button
                    onClick={(e) => {
                      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                      onEditMx(n.id, { top: rect.bottom + 4, left: rect.left });
                    }}
                    className="text-blue-500 hover:text-blue-700 text-[9px] font-medium"
                  >Edit</button>
                  <button
                    onClick={() => onAcknowledgeMx(n.id)}
                    className="text-red-400 hover:text-red-600 text-[9px] font-bold leading-none"
                    title="Acknowledge / remove"
                  >&times;</button>
                </div>
              </div>
              {n.body && n.body !== n.subject && <div className="text-red-700 mt-0.5 whitespace-pre-wrap">{n.body}</div>}
              <div className="text-red-500 mt-0.5 flex gap-2">
                {n.airport_icao && <span>{fmtIcao(n.airport_icao)}</span>}
                {n.start_time && <span>{fmtTime(n.start_time)}{n.end_time ? ` - ${fmtTime(n.end_time)}` : ""}</span>}
                {n.assigned_van && <span>V{n.assigned_van}</span>}
              </div>
            </div>
          ))}
        </div>
      )}

      {tailNotes.length === 0 && (
        <div className="text-gray-400 text-center py-4">No active MX items</div>
      )}

      {/* Inline create form */}
      <InlineCreateMx tail={tail} onSubmit={onCreateMx} />
    </div>
  );
}

function InlineCreateMx({ tail, onSubmit }: {
  tail: string;
  onSubmit: (data: { subject: string; body?: string; tail_number: string; airport_icao?: string }) => void;
}) {
  const [open, setOpen] = useState(false);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [airport, setAirport] = useState("");

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="w-full mt-2 py-1.5 rounded border border-dashed border-gray-300 text-gray-400 hover:border-red-300 hover:text-red-500 text-[10px] font-medium transition-colors"
      >
        + Add MX Note
      </button>
    );
  }

  return (
    <div className="mt-2 rounded border border-red-200 bg-red-50 p-2 space-y-1.5">
      <input
        autoFocus
        placeholder="Subject (required)"
        value={subject}
        onChange={(e) => setSubject(e.target.value)}
        className="w-full px-2 py-1.5 border border-gray-200 rounded text-xs bg-white"
      />
      <input
        placeholder="Airport ICAO (optional)"
        value={airport}
        onChange={(e) => setAirport(e.target.value.toUpperCase())}
        className="w-full px-2 py-1.5 border border-gray-200 rounded text-xs font-mono bg-white"
      />
      <textarea
        placeholder="Details (optional)"
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={2}
        className="w-full px-2 py-1.5 border border-gray-200 rounded text-xs resize-none bg-white"
      />
      <div className="flex gap-2">
        <button
          disabled={!subject.trim()}
          onClick={() => {
            onSubmit({
              subject: subject.trim(),
              body: body.trim() || undefined,
              tail_number: tail,
              airport_icao: airport.trim() || undefined,
            });
            setSubject(""); setBody(""); setAirport(""); setOpen(false);
          }}
          className="px-3 py-1.5 rounded bg-red-500 text-white text-[10px] font-medium disabled:opacity-40 hover:bg-red-600"
        >
          Create
        </button>
        <button onClick={() => setOpen(false)} className="px-3 py-1.5 rounded border border-gray-200 text-[10px] hover:bg-gray-50 bg-white">
          Cancel
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main Component
// ---------------------------------------------------------------------------

type Props = {
  flights: Flight[];
  mxNotes?: MxNote[];
  melItems?: MelItem[];
};

export default function GanttScheduleTab({ flights, mxNotes = [], melItems = [] }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);

  // Van assignment state: flightId -> vanId (loaded from drafts API)
  const [vanOverrides, setVanOverrides] = useState<Map<string, number>>(new Map());
  const [vanPickerFlight, setVanPickerFlight] = useState<string | null>(null);
  const [vanPickerPos, setVanPickerPos] = useState<{ top: number; left: number } | null>(null);
  const [vanPickerArrIcao, setVanPickerArrIcao] = useState<string | null>(null);
  const [mxPopoverId, setMxPopoverId] = useState<string | null>(null);
  const [mxPopoverPos, setMxPopoverPos] = useState<{ top: number; left: number } | null>(null);
  const [showMxQueue, setShowMxQueue] = useState(false);
  const [createMxCell, setCreateMxCell] = useState<{ tail: string; date: string } | null>(null);
  const [localMxNotes, setLocalMxNotes] = useState<MxNote[]>(mxNotes);
  // MX move mode: select an MX note, then click a destination cell
  const [movingMxId, setMovingMxId] = useState<string | null>(null);
  // Drag state for MX items
  const [draggingMxId, setDraggingMxId] = useState<string | null>(null);
  // Tail detail popup
  const [tailPopup, setTailPopup] = useState<{ tail: string; pos: { top: number; left: number } } | null>(null);

  // Keep localMxNotes in sync when props change
  useEffect(() => { setLocalMxNotes(mxNotes); }, [mxNotes]);

  // Aircraft type mapping for grouping (Challenger first, then Citation X)
  const [aircraftTypes, setAircraftTypes] = useState<Map<string, string>>(new Map());
  useEffect(() => {
    const supa = createBrowserSupabase();
    supa.from("aircraft_tracker").select("tail_number, aircraft_type").then(({ data }) => {
      if (!data) return;
      const m = new Map<string, string>();
      for (const a of data) {
        if (a.tail_number && a.aircraft_type) m.set(a.tail_number, a.aircraft_type);
      }
      setAircraftTypes(m);
    });
  }, []);

  // Start date for the grid
  const [startDate, setStartDate] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0")].join("-");
  });

  const dates = useMemo(() => dateRange(startDate, DAYS_TO_SHOW), [startDate]);
  const today = todayET();

  // Load van overrides for all visible dates
  useEffect(() => {
    let cancelled = false;
    async function load() {
      const allOverrides = new Map<string, number>();
      await Promise.all(dates.map(async (d) => {
        try {
          const res = await fetch(`/api/vans/drafts?date=${d}`);
          if (!res.ok) return;
          const data = await res.json();
          for (const [fid, vid] of (data.overrides ?? []) as [string, number][]) {
            allOverrides.set(fid, vid);
          }
        } catch {}
      }));
      if (!cancelled) setVanOverrides(allOverrides);
    }
    load();
    return () => { cancelled = true; };
  }, [dates]);

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

  // Van assignment handler
  const assignVan = useCallback(async (flightId: string, vanId: number | null, date: string) => {
    // Optimistic update
    setVanOverrides((prev) => {
      const next = new Map(prev);
      if (vanId == null) next.delete(flightId);
      else next.set(flightId, vanId);
      return next;
    });
    setVanPickerFlight(null);
    try {
      await fetch("/api/vans/drafts", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date, flightId, vanId }),
      });
    } catch {}
  }, []);

  // MX van assignment handler
  const assignMxVan = useCallback(async (noteId: string, vanId: number | null) => {
    setLocalMxNotes((prev) => prev.map((n) => n.id === noteId ? { ...n, assigned_van: vanId ?? undefined } : n));
    try {
      await fetch(`/api/ops/mx-notes/${noteId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assigned_van: vanId }),
      });
    } catch {}
  }, []);

  // MX acknowledge handler
  const acknowledgeMx = useCallback(async (noteId: string) => {
    setLocalMxNotes((prev) => prev.filter((n) => n.id !== noteId));
    setMxPopoverId(null);
    try {
      await fetch(`/api/ops/mx-notes/${noteId}`, { method: "DELETE" });
    } catch {}
  }, []);

  // Create MX handler
  const createMx = useCallback(async (data: { subject: string; body?: string; tail_number: string; airport_icao?: string }) => {
    setCreateMxCell(null);
    try {
      const res = await fetch("/api/ops/mx-notes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      if (res.ok) {
        const { note } = await res.json();
        setLocalMxNotes((prev) => [...prev, note]);
      }
    } catch {}
  }, []);

  // Move MX to a different date (same tail — MX items stay on their aircraft)
  const moveMx = useCallback(async (noteId: string, _tail: string, newDate: string) => {
    const note = localMxNotes.find((n) => n.id === noteId);
    if (!note) { setMovingMxId(null); return; }
    const tail = note.tail_number; // always keep original tail
    setMovingMxId(null);
    setMxPopoverId(null);
    setLocalMxNotes((prev) => prev.map((n) =>
      n.id === noteId
        ? { ...n, scheduled_date: newDate, start_time: null, end_time: null }
        : n
    ));
    try {
      await fetch(`/api/ops/mx-notes/${noteId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tail_number: tail, scheduled_date: newDate }),
      });
    } catch {}
  }, [localMxNotes]);

  // Build grid data
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

    for (const dayMap of tailDays.values()) {
      for (const flts of dayMap.values()) {
        flts.sort((a, b) => a.scheduled_departure.localeCompare(b.scheduled_departure));
      }
    }

    // Sort: group by aircraft type (Challenger first), then alphabetically
    const TYPE_ORDER: Record<string, number> = { "Challenger 300": 0, "Cessna Citation X": 1 };
    const tails = [...tailDays.keys()].sort((a, b) => {
      const typeA = aircraftTypes.get(a) ?? "ZZZ";
      const typeB = aircraftTypes.get(b) ?? "ZZZ";
      const orderA = TYPE_ORDER[typeA] ?? 99;
      const orderB = TYPE_ORDER[typeB] ?? 99;
      if (orderA !== orderB) return orderA - orderB;
      if (typeA !== typeB) return typeA.localeCompare(typeB);
      return a.localeCompare(b);
    });
    return { tailDays, tails };
  }, [flights, dates, aircraftTypes]);

  // MX notes by tail/date
  const mxByTailDate = useMemo(() => {
    const map = new Map<string, Map<string, MxNote[]>>();
    for (const n of localMxNotes) {
      if (!n.tail_number) continue;
      const date = n.start_time ? toETDate(n.start_time) : n.scheduled_date;
      if (!date) continue;
      if (!map.has(n.tail_number)) map.set(n.tail_number, new Map());
      const dayMap = map.get(n.tail_number)!;
      if (!dayMap.has(date)) dayMap.set(date, []);
      dayMap.get(date)!.push(n);
    }
    return map;
  }, [localMxNotes]);

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

  const unscheduledMxCount = localMxNotes.filter((n) => !n.scheduled_date && n.tail_number && !n.acknowledged_at).length
    + localMxNotes.filter((n) => n.scheduled_date && n.scheduled_date < today && !n.acknowledged_at).length;

  return (
    <div className="flex gap-0">
      {/* Main grid area */}
      <div className="flex-1 min-w-0 space-y-3">
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
          {/* Move mode banner */}
          {movingMxId && (
            <div className="flex items-center gap-2 px-3 py-1 rounded-lg bg-blue-100 border border-blue-300 text-blue-800 text-xs font-medium animate-pulse">
              Click a cell to move MX item
              <button
                onClick={() => setMovingMxId(null)}
                className="text-blue-500 hover:text-blue-700 font-bold"
              >
                Cancel
              </button>
            </div>
          )}
          <div className="flex-1" />
          <div className="text-xs text-gray-500">
            <span className="font-semibold text-gray-700">{tails.length}</span> aircraft
          </div>
          <button
            onClick={() => setShowMxQueue(!showMxQueue)}
            className={`px-2.5 py-1 rounded text-xs font-medium shadow-sm transition-colors ${
              showMxQueue
                ? "bg-red-600 text-white"
                : "bg-white text-gray-600 border border-gray-300 hover:bg-gray-50"
            }`}
          >
            MX Queue
            {unscheduledMxCount > 0 && (
              <span className={`ml-1.5 rounded-full px-1.5 py-0.5 text-[10px] font-bold ${
                showMxQueue ? "bg-red-500 text-white" : "bg-red-100 text-red-700"
              }`}>{unscheduledMxCount}</span>
            )}
          </button>
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

            {/* Tail rows with type group headers */}
            {tails.map((tail, idx) => {
              const thisType = aircraftTypes.get(tail) ?? "Other";
              const prevType = idx > 0 ? (aircraftTypes.get(tails[idx - 1]) ?? "Other") : null;
              const showTypeHeader = thisType !== prevType;
              const dayMap = tailDays.get(tail)!;
              const mxDayMap = mxByTailDate.get(tail);

              // MELs from MX notes (ops_alerts with "MEL" in subject)
              const tailMelNotes = localMxNotes.filter((n) =>
                n.tail_number === tail && !n.acknowledged_at &&
                (n.subject?.toUpperCase().includes("MEL") || n.description?.toUpperCase().includes("MEL"))
              );

              // Unscheduled MX for this tail (no date, not acknowledged, not a MEL)
              const unschedMx = localMxNotes.filter((n) =>
                n.tail_number === tail && !n.scheduled_date && !n.start_time && !n.acknowledged_at &&
                !n.subject?.toUpperCase().includes("MEL")
              );

              return (
                <div key={tail}>
                  {/* Type group header */}
                  {showTypeHeader && (
                    <div
                      className="grid bg-gray-100 border-b border-gray-300"
                      style={{ gridTemplateColumns: `100px repeat(${DAYS_TO_SHOW}, 1fr)` }}
                    >
                      <div className="col-span-full px-3 py-1.5 text-[11px] font-bold text-gray-600 uppercase tracking-wider">
                        {thisType}
                      </div>
                    </div>
                  )}
                  <div
                    className="grid border-b border-gray-100 hover:bg-gray-50/50 transition-colors"
                    style={{ gridTemplateColumns: `100px repeat(${DAYS_TO_SHOW}, 1fr)` }}
                  >
                  {/* Tail label + MELs + unscheduled MX */}
                  <div data-tail-cell className="px-2 py-2 border-r border-gray-200 flex flex-col justify-start gap-1">
                    <button
                      className="text-xs font-bold text-gray-800 font-mono hover:text-blue-600 text-left cursor-pointer"
                      onClick={(e) => {
                        const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                        setTailPopup({ tail, pos: { top: rect.bottom + 4, left: rect.left } });
                      }}
                    >{tail}</button>
                    <span className="text-[8px] text-gray-400 -mt-1">{aircraftTypes.get(tail)?.replace("Cessna ", "").replace("Challenger ", "CL") ?? ""}</span>

                    {/* MEL items from MX notes — click to see details in tail popup */}
                    {tailMelNotes.slice(0, 3).map((n) => {
                      const endTime = n.end_time ? new Date(n.end_time) : null;
                      const daysLeft = endTime ? Math.ceil((endTime.getTime() - Date.now()) / 86400000) : null;
                      return (
                        <button
                          key={n.id}
                          className="text-[9px] leading-tight truncate text-left cursor-pointer hover:underline"
                          title={n.subject ?? n.description ?? ""}
                          onClick={(e) => {
                            const rect = (e.currentTarget.closest("[data-tail-cell]") as HTMLElement)?.getBoundingClientRect();
                            if (rect) setTailPopup({ tail, pos: { top: rect.bottom + 4, left: rect.left } });
                          }}
                        >
                          <span className={`font-bold ${daysLeft !== null && daysLeft <= 3 ? "text-red-600" : daysLeft !== null && daysLeft <= 7 ? "text-orange-600" : "text-green-700"}`}>
                            MEL
                          </span>
                          {daysLeft !== null && (
                            <span className={`ml-0.5 ${daysLeft <= 3 ? "text-red-500" : daysLeft <= 7 ? "text-orange-500" : "text-green-600"}`}>
                              {daysLeft}d
                            </span>
                          )}
                        </button>
                      );
                    })}
                    {tailMelNotes.length > 3 && (
                      <div className="text-[8px] text-gray-400">+{tailMelNotes.length - 3} more</div>
                    )}

                    {/* Unscheduled MX items (clickable to enter move mode) */}
                    {unschedMx.map((n) => (
                      <button
                        key={n.id}
                        onClick={() => {
                          setMovingMxId(n.id);
                          setMxPopoverId(null);
                        }}
                        className="text-left text-[9px] leading-tight rounded px-1 py-0.5 bg-red-50 border border-red-200 text-red-700 hover:bg-red-100 truncate"
                        title={`Click to schedule: ${n.subject ?? n.description ?? "MX"}`}
                      >
                        {n.subject ?? n.description ?? "MX"}
                      </button>
                    ))}
                  </div>

                  {/* Day cells */}
                  {dates.map((d) => {
                    const dayFlights = dayMap.get(d) ?? [];
                    const dayMx = mxDayMap?.get(d) ?? [];
                    const isToday = d === today;
                    const isCreating = createMxCell?.tail === tail && createMxCell?.date === d;

                    // Only allow dropping on the same tail's row
                    const movingNote = movingMxId ? localMxNotes.find((n) => n.id === movingMxId) : null;
                    const isDropTarget = movingNote?.tail_number === tail;

                    return (
                      <div
                        key={d}
                        onClick={() => {
                          if (movingMxId && isDropTarget) { moveMx(movingMxId, tail, d); }
                        }}
                        onDragOver={(e) => {
                          // Only accept drops on same tail
                          if (!draggingMxId) return;
                          const note = localMxNotes.find((n) => n.id === draggingMxId);
                          if (note?.tail_number === tail) {
                            e.preventDefault();
                            e.dataTransfer.dropEffect = "move";
                          }
                        }}
                        onDrop={(e) => {
                          e.preventDefault();
                          const noteId = e.dataTransfer.getData("text/plain");
                          if (noteId) {
                            moveMx(noteId, tail, d);
                            setDraggingMxId(null);
                          }
                        }}
                        className={`group/cell relative px-1 py-1 border-r border-gray-100 last:border-r-0 min-h-[48px] overflow-x-hidden transition-colors space-y-0.5 ${
                          isToday ? "bg-blue-50/30" : ""
                        } ${isDropTarget ? "cursor-pointer hover:bg-blue-50 hover:ring-2 hover:ring-inset hover:ring-blue-300" : ""}`}
                      >
                        {/* Flight blocks */}
                        {dayFlights.map((f) => {
                          const colors = TYPE_COLORS[f.flight_type ?? ""] ?? DEFAULT_COLORS;
                          const dep = fmtIcao(f.departure_icao);
                          const arr = fmtIcao(f.arrival_icao);
                          const depTime = fmtTime(f.scheduled_departure);
                          const arrTime = f.scheduled_arrival ? fmtTime(f.scheduled_arrival) : null;
                          const badge = typeBadge(f.flight_type);
                          const vanId = vanOverrides.get(f.id) ?? null;
                          const showingPicker = vanPickerFlight === f.id;

                          return (
                            <div
                              key={f.id}
                              className={`group relative rounded border px-1.5 py-1 cursor-default overflow-hidden ${colors.bg} ${colors.border} ${colors.text}`}
                              title={[
                                `${dep} -> ${arr}`,
                                `${depTime}${arrTime ? ` - ${arrTime}` : ""}`,
                                f.pic ? `PIC: ${f.pic}` : null,
                                f.sic ? `SIC: ${f.sic}` : null,
                                f.pax_count != null ? `${f.pax_count} pax` : null,
                              ].filter(Boolean).join("\n")}
                            >
                              {/* Top row: route + times + badges */}
                              <div className="flex items-center gap-0.5 text-[10px] leading-tight">
                                <span className="font-bold">{depTime}</span>
                                <span className="font-mono font-semibold">{dep}</span>
                                <span className="text-gray-400">-</span>
                                <span className="font-mono font-semibold">{arr}</span>
                                {arrTime && <span className="font-bold">{arrTime}</span>}

                                {/* Van badge */}
                                {vanId ? (
                                  <button
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      if (showingPicker) { setVanPickerFlight(null); return; }
                                      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                                      setVanPickerPos({ top: rect.bottom + 2, left: rect.left });
                                      setVanPickerArrIcao(f.arrival_icao ?? null);
                                      setVanPickerFlight(f.id);
                                    }}
                                    className="ml-auto px-1 py-0 rounded text-white text-[8px] font-bold leading-tight"
                                    style={{ backgroundColor: VAN_COLORS[(vanId - 1) % VAN_COLORS.length] }}
                                  >
                                    V{vanId}
                                  </button>
                                ) : (
                                  <button
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      if (showingPicker) { setVanPickerFlight(null); return; }
                                      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                                      setVanPickerPos({ top: rect.bottom + 2, left: rect.left });
                                      setVanPickerArrIcao(f.arrival_icao ?? null);
                                      setVanPickerFlight(f.id);
                                    }}
                                    className="ml-auto opacity-30 hover:opacity-100 text-[8px] text-gray-400 relative z-10 px-0.5"
                                  >
                                    +V
                                  </button>
                                )}

                                <span className={`w-3.5 h-3.5 rounded-sm flex items-center justify-center text-white text-[8px] font-bold flex-shrink-0 ${colors.badge}`}>
                                  {badge}
                                </span>
                              </div>

                              {/* Pax count */}
                              {f.pax_count != null && f.pax_count > 0 && (
                                <div className="text-[9px] leading-tight truncate opacity-70">{f.pax_count} pax</div>
                              )}
                              {(f.pic || f.sic) && (
                                <div className="hidden group-hover:block text-[9px] leading-tight text-gray-500 truncate">
                                  {[f.pic, f.sic].filter(Boolean).join(" / ")}
                                </div>
                              )}

                              {/* Van picker rendered at root level via fixed positioning */}
                            </div>
                          );
                        })}

                        {/* MX note blocks */}
                        {dayMx.map((n) => {
                          const showingPopover = mxPopoverId === n.id;
                          const isBeingMoved = movingMxId === n.id;
                          return (
                            <div
                              key={n.id}
                              draggable
                              onDragStart={(e) => {
                                e.dataTransfer.setData("text/plain", n.id);
                                e.dataTransfer.effectAllowed = "move";
                                setDraggingMxId(n.id);
                              }}
                              onDragEnd={() => setDraggingMxId(null)}
                              className={`relative rounded border px-1.5 py-1 cursor-grab active:cursor-grabbing transition-colors overflow-hidden ${
                                isBeingMoved || draggingMxId === n.id
                                  ? "bg-blue-100 border-blue-400 text-blue-900 ring-2 ring-blue-400 opacity-50"
                                  : "bg-red-50 border-red-200 text-red-900 hover:bg-red-100"
                              }`}
                              onClick={(e) => {
                                if (movingMxId && isDropTarget) return;
                                e.stopPropagation();
                                if (showingPopover) { setMxPopoverId(null); return; }
                                const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                                setMxPopoverPos({ top: rect.bottom + 4, left: rect.left });
                                setMxPopoverId(n.id);
                              }}
                            >
                              <div className="flex items-center gap-1 text-[10px] leading-tight">
                                <span className="font-bold">{fmtIcao(n.airport_icao)}</span>
                                {n.start_time && <span className="text-[9px]">{fmtTime(n.start_time)}</span>}
                                {n.end_time && <><span className="text-gray-400">-</span><span className="text-[9px]">{fmtTime(n.end_time)}</span></>}
                                {n.assigned_van && (
                                  <span className="px-1 rounded text-white text-[8px] font-bold"
                                    style={{ backgroundColor: VAN_COLORS[(n.assigned_van - 1) % VAN_COLORS.length] }}>
                                    V{n.assigned_van}
                                  </span>
                                )}
                                <span className="ml-auto w-3.5 h-3.5 rounded-sm flex items-center justify-center text-white text-[8px] font-bold bg-red-500">M</span>
                              </div>
                              <div className="text-[9px] leading-tight truncate opacity-70">
                                {n.subject ?? n.description ?? "Maintenance"}
                              </div>

                              {/* MX popover rendered at root level via fixed positioning */}
                            </div>
                          );
                        })}

                        {/* Create MX button (show on cell hover) */}
                        {!isCreating && (
                          <button
                            onClick={() => setCreateMxCell({ tail, date: d })}
                            className="opacity-0 group-hover/cell:opacity-40 hover:!opacity-100 w-full text-center text-[10px] text-gray-400 hover:text-red-500 py-0.5 rounded hover:bg-red-50 transition-all"
                          >
                            + MX
                          </button>
                        )}

                        {/* Create MX form */}
                        {isCreating && (
                          <CreateMxForm
                            tail={tail}
                            date={d}
                            onSubmit={createMx}
                            onCancel={() => setCreateMxCell(null)}
                          />
                        )}
                      </div>
                    );
                  })}
                </div>
                </div>
              );
            })}

            {tails.length === 0 && (
              <div className="px-6 py-12 text-center text-gray-400 text-sm">
                No flights in this date range
              </div>
            )}
          </div>
        </div>
      </div>

      {/* MX Queue Sidebar */}
      {showMxQueue && (
        <MxQueueSidebar
          mxNotes={localMxNotes}
          melItems={melItems}
          onClose={() => setShowMxQueue(false)}
          onSchedule={() => {}}
        />
      )}

      {/* Global Van Picker (fixed position, escapes overflow) */}
      {vanPickerFlight && vanPickerPos && (
        <VanPicker
          currentVanId={vanOverrides.get(vanPickerFlight) ?? null}
          arrivalIcao={vanPickerArrIcao}
          pos={vanPickerPos}
          onPick={(v) => {
            // Find the date for this flight
            const flight = flights.find((f) => f.id === vanPickerFlight);
            const date = flight ? toETDate(flight.scheduled_departure) : dates[0];
            assignVan(vanPickerFlight!, v, date);
          }}
          onClose={() => setVanPickerFlight(null)}
        />
      )}

      {/* Global MX Popover (fixed position, escapes overflow) */}
      {mxPopoverId && mxPopoverPos && (() => {
        const note = localMxNotes.find((n) => n.id === mxPopoverId);
        if (!note) return null;
        return (
          <MxPopover
            note={note}
            pos={mxPopoverPos}
            onAssignVan={(v) => assignMxVan(note.id, v)}
            onAcknowledge={() => acknowledgeMx(note.id)}
            onMove={() => { setMovingMxId(note.id); setMxPopoverId(null); }}
            onClose={() => setMxPopoverId(null)}
          />
        );
      })()}

      {/* Global Tail Detail Popup */}
      {tailPopup && (
        <>
        <div className="fixed inset-0 bg-black/20 z-[9998]" onClick={() => setTailPopup(null)} />
        <TailDetailPopup
          tail={tailPopup.tail}
          mxNotes={localMxNotes}
          aircraftType={aircraftTypes.get(tailPopup.tail) ?? ""}
          pos={tailPopup.pos}
          onClose={() => setTailPopup(null)}
          onEditMx={(noteId, editPos) => {
            setTailPopup(null);
            setMxPopoverPos(editPos);
            setMxPopoverId(noteId);
          }}
          onCreateMx={createMx}
          onAcknowledgeMx={acknowledgeMx}
        />
        </>
      )}
    </div>
  );
}
