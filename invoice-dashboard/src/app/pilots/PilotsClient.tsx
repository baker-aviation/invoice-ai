"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import type { PilotProfile, TimeOffRequest } from "@/lib/types";

type Tab = "roster" | "onboarding" | "rotations" | "time_off";

type Rotation = {
  id: number;
  crew_member_id: number;
  tail_number: string;
  rotation_start: string;
  rotation_end: string | null;
  crew_members?: { name: string; role: string } | null;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function StatusBadge({ label, color }: { label: string; color: string }) {
  const colorMap: Record<string, string> = {
    green: "bg-green-100 text-green-800",
    yellow: "bg-yellow-100 text-yellow-800",
    red: "bg-red-100 text-red-800",
    blue: "bg-blue-100 text-blue-800",
    gray: "bg-gray-100 text-gray-600",
  };
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${colorMap[color] ?? colorMap.gray}`}>
      {label}
    </span>
  );
}

function ProgressBar({ completed, total }: { completed: number; total: number }) {
  const pct = total === 0 ? 0 : Math.round((completed / total) * 100);
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-2 bg-gray-200 rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all ${pct === 100 ? "bg-green-500" : "bg-blue-500"}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="text-xs text-gray-500 tabular-nums w-16 text-right">
        {completed}/{total}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Add Pilot Modal
// ---------------------------------------------------------------------------

function AddPilotModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSaving(true);
    setError("");

    const fd = new FormData(e.currentTarget);
    const body = {
      full_name: fd.get("full_name"),
      email: fd.get("email") || null,
      phone: fd.get("phone") || null,
      role: fd.get("role"),
      hire_date: fd.get("hire_date") || null,
      employee_id: fd.get("employee_id") || null,
      home_airports: (fd.get("home_airports") as string)?.split(",").map((s) => s.trim()).filter(Boolean) ?? [],
      aircraft_types: (fd.get("aircraft_types") as string)?.split(",").map((s) => s.trim()).filter(Boolean) ?? [],
    };

    const res = await fetch("/api/pilots", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await res.json();
    setSaving(false);
    if (!data.ok) {
      setError(data.error ?? "Failed to create pilot");
      return;
    }
    onCreated();
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl shadow-xl max-w-lg w-full p-6">
        <h2 className="text-lg font-semibold mb-4">Add Pilot</h2>
        {error && <div className="text-sm text-red-600 mb-3">{error}</div>}
        <form onSubmit={handleSubmit} className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Full Name *</label>
              <input name="full_name" required className="w-full border rounded-lg px-3 py-2 text-sm" />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Role *</label>
              <select name="role" required className="w-full border rounded-lg px-3 py-2 text-sm">
                <option value="SIC">SIC</option>
                <option value="PIC">PIC</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Email</label>
              <input name="email" type="email" className="w-full border rounded-lg px-3 py-2 text-sm" />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Phone</label>
              <input name="phone" className="w-full border rounded-lg px-3 py-2 text-sm" />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Hire Date</label>
              <input name="hire_date" type="date" className="w-full border rounded-lg px-3 py-2 text-sm" />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Employee ID</label>
              <input name="employee_id" className="w-full border rounded-lg px-3 py-2 text-sm" />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Home Airports</label>
              <input name="home_airports" placeholder="TEB, BUR" className="w-full border rounded-lg px-3 py-2 text-sm" />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Aircraft Types</label>
              <input name="aircraft_types" placeholder="CL300, CX" className="w-full border rounded-lg px-3 py-2 text-sm" />
            </div>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={onClose} className="px-4 py-2 text-sm text-gray-600 hover:text-gray-800">
              Cancel
            </button>
            <button type="submit" disabled={saving} className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50">
              {saving ? "Creating..." : "Create Pilot"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Add Rotation Modal
// ---------------------------------------------------------------------------

function AddRotationModal({
  pilots,
  onClose,
  onCreated,
}: {
  pilots: PilotProfile[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const available = pilots.filter((p) => p.available_to_fly && p.crew_member_id);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSaving(true);
    setError("");

    const fd = new FormData(e.currentTarget);
    const body = {
      crew_member_id: Number(fd.get("crew_member_id")),
      tail_number: fd.get("tail_number"),
      rotation_start: fd.get("rotation_start"),
      rotation_end: fd.get("rotation_end") || null,
    };

    const res = await fetch("/api/pilots/rotations", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await res.json();
    setSaving(false);
    if (!data.ok) {
      setError(data.error ?? "Failed to create rotation");
      return;
    }
    onCreated();
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl shadow-xl max-w-md w-full p-6">
        <h2 className="text-lg font-semibold mb-4">Add Rotation</h2>
        {error && <div className="text-sm text-red-600 mb-3">{error}</div>}
        <form onSubmit={handleSubmit} className="space-y-3">
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Pilot *</label>
            <select name="crew_member_id" required className="w-full border rounded-lg px-3 py-2 text-sm">
              <option value="">Select pilot...</option>
              {available.map((p) => (
                <option key={p.id} value={p.crew_member_id!}>{p.full_name} ({p.role})</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Aircraft (Tail) *</label>
            <input name="tail_number" required className="w-full border rounded-lg px-3 py-2 text-sm" placeholder="N-XXXXX" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Start Date *</label>
              <input name="rotation_start" type="date" required className="w-full border rounded-lg px-3 py-2 text-sm" />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">End Date</label>
              <input name="rotation_end" type="date" className="w-full border rounded-lg px-3 py-2 text-sm" />
            </div>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={onClose} className="px-4 py-2 text-sm text-gray-600 hover:text-gray-800">Cancel</button>
            <button type="submit" disabled={saving} className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50">
              {saving ? "Creating..." : "Create Rotation"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main Component
// ---------------------------------------------------------------------------

export default function PilotsClient() {
  const [tab, setTab] = useState<Tab>("roster");
  const [pilots, setPilots] = useState<PilotProfile[]>([]);
  const [timeOffRequests, setTimeOffRequests] = useState<TimeOffRequest[]>([]);
  const [rotations, setRotations] = useState<Rotation[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAddPilot, setShowAddPilot] = useState(false);
  const [showAddRotation, setShowAddRotation] = useState(false);

  const fetchPilots = useCallback(async () => {
    const res = await fetch("/api/pilots");
    const data = await res.json();
    if (data.ok) setPilots(data.pilots);
  }, []);

  const fetchTimeOff = useCallback(async () => {
    const res = await fetch("/api/pilots/time-off");
    const data = await res.json();
    if (data.ok) setTimeOffRequests(data.requests);
  }, []);

  const fetchRotations = useCallback(async () => {
    const res = await fetch("/api/pilots/rotations");
    const data = await res.json();
    if (data.ok) setRotations(data.rotations);
  }, []);

  useEffect(() => {
    setLoading(true);
    Promise.all([fetchPilots(), fetchTimeOff(), fetchRotations()]).finally(() => setLoading(false));
  }, [fetchPilots, fetchTimeOff, fetchRotations]);

  async function handleTimeOffAction(id: number, status: "approved" | "denied") {
    await fetch(`/api/pilots/time-off/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    fetchTimeOff();
  }

  async function handleDeleteRotation(id: number) {
    await fetch(`/api/pilots/rotations/${id}`, { method: "DELETE" });
    fetchRotations();
  }

  const TABS: { key: Tab; label: string }[] = [
    { key: "roster", label: "Roster" },
    { key: "onboarding", label: "Onboarding" },
    { key: "rotations", label: "Rotations" },
    { key: "time_off", label: "Time Off" },
  ];

  const pendingCount = timeOffRequests.filter((r) => r.status === "pending").length;

  if (loading) {
    return <div className="p-6 text-gray-400">Loading pilots...</div>;
  }

  return (
    <div className="p-4 sm:p-6">
      {/* Tabs */}
      <div className="flex items-center gap-1 border-b mb-6">
        {TABS.map(({ key, label }) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              tab === key
                ? "border-blue-600 text-blue-600"
                : "border-transparent text-gray-500 hover:text-gray-700"
            }`}
          >
            {label}
            {key === "time_off" && pendingCount > 0 && (
              <span className="ml-1.5 bg-red-500 text-white text-xs rounded-full px-1.5 py-0.5">
                {pendingCount}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Roster Tab */}
      {tab === "roster" && (
        <div>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-semibold text-gray-700">{pilots.length} Pilots</h2>
            <button
              onClick={() => setShowAddPilot(true)}
              className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700"
            >
              + Add Pilot
            </button>
          </div>
          <div className="bg-white rounded-xl border shadow-sm overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  <th className="px-4 py-3">Name</th>
                  <th className="px-4 py-3">Role</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Hire Date</th>
                  <th className="px-4 py-3">Home Airports</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {pilots.map((p) => (
                  <tr key={p.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3">
                      <Link href={`/pilots/${p.id}`} className="text-blue-600 hover:underline font-medium">
                        {p.full_name}
                      </Link>
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge label={p.role} color={p.role === "PIC" ? "blue" : "gray"} />
                    </td>
                    <td className="px-4 py-3">
                      {p.available_to_fly ? (
                        <StatusBadge label="Available" color="green" />
                      ) : p.onboarding_complete ? (
                        <StatusBadge label="Ready" color="yellow" />
                      ) : (
                        <StatusBadge label="Onboarding" color="yellow" />
                      )}
                    </td>
                    <td className="px-4 py-3 text-gray-500">{p.hire_date ?? "—"}</td>
                    <td className="px-4 py-3 text-gray-500">{p.home_airports?.join(", ") || "—"}</td>
                  </tr>
                ))}
                {pilots.length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-4 py-8 text-center text-gray-400">
                      No pilots yet. Click &quot;Add Pilot&quot; to get started.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Onboarding Tab */}
      {tab === "onboarding" && (
        <div>
          <h2 className="text-sm font-semibold text-gray-700 mb-4">Onboarding Progress</h2>
          <div className="space-y-3">
            {pilots.map((p) => {
              const prog = p.onboarding_progress ?? { completed: 0, total: 0 };
              return (
                <div key={p.id} className="bg-white rounded-xl border shadow-sm p-4">
                  <div className="flex items-center justify-between mb-2">
                    <Link href={`/pilots/${p.id}`} className="font-medium text-blue-600 hover:underline">
                      {p.full_name}
                    </Link>
                    <div className="flex items-center gap-2">
                      <StatusBadge label={p.role} color={p.role === "PIC" ? "blue" : "gray"} />
                      {prog.completed === prog.total && prog.total > 0 ? (
                        <StatusBadge label="Complete" color="green" />
                      ) : (
                        <StatusBadge label="In Progress" color="yellow" />
                      )}
                    </div>
                  </div>
                  <ProgressBar completed={prog.completed} total={prog.total} />
                </div>
              );
            })}
            {pilots.length === 0 && (
              <div className="text-center text-gray-400 py-8">No pilots to show.</div>
            )}
          </div>
        </div>
      )}

      {/* Rotations Tab */}
      {tab === "rotations" && (
        <div>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-semibold text-gray-700">{rotations.length} Rotations</h2>
            <button
              onClick={() => setShowAddRotation(true)}
              className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700"
            >
              + Add Rotation
            </button>
          </div>
          <div className="bg-white rounded-xl border shadow-sm overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  <th className="px-4 py-3">Crew Member</th>
                  <th className="px-4 py-3">Role</th>
                  <th className="px-4 py-3">Aircraft</th>
                  <th className="px-4 py-3">Start</th>
                  <th className="px-4 py-3">End</th>
                  <th className="px-4 py-3"></th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {rotations.map((r) => (
                  <tr key={r.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3 font-medium">{r.crew_members?.name ?? `#${r.crew_member_id}`}</td>
                    <td className="px-4 py-3">{r.crew_members?.role ?? "—"}</td>
                    <td className="px-4 py-3">{r.tail_number}</td>
                    <td className="px-4 py-3 text-gray-500">{r.rotation_start}</td>
                    <td className="px-4 py-3 text-gray-500">{r.rotation_end ?? "Ongoing"}</td>
                    <td className="px-4 py-3">
                      <button
                        onClick={() => handleDeleteRotation(r.id)}
                        className="text-xs text-red-500 hover:text-red-700"
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
                {rotations.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-4 py-8 text-center text-gray-400">
                      No rotations found.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Time Off Tab */}
      {tab === "time_off" && (
        <div>
          <h2 className="text-sm font-semibold text-gray-700 mb-4">Time Off Requests</h2>
          <div className="bg-white rounded-xl border shadow-sm overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  <th className="px-4 py-3">Pilot</th>
                  <th className="px-4 py-3">Type</th>
                  <th className="px-4 py-3">Dates</th>
                  <th className="px-4 py-3">Reason</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {timeOffRequests.map((r) => (
                  <tr key={r.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3 font-medium">{r.pilot_name ?? `Pilot #${r.pilot_profile_id}`}</td>
                    <td className="px-4 py-3">
                      <StatusBadge
                        label={r.request_type === "time_off" ? "Time Off" : "Standby"}
                        color={r.request_type === "time_off" ? "blue" : "gray"}
                      />
                    </td>
                    <td className="px-4 py-3 text-gray-500">{r.start_date} — {r.end_date}</td>
                    <td className="px-4 py-3 text-gray-500 max-w-[200px] truncate">{r.reason ?? "—"}</td>
                    <td className="px-4 py-3">
                      <StatusBadge
                        label={r.status.charAt(0).toUpperCase() + r.status.slice(1)}
                        color={r.status === "approved" ? "green" : r.status === "denied" ? "red" : "yellow"}
                      />
                    </td>
                    <td className="px-4 py-3">
                      {r.status === "pending" && (
                        <div className="flex gap-2">
                          <button
                            onClick={() => handleTimeOffAction(r.id, "approved")}
                            className="text-xs text-green-600 hover:text-green-800 font-medium"
                          >
                            Approve
                          </button>
                          <button
                            onClick={() => handleTimeOffAction(r.id, "denied")}
                            className="text-xs text-red-500 hover:text-red-700 font-medium"
                          >
                            Deny
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
                {timeOffRequests.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-4 py-8 text-center text-gray-400">
                      No time off requests.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Modals */}
      {showAddPilot && (
        <AddPilotModal
          onClose={() => setShowAddPilot(false)}
          onCreated={() => { setShowAddPilot(false); fetchPilots(); }}
        />
      )}
      {showAddRotation && (
        <AddRotationModal
          pilots={pilots}
          onClose={() => setShowAddRotation(false)}
          onCreated={() => { setShowAddRotation(false); fetchRotations(); }}
        />
      )}
    </div>
  );
}
