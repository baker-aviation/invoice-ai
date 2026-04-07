"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import RejectModal from "./RejectModal";
import { isGroundCategory } from "@/lib/groundPipeline";

const CATEGORY_OPTIONS = [
  { value: "pilot_pic", label: "Pilot — PIC" },
  { value: "pilot_sic", label: "Pilot — SIC" },
  { value: "skillbridge", label: "SkillBridge" },
  { value: "dispatcher", label: "Dispatcher" },
  { value: "maintenance", label: "Maintenance" },
  { value: "sales", label: "Sales" },
  { value: "hr", label: "HR" },
  { value: "admin", label: "Admin" },
  { value: "management", label: "Management" },
  { value: "line_service", label: "Line Service" },
  { value: "other", label: "Other" },
];

const EMPLOYMENT_OPTIONS = ["Full-Time", "Part-Time", "Contract", "Internship"];

type StructuredNotes = {
  hr_notes?: string;
  prd_review_notes?: string;
  tims_notes?: string;
  chief_pilot_notes?: string;
};

type ProfileData = {
  id: number;
  applicationId: number;
  candidate_name: string | null;
  email: string | null;
  phone: string | null;
  location: string | null;
  category: string | null;
  employment_type: string | null;
  total_time_hours: number | null;
  pic_time_hours: number | null;
  turbine_time_hours: number | null;
  sic_time_hours: number | null;
  notes: string | null;
  structured_notes: StructuredNotes | null;
  rejected_at: string | null;
  rejection_reason: string | null;
};

