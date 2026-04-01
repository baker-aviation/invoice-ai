"use client";

import { useState, useCallback, useMemo, useRef, useEffect } from "react";
import type { Flight, MxNote, MelItem } from "@/lib/opsApi";
import { BAKER_FLEET, FIXED_VAN_ZONES, haversineKm } from "@/lib/maintenanceData";
import { getAirportInfo } from "@/lib/airportCoords";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Attachment = {
  id: number;
  filename: string;
  content_type: string;
  url: string;
};

type MxNoteWithAttachments = MxNote & { attachments?: Attachment[] };

type MelItemLocal = MelItem;

const CATEGORY_COLORS: Record<string, { bg: string; text: string; border: string }> = {
  A: { bg: "bg-red-100", text: "text-red-800", border: "border-red-300" },
  B: { bg: "bg-orange-100", text: "text-orange-800", border: "border-orange-300" },
  C: { bg: "bg-yellow-100", text: "text-yellow-800", border: "border-yellow-300" },
  D: { bg: "bg-blue-100", text: "text-blue-800", border: "border-blue-300" },
};

const CATEGORY_DAYS: Record<string, number> = { A: 0, B: 3, C: 10, D: 120 };

function daysUntil(dateStr: string | null): number | null {
  if (!dateStr) return null;
  const d = new Date(dateStr + "T23:59:59");
  return Math.ceil((d.getTime() - Date.now()) / 86400000);
}

function fmtDate(iso: string | null | undefined) {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  } catch {
    return "";
  }
}

function fmtTime(iso: string | null | undefined) {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: "America/New_York" });
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// MxBoard — aircraft-centric maintenance management
// ---------------------------------------------------------------------------