export default function ProfileEditor({ data, currentStage }: { data: ProfileData; currentStage: string | null }) {
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  // Editable field state
  const [name, setName] = useState(data.candidate_name ?? "");
  const [email, setEmail] = useState(data.email ?? "");
  const [phone, setPhone] = useState(data.phone ?? "");
  const [location, setLocation] = useState(data.location ?? "");
  const [category, setCategory] = useState(data.category ?? "");
  const [employmentType, setEmploymentType] = useState(data.employment_type ?? "");
  const [totalTime, setTotalTime] = useState(data.total_time_hours?.toString() ?? "");
  const [picTime, setPicTime] = useState(data.pic_time_hours?.toString() ?? "");
  const [turbineTime, setTurbineTime] = useState(data.turbine_time_hours?.toString() ?? "");
  const [sicTime, setSicTime] = useState(data.sic_time_hours?.toString() ?? "");
  const [notes, setNotes] = useState(data.notes ?? "");
  const [hrNotes, setHrNotes] = useState(data.structured_notes?.hr_notes ?? "");
  const [prdNotes, setPrdNotes] = useState(data.structured_notes?.prd_review_notes ?? "");
  const [timsNotes, setTimsNotes] = useState(data.structured_notes?.tims_notes ?? "");
  const [chiefPilotNotes, setChiefPilotNotes] = useState(data.structured_notes?.chief_pilot_notes ?? "");

  // Reject state
  const [showRejectForm, setShowRejectForm] = useState(false);
  const [showRejectModal, setShowRejectModal] = useState(false);
  const [rejectionReason, setRejectionReason] = useState("");
  const [rejecting, setRejecting] = useState(false);

  // Delete state
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // Reassign state
  const [showReassign, setShowReassign] = useState(false);
  const [reassignTarget, setReassignTarget] = useState(isGroundCategory(category) ? "pilot_sic" : "maintenance");
  const [reassigning, setReassigning] = useState(false);

  function resetForm() {
    setName(data.candidate_name ?? "");
    setEmail(data.email ?? "");
    setPhone(data.phone ?? "");
    setLocation(data.location ?? "");
    setCategory(data.category ?? "");
    setEmploymentType(data.employment_type ?? "");
    setTotalTime(data.total_time_hours?.toString() ?? "");
    setPicTime(data.pic_time_hours?.toString() ?? "");
    setTurbineTime(data.turbine_time_hours?.toString() ?? "");
    setSicTime(data.sic_time_hours?.toString() ?? "");
    setNotes(data.notes ?? "");
    setHrNotes(data.structured_notes?.hr_notes ?? "");
    setPrdNotes(data.structured_notes?.prd_review_notes ?? "");
    setTimsNotes(data.structured_notes?.tims_notes ?? "");
    setChiefPilotNotes(data.structured_notes?.chief_pilot_notes ?? "");
    setError(null);
  }

  function parseNum(v: string): number | null {
    if (!v.trim()) return null;
    const n = Number(v);
    return isNaN(n) ? null : n;
  }

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/jobs/${data.applicationId}/profile`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          candidate_name: name || null,
          email: email || null,
          phone: phone || null,
          location: location || null,
          category: category || null,
          employment_type: employmentType || null,
          total_time_hours: parseNum(totalTime),
          pic_time_hours: parseNum(picTime),
          turbine_time_hours: parseNum(turbineTime),
          sic_time_hours: parseNum(sicTime),
          notes: notes || null,
          structured_notes: {
            hr_notes: hrNotes || null,
            prd_review_notes: prdNotes || null,
            tims_notes: timsNotes || null,
            chief_pilot_notes: chiefPilotNotes || null,
          },
        }),
      });
      if (!res.ok) {
        const d = await res.json();
        throw new Error(d.error || "Save failed");
      }
      setEditing(false);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  async function handleReject() {
    setRejecting(true);
    setError(null);
    try {
      const res = await fetch(`/api/jobs/${data.applicationId}/reject`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rejection_reason: rejectionReason || null }),
      });
      if (!res.ok) {
        const d = await res.json();
        throw new Error(d.error || "Reject failed");
      }
      setShowRejectForm(false);
      setRejectionReason("");
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Reject failed");
    } finally {
      setRejecting(false);
    }
  }

  async function handleUnreject() {
    setRejecting(true);
    setError(null);
    try {
      const res = await fetch(`/api/jobs/${data.applicationId}/reject`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const d = await res.json();
        throw new Error(d.error || "Un-reject failed");
      }
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Un-reject failed");
    } finally {
      setRejecting(false);
    }
  }

  async function handleDelete() {
    setDeleting(true);
    setError(null);
    try {
      const res = await fetch(`/api/jobs/${data.applicationId}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const d = await res.json();
        throw new Error(d.error || "Delete failed");
      }
      router.push("/jobs");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Delete failed");
    } finally {
      setDeleting(false);
    }
  }

  async function handleReassign() {
    setReassigning(true);
    setError(null);
    try {
      const res = await fetch("/api/jobs/reassign", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: data.id, newCategory: reassignTarget }),
      });
      if (res.ok) {
        setShowReassign(false);
        router.refresh();
      } else {
        const body = await res.json().catch(() => ({}));
        setError(body.error ?? `Reassign failed (${res.status})`);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Reassign failed");
    } finally {
      setReassigning(false);
    }
  }

  const isPilot = category === "pilot_pic" || category === "pilot_sic";
  const isRejected = !!data.rejected_at;

  if (!editing) {
    return (
      <div className="flex items-center gap-2 mt-3">
        <button
          onClick={() => setEditing(true)}
          className="text-xs px-3 py-1.5 rounded bg-slate-800 text-white hover:bg-slate-700 font-medium"
        >
          Edit Profile
        </button>
        {isRejected ? (
          <button
            onClick={handleUnreject}
            disabled={rejecting}
            className="text-xs px-3 py-1.5 rounded border border-amber-300 bg-amber-50 text-amber-700 hover:bg-amber-100 font-medium disabled:opacity-40"
          >
            {rejecting ? "..." : "Un-reject"}
          </button>
        ) : (
          <button
            onClick={() => setShowRejectModal(true)}
            className="text-xs px-3 py-1.5 rounded border border-red-200 text-red-600 hover:bg-red-50 font-medium"
          >
            Reject Application
          </button>
        )}
        <button
          onClick={() => setConfirmDelete(true)}
          className="text-xs px-3 py-1.5 rounded border border-gray-200 text-gray-500 hover:bg-gray-50 font-medium"
        >
          Delete Profile
        </button>
        <button
          onClick={() => setShowReassign(true)}
          className={`text-xs px-3 py-1.5 rounded border font-medium ${
            isGroundCategory(category)
              ? "border-blue-200 text-blue-600 hover:bg-blue-50"
              : "border-teal-200 text-teal-600 hover:bg-teal-50"
          }`}
        >
          {isGroundCategory(category) ? "Move to Pilot" : "Move to Ground"}
        </button>

        {/* Reassign modal */}
        {showReassign && (
          <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50" onClick={() => setShowReassign(false)}>
            <div className="bg-white rounded-xl p-5 shadow-lg max-w-sm w-full mx-4 space-y-3" onClick={(e) => e.stopPropagation()}>
              <div className="text-sm font-semibold">
                Move {data.candidate_name?.split(/\s+/)[0]} to {isGroundCategory(category) ? "Pilot" : "Ground"} Jobs?
              </div>
              <select
                value={reassignTarget}
                onChange={(e) => setReassignTarget(e.target.value)}
                className="w-full text-sm rounded-lg border border-gray-200 px-3 py-2"
              >
                {isGroundCategory(category) ? (
                  <>
                    <option value="pilot_pic">PIC</option>
                    <option value="pilot_sic">SIC</option>
                    <option value="skillbridge">SkillBridge</option>
                    <option value="dispatcher">Dispatcher</option>
                  </>
                ) : (
                  <>
                    <option value="maintenance">A&P Mechanic / Mx</option>
                    <option value="sales">Sales</option>
                    <option value="management">Fleet Manager / Mgmt</option>
                    <option value="line_service">Line Service / Ramp</option>
                    <option value="admin">Admin / Office</option>
                    <option value="other">Other</option>
                  </>
                )}
              </select>
              <p className="text-[11px] text-gray-400">Pipeline stage will be reset</p>
              <div className="flex gap-2">
                <button
                  onClick={() => setShowReassign(false)}
                  className="flex-1 text-xs py-2 rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50 font-medium"
                >
                  Cancel
                </button>
                <button
                  onClick={handleReassign}
                  disabled={reassigning}
                  className={`flex-1 text-xs py-2 rounded-lg text-white font-medium disabled:opacity-50 ${
                    isGroundCategory(category) ? "bg-blue-600 hover:bg-blue-700" : "bg-teal-600 hover:bg-teal-700"
                  }`}
                >
                  {reassigning ? "Moving..." : "Move"}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Rejection modal */}
        {showRejectModal && (
          <RejectModal
            applicationId={data.applicationId}
            candidateName={data.candidate_name ?? ""}
            candidateEmail={data.email ?? null}
            currentStage={currentStage}
            onClose={() => setShowRejectModal(false)}
          />
        )}

        {/* Confirm delete modal */}
        {confirmDelete && (
          <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50" onClick={() => setConfirmDelete(false)}>
            <div className="bg-white rounded-xl p-5 shadow-lg max-w-sm w-full mx-4 space-y-3" onClick={(e) => e.stopPropagation()}>
              <div className="text-sm font-semibold">Delete this profile?</div>
              <p className="text-xs text-gray-600">
                The candidate will be hidden from all views. This can be undone via direct database access.
              </p>
              <div className="flex gap-2 justify-end">
                <button
                  onClick={() => setConfirmDelete(false)}
                  className="text-xs px-3 py-1.5 rounded border border-gray-200 text-gray-600 hover:bg-gray-50 font-medium"
                >
                  Cancel
                </button>
                <button
                  onClick={handleDelete}
                  disabled={deleting}
                  className="text-xs px-3 py-1.5 rounded bg-red-600 text-white hover:bg-red-700 font-medium disabled:opacity-40"
                >
                  {deleting ? "Deleting..." : "Delete"}
                </button>
              </div>
            </div>
          </div>
        )}

        {error && <div className="text-xs text-red-600">{error}</div>}
      </div>
    );
  }

  return (
    <div className="mt-3 border border-gray-200 rounded-lg p-4 space-y-4">
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold text-gray-700">Edit Profile</span>
        <button
          onClick={() => { setEditing(false); resetForm(); }}
          className="text-gray-400 hover:text-gray-600 text-lg leading-none"
        >
          &times;
        </button>
      </div>

      {/* Basic info */}
      <div className="grid gap-3 md:grid-cols-2">
        <Field label="Name" value={name} onChange={setName} />
        <Field label="Email" value={email} onChange={setEmail} type="email" />
        <Field label="Phone" value={phone} onChange={setPhone} />
        <Field label="Location" value={location} onChange={setLocation} />
        <div>
          <label className="block text-xs text-gray-500 mb-1">Category</label>
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm outline-none focus:border-blue-400"
          >
            <option value="">—</option>
            {CATEGORY_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">Employment Type</label>
          <select
            value={employmentType}
            onChange={(e) => setEmploymentType(e.target.value)}
            className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm outline-none focus:border-blue-400"
          >
            <option value="">—</option>
            {EMPLOYMENT_OPTIONS.map((o) => (
              <option key={o} value={o}>{o}</option>
            ))}
          </select>
        </div>
      </div>

      {/* Flight hours (only for pilots) */}
      {isPilot && (
        <div className="grid gap-3 md:grid-cols-4">
          <Field label="Total Time" value={totalTime} onChange={setTotalTime} type="number" />
          <Field label="PIC Time" value={picTime} onChange={setPicTime} type="number" />
          <Field label="Turbine Time" value={turbineTime} onChange={setTurbineTime} type="number" />
          <Field label="SIC Time" value={sicTime} onChange={setSicTime} type="number" />
        </div>
      )}

      {/* Notes */}
      <div>
        <label className="block text-xs text-gray-500 mb-1">Notes</label>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm outline-none focus:border-blue-400 min-h-[60px]"
        />
      </div>

      {/* Structured notes */}
      <div className="space-y-3">
        <div className="text-xs font-semibold text-gray-600">Review Notes</div>
        <div className="grid gap-3 md:grid-cols-2">
          <NoteField label="HR Notes" value={hrNotes} onChange={setHrNotes} />
          <NoteField label="PRD Review Notes" value={prdNotes} onChange={setPrdNotes} />
          <NoteField label="Tim's Notes" value={timsNotes} onChange={setTimsNotes} />
          <NoteField label="Chief Pilot Notes" value={chiefPilotNotes} onChange={setChiefPilotNotes} />
        </div>
      </div>

      {error && (
        <div className="text-xs text-red-600 bg-red-50 rounded p-2">{error}</div>
      )}

      <div className="flex gap-2">
        <button
          onClick={handleSave}
          disabled={saving}
          className="text-xs px-4 py-1.5 rounded bg-slate-800 text-white hover:bg-slate-700 font-medium disabled:opacity-40"
        >
          {saving ? "Saving..." : "Save Changes"}
        </button>
        <button
          onClick={() => { setEditing(false); resetForm(); }}
          className="text-xs px-3 py-1.5 rounded border border-gray-200 text-gray-600 hover:bg-gray-50 font-medium"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  type = "text",
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
}) {
  return (
    <div>
      <label className="block text-xs text-gray-500 mb-1">{label}</label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm outline-none focus:border-blue-400"
      />
    </div>
  );
}

function NoteField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div>
      <label className="block text-xs text-gray-500 mb-1">{label}</label>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm outline-none focus:border-blue-400 min-h-[60px]"
        placeholder={`${label}...`}
      />
    </div>
  );
}