export default function MxBoard({
  flights,
  mxNotes: initialNotes = [],
  melItems: initialMels = [],
}: {
  flights: Flight[];
  mxNotes?: MxNote[];
  melItems?: MelItem[];
}) {
  const [notes, setNotes] = useState<MxNoteWithAttachments[]>(initialNotes);
  const [mels, setMels] = useState<MelItemLocal[]>(initialMels);
  const [expandedTail, setExpandedTail] = useState<string | null>(null);
  const [expandedSection, setExpandedSection] = useState<Record<string, string>>({});
  const [filterText, setFilterText] = useState("");
  const [showCreateNote, setShowCreateNote] = useState<string | null>(null); // tail
  const [showCreateMel, setShowCreateMel] = useState<string | null>(null); // tail
  const [loading, setLoading] = useState(false);
  const [toast, setToast] = useState<{ message: string; type: "error" | "success" } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  function showToast(message: string, type: "error" | "success" = "error") {
    setToast({ message, type });
    setTimeout(() => setToast(null), 4000);
  }

  // Build per-tail data
  const allTails = useMemo(() => {
    const tails = new Set<string>(BAKER_FLEET);
    for (const f of flights) if (f.tail_number) tails.add(f.tail_number);
    for (const n of notes) if (n.tail_number) tails.add(n.tail_number);
    for (const m of mels) tails.add(m.tail_number);
    return Array.from(tails).sort();
  }, [flights, notes, mels]);

  const flightsByTail = useMemo(() => {
    const map = new Map<string, Flight[]>();
    const now = new Date();
    const cutoff = new Date(now.getTime() - 6 * 3600000); // show flights from 6h ago
    for (const f of flights) {
      if (!f.tail_number) continue;
      const dep = f.scheduled_departure ? new Date(f.scheduled_departure) : null;
      if (dep && dep < cutoff) continue;
      if (!map.has(f.tail_number)) map.set(f.tail_number, []);
      map.get(f.tail_number)!.push(f);
    }
    // Sort each tail's flights by departure time
    for (const [, arr] of map) {
      arr.sort((a, b) => {
        const da = a.scheduled_departure || "";
        const db = b.scheduled_departure || "";
        return da.localeCompare(db);
      });
    }
    return map;
  }, [flights]);

  const notesByTail = useMemo(() => {
    const map = new Map<string, MxNoteWithAttachments[]>();
    for (const n of notes) {
      const key = n.tail_number ?? "Unassigned";
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(n);
    }
    return map;
  }, [notes]);

  const melsByTail = useMemo(() => {
    const map = new Map<string, MelItemLocal[]>();
    for (const m of mels) {
      if (!map.has(m.tail_number)) map.set(m.tail_number, []);
      map.get(m.tail_number)!.push(m);
    }
    return map;
  }, [mels]);

  // Filter tails
  const filteredTails = useMemo(() => {
    if (!filterText.trim()) return allTails;
    const q = filterText.trim().toUpperCase();
    return allTails.filter((t) => t.includes(q));
  }, [allTails, filterText]);

  // Get last known position for a tail (from most recent flight)
  function getPosition(tail: string): string {
    const tailFlights = flightsByTail.get(tail);
    if (!tailFlights || tailFlights.length === 0) {
      // Check MX notes for airport
      const tailNotes = notesByTail.get(tail);
      if (tailNotes?.[0]?.airport_icao) return tailNotes[0].airport_icao;
      return "—";
    }
    // Find last completed flight's arrival or next departure
    const now = Date.now();
    for (let i = tailFlights.length - 1; i >= 0; i--) {
      const f = tailFlights[i];
      const arr = f.scheduled_arrival ? new Date(f.scheduled_arrival).getTime() : 0;
      if (arr && arr < now && f.arrival_icao) return f.arrival_icao;
    }
    return tailFlights[0]?.departure_icao || "—";
  }

  // Compute urgency for each tail
  function getTailUrgency(tail: string): { level: "red" | "yellow" | "green"; label: string } {
    const tailMels = melsByTail.get(tail) ?? [];
    const tailNotes = notesByTail.get(tail) ?? [];

    // Check MELs for expiring soon
    for (const m of tailMels) {
      const days = daysUntil(m.expiration_date);
      if (days !== null && days <= 0) return { level: "red", label: "MEL EXPIRED" };
      if (m.category === "A") return { level: "red", label: "CAT A MEL" };
      if (days !== null && days <= 1) return { level: "red", label: `MEL expires today` };
      if (days !== null && days <= 3) return { level: "yellow", label: `MEL ${days}d left` };
    }

    if (tailMels.length > 0 || tailNotes.length > 0) {
      return { level: "yellow", label: `${tailMels.length} MEL${tailMels.length !== 1 ? "s" : ""}, ${tailNotes.length} note${tailNotes.length !== 1 ? "s" : ""}` };
    }

    return { level: "green", label: "No items" };
  }

  // Toggle section within expanded tail
  function toggleSection(tail: string, section: string) {
    setExpandedSection((prev) => ({
      ...prev,
      [tail]: prev[tail] === section ? "" : section,
    }));
  }

  // ── Note CRUD ──
  async function refreshNotes() {
    try {
      const res = await fetch("/api/ops/mx-notes");
      if (res.ok) {
        const data = await res.json();
        setNotes(data.notes ?? []);
      }
    } catch { /* ignore */ }
  }

  async function createNote(e: React.FormEvent<HTMLFormElement>, tail: string) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const subject = (fd.get("subject") as string)?.trim();
    if (!subject) return;
    setLoading(true);
    try {
      const res = await fetch("/api/ops/mx-notes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          subject,
          body: (fd.get("body") as string)?.trim() || undefined,
          tail_number: tail,
          airport_icao: (fd.get("airport") as string)?.trim().toUpperCase() || undefined,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Save failed" }));
        alert(err.error || "Failed to create MX note");
        setLoading(false);
        return;
      }
      setShowCreateNote(null);
      await refreshNotes();
    } catch { /* ignore */ }
    setLoading(false);
  }

  async function acknowledgeNote(noteId: string) {
    const prev = notes;
    setNotes((p) => p.filter((n) => n.id !== noteId));
    try {
      const res = await fetch(`/api/ops/mx-notes/${noteId}`, { method: "DELETE" });
      if (!res.ok) {
        setNotes(prev);
        showToast("Failed to dismiss note");
      }
    } catch {
      setNotes(prev);
      showToast("Failed to dismiss note");
    }
  }

  async function assignNote(noteId: string, vanId: number | null, scheduledDate: string | null) {
    const prev = notes;
    // Optimistic update
    setNotes((p) =>
      p.map((n) =>
        n.id === noteId ? { ...n, assigned_van: vanId, scheduled_date: scheduledDate } : n,
      ),
    );
    try {
      const res = await fetch(`/api/ops/mx-notes/${noteId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assigned_van: vanId, scheduled_date: scheduledDate }),
      });
      if (!res.ok) {
        setNotes(prev);
        showToast("Failed to save assignment");
      }
    } catch {
      setNotes(prev);
      showToast("Failed to save assignment");
    }
  }

  async function loadAttachments(noteId: string) {
    try {
      const res = await fetch(`/api/ops/mx-notes/${noteId}/attachments`);
      if (res.ok) {
        const data = await res.json();
        setNotes((prev) =>
          prev.map((n) => (n.id === noteId ? { ...n, attachments: data.attachments ?? [] } : n)),
        );
      }
    } catch { /* ignore */ }
  }

  async function uploadAttachment(noteId: string, file: File) {
    try {
      const presignRes = await fetch(`/api/ops/mx-notes/${noteId}/attachments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename: file.name }),
      });
      if (!presignRes.ok) { showToast("Failed to upload file"); return; }
      const { attachment, upload_url } = await presignRes.json();
      const uploadRes = await fetch(upload_url, {
        method: "PUT",
        headers: { "Content-Type": attachment.content_type },
        body: file,
      });
      if (!uploadRes.ok) { showToast("File upload failed"); return; }
      await loadAttachments(noteId);
    } catch { showToast("Failed to upload file"); }
  }

  async function deleteAttachment(noteId: string, attachmentId: number) {
    const prev = notes;
    setNotes((p) =>
      p.map((n) =>
        n.id === noteId
          ? { ...n, attachments: (n.attachments ?? []).filter((a) => a.id !== attachmentId) }
          : n,
      ),
    );
    try {
      const res = await fetch(`/api/ops/mx-notes/${noteId}/attachments?attachment_id=${attachmentId}`, { method: "DELETE" });
      if (!res.ok) {
        setNotes(prev);
        showToast("Failed to delete attachment");
      }
    } catch {
      setNotes(prev);
      showToast("Failed to delete attachment");
    }
  }

  // ── MEL CRUD ──
  async function refreshMels() {
    try {
      const res = await fetch("/api/ops/mel-items");
      if (res.ok) {
        const data = await res.json();
        setMels(data.items ?? []);
      }
    } catch { /* ignore */ }
  }

  async function createMel(e: React.FormEvent<HTMLFormElement>, tail: string) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const description = (fd.get("description") as string)?.trim();
    const category = (fd.get("category") as string)?.trim();
    if (!description || !category) return;
    setLoading(true);
    try {
      await fetch("/api/ops/mel-items", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tail_number: tail,
          category,
          mel_reference: (fd.get("mel_reference") as string)?.trim() || undefined,
          description,
        }),
      });
      setShowCreateMel(null);
      await refreshMels();
    } catch { /* ignore */ }
    setLoading(false);
  }

  async function clearMel(melId: number) {
    const prev = mels;
    setMels((p) => p.filter((m) => m.id !== melId));
    try {
      const res = await fetch(`/api/ops/mel-items/${melId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "cleared" }),
      });
      if (!res.ok) {
        setMels(prev);
        showToast("Failed to clear MEL");
      }
    } catch {
      setMels(prev);
      showToast("Failed to clear MEL");
    }
  }

  // ── Summary stats ──
  const totalMels = mels.length;
  const expiringMels = mels.filter((m) => {
    const d = daysUntil(m.expiration_date);
    return d !== null && d <= 3;
  }).length;
  const totalNotes = notes.length;
  const unassignedNotes = notes.filter((n) => !n.assigned_van).length;
  const tailsWithItems = new Set([...notes.map((n) => n.tail_number).filter(Boolean), ...mels.map((m) => m.tail_number)]).size;

  return (
    <div className="space-y-4">
      {/* ── Error/success toast ── */}
      {toast && (
        <div className={`fixed top-4 right-4 z-50 px-4 py-2.5 rounded-lg shadow-lg text-sm font-medium transition-all ${toast.type === "error" ? "bg-red-600 text-white" : "bg-green-600 text-white"}`}>
          {toast.message}
        </div>
      )}
      {/* ── Header stats ── */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-gray-50 border border-gray-200">
          <span className="text-sm font-semibold text-gray-800">MX Board</span>
          <span className="text-xs text-gray-500">{tailsWithItems} aircraft with items</span>
        </div>
        {totalMels > 0 && (
          <div className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium ${expiringMels > 0 ? "bg-red-100 text-red-700" : "bg-orange-100 text-orange-700"}`}>
            {totalMels} open MEL{totalMels !== 1 ? "s" : ""}
            {expiringMels > 0 && <span className="font-bold">({expiringMels} expiring)</span>}
          </div>
        )}
        {totalNotes > 0 && (
          <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-blue-100 text-blue-700">
            {totalNotes} MX note{totalNotes !== 1 ? "s" : ""}
          </div>
        )}
        {unassignedNotes > 0 && (
          <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-gray-200 text-gray-700">
            {unassignedNotes} unassigned
          </div>
        )}
        <div className="ml-auto">
          <input
            value={filterText}
            onChange={(e) => setFilterText(e.target.value)}
            placeholder="Filter by tail..."
            className="text-sm border border-gray-200 rounded-lg px-3 py-1.5 w-40 focus:outline-none focus:ring-1 focus:ring-blue-400"
          />
        </div>
      </div>

      {/* ── Aircraft cards ── */}
      <div className="space-y-2">
        {filteredTails.map((tail) => {
          const tailNotes = notesByTail.get(tail) ?? [];
          const tailMels = melsByTail.get(tail) ?? [];
          const tailFlights = flightsByTail.get(tail) ?? [];
          const position = getPosition(tail);
          const urgency = getTailUrgency(tail);
          const isExpanded = expandedTail === tail;
          const hasItems = tailNotes.length > 0 || tailMels.length > 0;

          // Skip tails with no items unless expanded or searched
          if (!hasItems && !filterText.trim() && !isExpanded) return null;

          const urgencyBorder = urgency.level === "red" ? "border-red-300" : urgency.level === "yellow" ? "border-amber-200" : "border-gray-200";
          const urgencyDot = urgency.level === "red" ? "bg-red-500" : urgency.level === "yellow" ? "bg-amber-400" : "bg-green-400";

          return (
            <div key={tail} className={`border rounded-xl bg-white overflow-hidden ${urgencyBorder}`}>
              {/* Card header */}
              <button
                onClick={() => {
                  setExpandedTail(isExpanded ? null : tail);
                  // Auto-load attachments for notes
                  if (!isExpanded) {
                    for (const n of tailNotes) {
                      if (!n.attachments) loadAttachments(n.id);
                    }
                  }
                }}
                className="w-full text-left px-4 py-3 hover:bg-gray-50 transition-colors"
              >
                <div className="flex items-center gap-3">
                  <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${urgencyDot}`} />
                  <span className="text-sm font-bold text-gray-900 w-20">{tail}</span>
                  <span className="text-xs text-gray-500 w-12">{position}</span>
                  <div className="flex items-center gap-2 flex-1 min-w-0">
                    {tailMels.length > 0 && (
                      <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${expiringMelsForTail(tailMels) > 0 ? "bg-red-100 text-red-700" : "bg-orange-100 text-orange-700"}`}>
                        {tailMels.length} MEL{tailMels.length !== 1 ? "s" : ""}
                      </span>
                    )}
                    {tailNotes.length > 0 && (
                      <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-700">
                        {tailNotes.length} note{tailNotes.length !== 1 ? "s" : ""}
                      </span>
                    )}
                    {tailFlights.length > 0 && (
                      <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-600">
                        {tailFlights.length} leg{tailFlights.length !== 1 ? "s" : ""}
                      </span>
                    )}
                    {!hasItems && <span className="text-xs text-gray-400">No items</span>}
                  </div>
                  <span className="text-xs text-gray-400">{urgency.label}</span>
                  <span className="text-gray-300 text-sm">{isExpanded ? "▲" : "▼"}</span>
                </div>
              </button>

              {/* Expanded content */}
              {isExpanded && (
                <div className="border-t border-gray-100">
                  {/* Section tabs */}
                  <div className="flex gap-0 bg-gray-50 border-b border-gray-100">
                    {(["schedule", "notes", "mels"] as const).map((sec) => {
                      const active = (expandedSection[tail] || "notes") === sec;
                      const labels = { schedule: `Schedule (${tailFlights.length})`, notes: `MX Notes (${tailNotes.length})`, mels: `MELs (${tailMels.length})` };
                      return (
                        <button
                          key={sec}
                          onClick={() => toggleSection(tail, sec)}
                          className={`px-4 py-2 text-xs font-medium border-b-2 transition-colors ${
                            active ? "border-blue-600 text-blue-600 bg-white" : "border-transparent text-gray-500 hover:text-gray-700"
                          }`}
                        >
                          {labels[sec]}
                        </button>
                      );
                    })}
                  </div>

                  <div className="p-4">
                    {/* ── Schedule section ── */}
                    {(expandedSection[tail] || "notes") === "schedule" && (
                      <ScheduleSection
                        flights={tailFlights}
                        mxNotes={tailNotes}
                        onMoveNote={(noteId, newAirport) => {
                          setNotes((prev) => prev.map((n) => n.id === noteId ? { ...n, airport_icao: newAirport } : n));
                        }}
                        onAssignVan={assignNote}
                      />
                    )}

                    {/* ── MX Notes section ── */}
                    {(expandedSection[tail] || "notes") === "notes" && (
                      <NotesSection
                        tail={tail}
                        notes={tailNotes}
                        showCreate={showCreateNote === tail}
                        onToggleCreate={() => setShowCreateNote(showCreateNote === tail ? null : tail)}
                        onCreate={(e) => createNote(e, tail)}
                        onAcknowledge={acknowledgeNote}
                        onAssign={assignNote}
                        onUpload={uploadAttachment}
                        onDeleteAttachment={deleteAttachment}
                        fileInputRef={fileInputRef}
                        loading={loading}
                        onRefreshNotes={refreshNotes}
                        onError={showToast}
                      />
                    )}

                    {/* ── MELs section ── */}
                    {(expandedSection[tail] || "notes") === "mels" && (
                      <MelsSection
                        tail={tail}
                        mels={tailMels}
                        showCreate={showCreateMel === tail}
                        onToggleCreate={() => setShowCreateMel(showCreateMel === tail ? null : tail)}
                        onCreate={(e) => createMel(e, tail)}
                        onClear={clearMel}
                        loading={loading}
                      />
                    )}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Hidden file input for note attachments */}
      <input
        ref={fileInputRef}
        type="file"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          const noteId = fileInputRef.current?.getAttribute("data-note-id");
          if (file && noteId) uploadAttachment(noteId, file);
          e.target.value = "";
        }}
      />
    </div>
  );
}

function expiringMelsForTail(mels: MelItem[]): number {
  return mels.filter((m) => {
    const d = daysUntil(m.expiration_date);
    return d !== null && d <= 3;
  }).length;
}

// ---------------------------------------------------------------------------
// Schedule Section — timeline view with MX markers at arrival airports
// ---------------------------------------------------------------------------

function nearestVan(icao: string): { vanId: number; name: string; distKm: number } | null {
  const info = getAirportInfo(icao.replace(/^K/, "")) ?? getAirportInfo(icao);
  if (!info) return null;
  let best: { vanId: number; name: string; distKm: number } | null = null;
  for (const z of FIXED_VAN_ZONES) {
    const d = haversineKm(info.lat, info.lon, z.lat, z.lon);
    if (!best || d < best.distKm) best = { vanId: z.vanId, name: z.name, distKm: d };
  }
  return best;
}

function airportCity(icao: string): string {
  const info = getAirportInfo(icao.replace(/^K/, "")) ?? getAirportInfo(icao);
  if (!info) return "";
  return info.city ? `${info.city}${info.state ? `, ${info.state}` : ""}` : "";
}

function fmtDateShort(iso: string) {
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "America/New_York" });
}

function etDateKey(iso: string) {
  return new Date(iso).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

function groundMinutes(arrIso: string | null, depIso: string): number | null {
  if (!arrIso) return null;
  const diff = (new Date(depIso).getTime() - new Date(arrIso).getTime()) / 60000;
  return diff > 0 ? Math.round(diff) : null;
}

function fmtGroundTime(min: number): string {
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m > 0 ? `${h}h${m}m` : `${h}h`;
}

function ScheduleSection({ flights, mxNotes: initialMxNotes = [], onMoveNote, onAssignVan }: { flights: Flight[]; mxNotes?: MxNoteWithAttachments[]; onMoveNote?: (noteId: string, newAirport: string) => void; onAssignVan?: (noteId: string, vanId: number | null, scheduledDate: string | null) => void }) {
  const [mxNotes, setMxNotes] = useState(initialMxNotes);
  const [dragOverFlightId, setDragOverFlightId] = useState<string | null>(null);
  const dragNoteRef = useRef<string | null>(null);

  async function handleMoveNote(noteId: string, newAirport: string, arrivalDate?: string | null) {
    // Find nearest van for the new airport
    const van = nearestVan(newAirport);
    const newVanId = van ? van.vanId : null;
    // Derive scheduled_date from the flight's arrival (YYYY-MM-DD in ET)
    const scheduledDate = arrivalDate ? etDateKey(arrivalDate) : null;
    const prev = mxNotes;
    // Optimistic update
    setMxNotes((p) => p.map((n) => n.id === noteId ? { ...n, airport_icao: newAirport, assigned_van: newVanId, scheduled_date: scheduledDate } : n));
    try {
      const res = await fetch(`/api/ops/mx-notes/${noteId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ airport_icao: newAirport, assigned_van: newVanId, scheduled_date: scheduledDate }),
      });
      if (!res.ok) {
        setMxNotes(prev);
      } else {
        onMoveNote?.(noteId, newAirport);
      }
    } catch {
      setMxNotes(prev);
    }
  }

  if (flights.length === 0) {
    return <div className="text-sm text-gray-400 py-4 text-center">No upcoming flights</div>;
  }

  // Build a set of airports that have active MX notes
  const mxAirports = new Map<string, MxNoteWithAttachments[]>();
  for (const n of mxNotes) {
    if (n.airport_icao) {
      if (!mxAirports.has(n.airport_icao)) mxAirports.set(n.airport_icao, []);
      mxAirports.get(n.airport_icao)!.push(n);
    }
  }

  // Group flights by date
  const dateGroups: { date: string; label: string; flights: Flight[] }[] = [];
  let currentDate = "";
  for (const f of flights) {
    const dk = etDateKey(f.scheduled_departure);
    if (dk !== currentDate) {
      currentDate = dk;
      dateGroups.push({ date: dk, label: fmtDateShort(f.scheduled_departure), flights: [] });
    }
    dateGroups[dateGroups.length - 1].flights.push(f);
  }

  const now = Date.now();
  const todayKey = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });

  // Non-past arrival airports (only future/current flights count for matching)
  const nonPastArrivalAirports = new Set<string>();
  for (const f of flights) {
    const arr = f.scheduled_arrival ? new Date(f.scheduled_arrival) : null;
    const flightIsPast = arr ? arr.getTime() < now : false;
    if (!flightIsPast && f.arrival_icao) nonPastArrivalAirports.add(f.arrival_icao);
  }

  // Assign each MX note to only the FIRST non-past flight arriving at its airport
  const flightMxMap = new Map<string, MxNoteWithAttachments[]>();
  const claimedNoteIds = new Set<string>();
  for (const f of flights) {
    const arr = f.scheduled_arrival ? new Date(f.scheduled_arrival) : null;
    const flightIsPast = arr ? arr.getTime() < now : false;
    if (flightIsPast || !f.arrival_icao) continue;
    const notes = mxAirports.get(f.arrival_icao) ?? [];
    const unclaimed = notes.filter((n) => !claimedNoteIds.has(n.id));
    if (unclaimed.length > 0) {
      flightMxMap.set(f.id, unclaimed);
      for (const n of unclaimed) claimedNoteIds.add(n.id);
    }
  }

  // Orphan detection: notes with an airport that no longer matches any non-past arrival
  // AND not already claimed by a flight in flightMxMap
  const orphanedNotes = mxNotes.filter(
    (n) => n.airport_icao && !nonPastArrivalAirports.has(n.airport_icao) && !claimedNoteIds.has(n.id),
  );

  // Unassigned notes: no airport_icao set at all (and not claimed)
  const unassignedNotes = mxNotes.filter(
    (n) => !n.airport_icao && !claimedNoteIds.has(n.id),
  );

  // Overdue detection: scheduled_date is in the past
  const isOverdue = (n: MxNoteWithAttachments): boolean => {
    if (!n.scheduled_date) return false;
    return n.scheduled_date < todayKey;
  };

  return (
    <div className="space-y-4">
      {/* Orphaned MX notes — airport no longer on any upcoming arrival */}
      {orphanedNotes.length > 0 && (
        <div className="bg-red-50 border border-red-300 rounded-lg p-3 space-y-1.5">
          <div className="flex items-center gap-2">
            <span className="text-sm">⚠️</span>
            <span className="text-xs font-semibold text-red-700 uppercase tracking-wide">
              MX Items Need Reassignment
            </span>
          </div>
          {orphanedNotes.map((n) => {
            const overdue = isOverdue(n);
            return (
              <div
                key={n.id}
                draggable
                onDragStart={(e) => {
                  dragNoteRef.current = n.id;
                  e.dataTransfer.setData("text/plain", n.id);
                  e.dataTransfer.effectAllowed = "move";
                }}
                onDragEnd={() => { dragNoteRef.current = null; setDragOverFlightId(null); }}
                className="flex items-center gap-2 text-xs cursor-grab active:cursor-grabbing"
              >
                <span className="font-bold text-red-600">MX</span>
                <span className="text-gray-700 truncate flex-1">
                  {n.subject || n.body || n.description}
                </span>
                <span className="text-red-500 text-[11px] shrink-0">
                  assigned to {(n.airport_icao || "").replace(/^K/, "")} but aircraft no longer arriving there
                </span>
                {overdue && (
                  <span className="px-1.5 py-0.5 rounded bg-red-100 text-red-700 text-[10px] font-medium shrink-0">
                    ⏰ Overdue — was scheduled for {fmtDate(n.scheduled_date)}
                  </span>
                )}
                <span className="text-[10px] text-red-400 shrink-0 select-none">⠿ drag to a leg</span>
              </div>
            );
          })}
        </div>
      )}

      {/* Unassigned MX notes — no airport set */}
      {unassignedNotes.length > 0 && (
        <div className="bg-orange-50 border border-orange-200 rounded-lg p-3 space-y-1.5">
          <div className="text-xs font-semibold text-orange-700 uppercase tracking-wide">MX not on route — assign to a leg</div>
          {unassignedNotes.map((n) => {
            const overdue = isOverdue(n);
            return (
              <div
                key={n.id}
                draggable
                onDragStart={(e) => {
                  dragNoteRef.current = n.id;
                  e.dataTransfer.setData("text/plain", n.id);
                  e.dataTransfer.effectAllowed = "move";
                }}
                onDragEnd={() => { dragNoteRef.current = null; setDragOverFlightId(null); }}
                className="flex items-center gap-2 text-xs cursor-grab active:cursor-grabbing"
              >
                <span className="font-bold text-orange-600">MX</span>
                <span className="text-gray-700 truncate flex-1">{n.subject || n.body || n.description}</span>
                {overdue && (
                  <span className="px-1.5 py-0.5 rounded bg-red-100 text-red-700 text-[10px] font-medium shrink-0">
                    ⏰ Overdue — was scheduled for {fmtDate(n.scheduled_date)}
                  </span>
                )}
                <span className="text-[10px] text-orange-400 shrink-0 select-none">⠿ drag to a leg</span>
              </div>
            );
          })}
        </div>
      )}

      {dateGroups.map((group) => {
        const isToday = group.date === todayKey;
        const isPast = group.date < todayKey;
        return (
          <div key={group.date}>
            {/* Date header */}
            <div className={`text-xs font-semibold uppercase tracking-wide mb-1.5 ${isToday ? "text-blue-600" : isPast ? "text-gray-400" : "text-gray-500"}`}>
              {group.label}{isToday ? " (Today)" : ""}
            </div>

            {/* Legs with timeline */}
            <div className="relative ml-3 border-l-2 border-gray-200 space-y-0">
              {group.flights.map((f, i) => {
                const arr = f.scheduled_arrival ? new Date(f.scheduled_arrival) : null;
                const flightIsPast = arr ? arr.getTime() < now : false;
                const isActive = !flightIsPast && f.scheduled_departure && new Date(f.scheduled_departure).getTime() <= now;
                const isMxFlight = f.flight_type === "Maintenance";
                const arrMxNotes = flightMxMap.get(f.id) ?? [];
                const hasMxAtArrival = arrMxNotes.length > 0;
                const isDropTarget = dragOverFlightId === f.id;

                // Ground time gap between this leg and next
                const nextFlight = group.flights[i + 1];
                const gapMin = nextFlight ? groundMinutes(f.scheduled_arrival, nextFlight.scheduled_departure) : null;
                const isLongGap = gapMin !== null && gapMin >= 120;

                return (
                  <div key={f.id}>
                    {/* Flight leg — drop target for dragged MX notes */}
                    <div
                      className={`relative pl-5 py-1.5 transition-colors ${flightIsPast ? "opacity-50" : ""} ${isDropTarget ? "bg-orange-50 rounded" : ""}`}
                      onDragOver={(e) => {
                        if (!f.arrival_icao || flightIsPast) return;
                        e.preventDefault();
                        setDragOverFlightId(f.id);
                      }}
                      onDragLeave={() => { if (dragOverFlightId === f.id) setDragOverFlightId(null); }}
                      onDrop={(e) => {
                        e.preventDefault();
                        setDragOverFlightId(null);
                        const noteId = dragNoteRef.current ?? e.dataTransfer.getData("text/plain");
                        dragNoteRef.current = null;
                        if (noteId && f.arrival_icao) handleMoveNote(noteId, f.arrival_icao, f.scheduled_arrival);
                      }}
                    >
                      {/* Timeline dot */}
                      <div className={`absolute -left-[5px] top-3 w-2 h-2 rounded-full border-2 ${
                        isActive ? "bg-blue-500 border-blue-500 ring-2 ring-blue-200" :
                        isMxFlight ? "bg-purple-500 border-purple-500" :
                        flightIsPast ? "bg-gray-300 border-gray-300" :
                        "bg-white border-gray-400"
                      }`} />

                      <div className="flex items-center gap-3">
                        {/* Route */}
                        <div className="shrink-0">
                          <span className={`text-sm font-semibold ${flightIsPast ? "text-gray-400" : "text-gray-800"}`}>
                            {(f.departure_icao || "?").replace(/^K/, "")}
                          </span>
                          <span className="text-gray-400 mx-1">→</span>
                          <span className={`text-sm font-semibold ${flightIsPast ? "text-gray-400" : hasMxAtArrival ? "text-orange-600" : "text-gray-800"}`}>
                            {(f.arrival_icao || "?").replace(/^K/, "")}
                          </span>
                          {f.arrival_icao && (() => {
                            const city = airportCity(f.arrival_icao);
                            const van = nearestVan(f.arrival_icao);
                            return city || van ? (
                              <span className="text-[11px] text-gray-400 ml-1.5">
                                {city}{van ? <span className="text-gray-300">{city ? " · " : ""}V{van.vanId}</span> : ""}
                              </span>
                            ) : null;
                          })()}
                        </div>

                        {/* Times */}
                        <div className={`text-xs w-32 shrink-0 ${flightIsPast ? "text-gray-400" : "text-gray-600"}`}>
                          {fmtTime(f.scheduled_departure)}
                          <span className="text-gray-400"> — </span>
                          {fmtTime(f.scheduled_arrival)}
                        </div>

                        {/* Crew */}
                        <span className="text-xs text-gray-400 flex-1 truncate">
                          {f.pic || ""}{f.sic ? ` / ${f.sic}` : ""}
                        </span>

                        {/* Badges */}
                        <div className="flex items-center gap-1.5 shrink-0">
                          {isActive && (
                            <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-blue-100 text-blue-700 animate-pulse">EN ROUTE</span>
                          )}
                          {isMxFlight && (
                            <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-purple-100 text-purple-700">MX FLIGHT</span>
                          )}
                          {hasMxAtArrival && (
                            <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-orange-100 text-orange-700" title={arrMxNotes.map((n) => n.subject || n.body).join(", ")}>
                              {arrMxNotes.length} MX @ {(f.arrival_icao || "").replace(/^K/, "")}
                            </span>
                          )}
                        </div>
                      </div>

                      {/* MX notes at arrival — inline with move control */}
                      {hasMxAtArrival && !flightIsPast && (
                        <div className="ml-0 mt-1 space-y-0.5">
                          {arrMxNotes.map((n) => (
                            <div
                              key={n.id}
                              draggable
                              onDragStart={(e) => {
                                dragNoteRef.current = n.id;
                                e.dataTransfer.setData("text/plain", n.id);
                                e.dataTransfer.effectAllowed = "move";
                              }}
                              onDragEnd={() => { dragNoteRef.current = null; setDragOverFlightId(null); }}
                              className="group flex items-center gap-2 text-[11px] text-orange-700 bg-orange-50 rounded px-2 py-1 cursor-grab active:cursor-grabbing"
                            >
                              <span className="font-bold shrink-0">MX</span>
                              <span className="truncate flex-1">{n.subject || n.body || n.description}</span>
                              <select
                                value={n.assigned_van ?? ""}
                                onClick={(e) => e.stopPropagation()}
                                onMouseDown={(e) => e.stopPropagation()}
                                onChange={(e) => {
                                  e.stopPropagation();
                                  const val = e.target.value ? Number(e.target.value) : null;
                                  onAssignVan?.(n.id, val, n.scheduled_date ?? null);
                                  setMxNotes((prev) => prev.map((x) => x.id === n.id ? { ...x, assigned_van: val } : x));
                                }}
                                className={`text-[10px] font-medium rounded px-1 py-0.5 border-none cursor-pointer shrink-0 ${n.assigned_van ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-500"}`}
                              >
                                <option value="">No van</option>
                                {FIXED_VAN_ZONES.map((z) => (
                                  <option key={z.vanId} value={z.vanId}>V{z.vanId} {z.name}</option>
                                ))}
                              </select>
                              <span className="text-[10px] text-orange-400 opacity-0 group-hover:opacity-100 transition-opacity shrink-0 select-none">
                                ⠿ drag to move
                              </span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>

                    {/* Ground time gap indicator */}
                    {gapMin !== null && gapMin >= 30 && (
                      <div className="relative pl-5 py-0.5">
                        <div className={`absolute -left-[3px] top-1/2 -translate-y-1/2 w-1.5 h-1.5 rounded-full ${isLongGap ? "bg-amber-300" : "bg-gray-200"}`} />
                        <span className={`text-[10px] ${isLongGap ? "text-amber-600 font-medium" : "text-gray-400"}`}>
                          {fmtGroundTime(gapMin)} ground{isLongGap ? " — service window" : ""}
                        </span>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Notes Section — MX notes with create/edit/attachments
// ---------------------------------------------------------------------------

function NotesSection({
  tail,
  notes,
  showCreate,
  onToggleCreate,
  onCreate,
  onAcknowledge,
  onAssign,
  onUpload,
  onDeleteAttachment,
  fileInputRef,
  loading,
  onRefreshNotes,
  onError,
}: {
  tail: string;
  notes: MxNoteWithAttachments[];
  showCreate: boolean;
  onToggleCreate: () => void;
  onCreate: (e: React.FormEvent<HTMLFormElement>) => void;
  onAcknowledge: (id: string) => void;
  onAssign: (noteId: string, vanId: number | null, scheduledDate: string | null) => void;
  onUpload: (noteId: string, file: File) => void;
  onDeleteAttachment: (noteId: string, attachmentId: number) => void;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  loading: boolean;
  onRefreshNotes: () => Promise<void>;
  onError: (message: string) => void;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editSubject, setEditSubject] = useState("");
  const [editBody, setEditBody] = useState("");
  const [saving, setSaving] = useState(false);

  async function saveEdit(noteId: string) {
    setSaving(true);
    try {
      const res = await fetch(`/api/ops/mx-notes/${noteId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subject: editSubject, body: editBody }),
      });
      if (!res.ok) {
        onError("Failed to save edit");
        setSaving(false);
        return;
      }
      setEditingId(null);
      await onRefreshNotes();
    } catch {
      onError("Failed to save edit");
    }
    setSaving(false);
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-gray-500 uppercase tracking-wide">MX Notes</span>
        <button
          onClick={onToggleCreate}
          className="px-2.5 py-1 text-xs font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-lg transition-colors"
        >
          {showCreate ? "Cancel" : "+ Note"}
        </button>
      </div>

      {showCreate && (
        <form onSubmit={onCreate} className="border border-blue-200 bg-blue-50 rounded-lg p-3 space-y-2">
          <input
            name="subject"
            placeholder="Subject *"
            required
            className="w-full text-sm border border-gray-200 rounded px-2.5 py-1.5 focus:outline-none focus:ring-1 focus:ring-blue-400"
          />
          <div className="flex gap-2">
            <input
              name="airport"
              placeholder="ICAO"
              maxLength={4}
              className="w-20 text-sm border border-gray-200 rounded px-2.5 py-1.5 focus:outline-none focus:ring-1 focus:ring-blue-400"
            />
            <textarea
              name="body"
              placeholder="Details..."
              rows={2}
              className="flex-1 text-sm border border-gray-200 rounded px-2.5 py-1.5 focus:outline-none focus:ring-1 focus:ring-blue-400"
            />
          </div>
          <button
            type="submit"
            disabled={loading}
            className="px-3 py-1 text-xs font-medium text-white bg-blue-600 hover:bg-blue-700 rounded transition-colors disabled:opacity-50"
          >
            {loading ? "Creating..." : "Create"}
          </button>
        </form>
      )}

      {notes.length === 0 && !showCreate ? (
        <div className="text-sm text-gray-400 py-3 text-center">No MX notes for this aircraft</div>
      ) : (
        notes.map((note) => {
          const isEditing = editingId === note.id;
          return (
            <div key={note.id} className="border border-gray-200 rounded-lg bg-white p-3 space-y-2">
              {isEditing ? (
                <div className="space-y-2">
                  <input
                    value={editSubject}
                    onChange={(e) => setEditSubject(e.target.value)}
                    className="w-full text-sm font-semibold border border-gray-200 rounded px-2.5 py-1 focus:outline-none focus:ring-1 focus:ring-blue-400"
                  />
                  <textarea
                    value={editBody}
                    onChange={(e) => setEditBody(e.target.value)}
                    rows={3}
                    className="w-full text-sm border border-gray-200 rounded px-2.5 py-1 focus:outline-none focus:ring-1 focus:ring-blue-400"
                  />
                  <div className="flex gap-2">
                    <button onClick={() => saveEdit(note.id)} disabled={saving} className="px-2.5 py-1 text-xs font-medium text-white bg-blue-600 rounded disabled:opacity-50">{saving ? "Saving..." : "Save"}</button>
                    <button onClick={() => setEditingId(null)} disabled={saving} className="px-2.5 py-1 text-xs text-gray-500">Cancel</button>
                  </div>
                </div>
              ) : (
                <>
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-semibold text-gray-800">
                        {note.subject || note.description || "MX Note"}
                      </div>
                      {(note.body || note.description) && (
                        <div className="text-xs text-gray-500 mt-0.5 line-clamp-2">
                          {note.body || note.description}
                        </div>
                      )}
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      {note.assigned_van ? (
                        <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-green-100 text-green-700">
                          V{note.assigned_van}{note.scheduled_date ? ` · ${fmtDate(note.scheduled_date)}` : ""}
                        </span>
                      ) : (
                        <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-gray-100 text-gray-500">
                          Unassigned
                        </span>
                      )}
                      {note.airport_icao && <span className="text-xs text-gray-400">{note.airport_icao}</span>}
                      <span className="text-xs text-gray-400">{fmtDate(note.start_time ?? note.created_at)}</span>
                    </div>
                  </div>

                  {/* Attachments */}
                  {note.attachments && note.attachments.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {note.attachments.map((att) => (
                        <div key={att.id} className="group flex items-center gap-1 border border-gray-200 rounded px-2 py-1 bg-gray-50">
                          {att.content_type.startsWith("image/") ? (
                            <a href={att.url} target="_blank" rel="noopener noreferrer">
                              {/* eslint-disable-next-line @next/next/no-img-element */}
                              <img src={att.url} alt={att.filename} className="w-8 h-8 object-cover rounded" />
                            </a>
                          ) : (
                            <a href={att.url} target="_blank" rel="noopener noreferrer" className="text-xs text-blue-600 hover:text-blue-800 truncate max-w-[150px]">
                              {att.filename}
                            </a>
                          )}
                          <button
                            onClick={() => onDeleteAttachment(note.id, att.id)}
                            className="text-gray-300 hover:text-red-500 text-xs opacity-0 group-hover:opacity-100"
                            title="Remove"
                          >
                            ✕
                          </button>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Assignment row */}
                  <div className="flex items-center gap-2 pt-1 border-t border-gray-100">
                    <span className="text-[10px] text-gray-400 uppercase tracking-wide shrink-0">Assign:</span>
                    <select
                      value={note.assigned_van ?? ""}
                      onChange={(e) => {
                        const v = e.target.value ? Number(e.target.value) : null;
                        onAssign(note.id, v, note.scheduled_date ?? null);
                      }}
                      className="text-xs border border-gray-200 rounded px-1.5 py-0.5 bg-white text-gray-700 focus:outline-none focus:ring-1 focus:ring-blue-400"
                    >
                      <option value="">No van</option>
                      {FIXED_VAN_ZONES.map((z) => (
                        <option key={z.vanId} value={z.vanId}>V{z.vanId} {z.name}</option>
                      ))}
                    </select>
                    <input
                      type="date"
                      value={note.scheduled_date ?? ""}
                      onChange={(e) => {
                        onAssign(note.id, note.assigned_van ?? null, e.target.value || null);
                      }}
                      className="text-xs border border-gray-200 rounded px-1.5 py-0.5 bg-white text-gray-700 focus:outline-none focus:ring-1 focus:ring-blue-400"
                    />
                    {note.assigned_van && (
                      <span className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-green-100 text-green-700">
                        V{note.assigned_van}{note.scheduled_date ? ` · ${fmtDate(note.scheduled_date)}` : ""}
                      </span>
                    )}
                  </div>

                  {/* Actions */}
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => { setEditingId(note.id); setEditSubject(note.subject ?? ""); setEditBody(note.body ?? note.description ?? ""); }}
                      className="text-xs text-blue-600 hover:text-blue-800 font-medium"
                    >
                      Edit
                    </button>
                    <button
                      onClick={() => {
                        fileInputRef.current?.setAttribute("data-note-id", note.id);
                        fileInputRef.current?.click();
                      }}
                      className="text-xs text-blue-600 hover:text-blue-800 font-medium"
                    >
                      Attach
                    </button>
                    <button
                      onClick={() => onAcknowledge(note.id)}
                      className="text-xs text-red-500 hover:text-red-700 font-medium ml-auto"
                    >
                      Dismiss
                    </button>
                  </div>
                </>
              )}
            </div>
          );
        })
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// MELs Section — MEL items with create/clear
// ---------------------------------------------------------------------------

function MelsSection({
  tail,
  mels,
  showCreate,
  onToggleCreate,
  onCreate,
  onClear,
  loading,
}: {
  tail: string;
  mels: MelItemLocal[];
  showCreate: boolean;
  onToggleCreate: () => void;
  onCreate: (e: React.FormEvent<HTMLFormElement>) => void;
  onClear: (id: number) => void;
  loading: boolean;
}) {
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-gray-500 uppercase tracking-wide">MEL Items</span>
        <button
          onClick={onToggleCreate}
          className="px-2.5 py-1 text-xs font-medium text-white bg-orange-500 hover:bg-orange-600 rounded-lg transition-colors"
        >
          {showCreate ? "Cancel" : "+ MEL"}
        </button>
      </div>

      {showCreate && (
        <form onSubmit={onCreate} className="border border-orange-200 bg-orange-50 rounded-lg p-3 space-y-2">
          <div className="flex gap-2">
            <select name="category" required className="text-sm border border-gray-200 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-orange-400">
              <option value="">Cat *</option>
              <option value="A">A — Before next flight</option>
              <option value="B">B — 3 calendar days</option>
              <option value="C">C — 10 calendar days</option>
              <option value="D">D — 120 calendar days</option>
            </select>
            <input
              name="mel_reference"
              placeholder="MEL ref (e.g. 32-21-01)"
              className="w-40 text-sm border border-gray-200 rounded px-2.5 py-1.5 focus:outline-none focus:ring-1 focus:ring-orange-400"
            />
          </div>
          <textarea
            name="description"
            placeholder="Description *"
            required
            rows={2}
            className="w-full text-sm border border-gray-200 rounded px-2.5 py-1.5 focus:outline-none focus:ring-1 focus:ring-orange-400"
          />
          <button
            type="submit"
            disabled={loading}
            className="px-3 py-1 text-xs font-medium text-white bg-orange-500 hover:bg-orange-600 rounded transition-colors disabled:opacity-50"
          >
            {loading ? "Creating..." : "Create MEL"}
          </button>
        </form>
      )}

      {mels.length === 0 && !showCreate ? (
        <div className="text-sm text-gray-400 py-3 text-center">No MEL items for this aircraft</div>
      ) : (
        mels.map((mel) => {
          const daysLeft = daysUntil(mel.expiration_date);
          const cat = CATEGORY_COLORS[mel.category] ?? CATEGORY_COLORS.D;
          const isUrgent = daysLeft !== null && daysLeft <= 1;
          const isWarning = daysLeft !== null && daysLeft <= 3 && !isUrgent;

          return (
            <div key={mel.id} className={`border rounded-lg p-3 ${isUrgent ? "border-red-300 bg-red-50" : isWarning ? "border-amber-200 bg-amber-50" : "border-gray-200 bg-white"}`}>
              <div className="flex items-start gap-2">
                <span className={`px-1.5 py-0.5 rounded text-xs font-bold ${cat.bg} ${cat.text} ${cat.border} border`}>
                  {mel.category}
                </span>
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-gray-800">{mel.description}</div>
                  <div className="flex items-center gap-2 mt-1">
                    {mel.mel_reference && (
                      <span className="text-xs text-gray-500 font-mono">{mel.mel_reference}</span>
                    )}
                    <span className="text-xs text-gray-400">Deferred {fmtDate(mel.deferred_date)}</span>
                    {mel.expiration_date && (
                      <span className={`text-xs font-medium ${isUrgent ? "text-red-700" : isWarning ? "text-amber-700" : "text-gray-500"}`}>
                        {daysLeft !== null && daysLeft <= 0
                          ? "EXPIRED"
                          : `Expires ${fmtDate(mel.expiration_date)} (${daysLeft}d)`
                        }
                      </span>
                    )}
                    {mel.category === "A" && !mel.expiration_date && (
                      <span className="text-xs font-bold text-red-700">Fix before next flight</span>
                    )}
                  </div>
                </div>
                <button
                  onClick={() => onClear(mel.id)}
                  className="text-xs text-green-600 hover:text-green-800 font-medium shrink-0"
                >
                  Clear
                </button>
              </div>
            </div>
          );
        })
      )}
    </div>
  );
}
