"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type RejectionType = "hard" | "soft" | "left_process";

const TYPE_CONFIG: Record<RejectionType, { label: string; description: string; color: string; bgColor: string }> = {
  hard: {
    label: "Hard Reject",
    description: "We don't want this candidate. A final rejection email will be sent.",
    color: "text-red-700",
    bgColor: "bg-red-50 border-red-200 hover:bg-red-100",
  },
  soft: {
    label: "Soft Reject",
    description: "Doesn't meet requirements now — encouraged to reapply later.",
    color: "text-amber-700",
    bgColor: "bg-amber-50 border-amber-200 hover:bg-amber-100",
  },
  left_process: {
    label: "Left Process",
    description: "Candidate stopped responding or withdrew from the process.",
    color: "text-gray-700",
    bgColor: "bg-gray-50 border-gray-200 hover:bg-gray-100",
  },
};

export default function RejectModal({
  applicationId,
  candidateName,
  candidateEmail,
  onClose,
}: {
  applicationId: number;
  candidateName: string;
  candidateEmail: string | null;
  onClose: () => void;
}) {
  const router = useRouter();
  const [step, setStep] = useState<"type" | "notes" | "confirm">("type");
  const [type, setType] = useState<RejectionType | null>(null);
  const [notes, setNotes] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; emailSent?: boolean; emailError?: string } | null>(null);

  const handleSelectType = (t: RejectionType) => {
    setType(t);
    setStep("notes");
  };

  const handleConfirm = async () => {
    if (!type) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/jobs/${applicationId}/reject`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rejection_type: type,
          rejection_reason: notes.trim() || null,
          send_email: true,
        }),
      });
      const data = await res.json();
      setResult(data);
      if (data.ok) {
        setTimeout(() => {
          onClose();
          router.refresh();
        }, 2000);
      }
    } catch (err) {
      setResult({ ok: false, emailError: String(err) });
    } finally {
      setLoading(false);
    }
  };

  const firstName = candidateName.split(/\s+/)[0] || "this candidate";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-md mx-4 overflow-hidden" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="px-5 py-4 border-b border-gray-100">
          <h3 className="text-base font-semibold text-gray-900">Reject {candidateName}</h3>
          {candidateEmail && <p className="text-xs text-gray-500 mt-0.5">{candidateEmail}</p>}
        </div>

        {/* Step 1: Select Type */}
        {step === "type" && (
          <div className="p-5 space-y-2">
            <p className="text-sm text-gray-600 mb-3">Select rejection type:</p>
            {(Object.entries(TYPE_CONFIG) as [RejectionType, typeof TYPE_CONFIG[RejectionType]][]).map(([key, cfg]) => (
              <button
                key={key}
                onClick={() => handleSelectType(key)}
                className={`w-full text-left rounded-lg border p-3 transition-colors ${cfg.bgColor}`}
              >
                <div className={`text-sm font-semibold ${cfg.color}`}>{cfg.label}</div>
                <div className="text-xs text-gray-500 mt-0.5">{cfg.description}</div>
              </button>
            ))}
            <button onClick={onClose} className="w-full mt-2 text-xs text-gray-400 hover:text-gray-600 py-2">
              Cancel
            </button>
          </div>
        )}

        {/* Step 2: Notes */}
        {step === "notes" && type && (
          <div className="p-5 space-y-3">
            <div className={`text-sm font-semibold ${TYPE_CONFIG[type].color}`}>
              {TYPE_CONFIG[type].label}
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Notes (optional)</label>
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Internal notes about this rejection..."
                rows={3}
                className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-gray-400 resize-none"
              />
            </div>
            <div className="flex gap-2">
              <button onClick={() => setStep("type")} className="flex-1 text-sm py-2 rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50">
                Back
              </button>
              <button onClick={() => setStep("confirm")} className="flex-1 text-sm py-2 rounded-lg bg-red-600 text-white hover:bg-red-700 font-medium">
                Continue
              </button>
            </div>
          </div>
        )}

        {/* Step 3: Confirm */}
        {step === "confirm" && type && !result && (
          <div className="p-5 space-y-4">
            <div className="rounded-lg bg-amber-50 border border-amber-200 p-3">
              <div className="text-sm font-semibold text-amber-800">Confirm Rejection</div>
              <div className="text-xs text-amber-700 mt-1">
                This will reject <strong>{candidateName}</strong> ({TYPE_CONFIG[type].label.toLowerCase()})
                {candidateEmail && (
                  <> and send a rejection email to <strong>{candidateEmail}</strong></>
                )}.
              </div>
              {!candidateEmail && (
                <div className="text-xs text-amber-600 mt-1">No email on file — no email will be sent.</div>
              )}
            </div>
            {notes && (
              <div className="text-xs text-gray-500">
                <span className="font-medium">Notes:</span> {notes}
              </div>
            )}
            <div className="flex gap-2">
              <button onClick={() => setStep("notes")} disabled={loading} className="flex-1 text-sm py-2 rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50 disabled:opacity-50">
                Back
              </button>
              <button onClick={handleConfirm} disabled={loading} className="flex-1 text-sm py-2 rounded-lg bg-red-600 text-white hover:bg-red-700 font-medium disabled:opacity-50">
                {loading ? "Rejecting..." : "Confirm & Send Email"}
              </button>
            </div>
          </div>
        )}

        {/* Result */}
        {result && (
          <div className="p-5 space-y-3">
            {result.ok ? (
              <div className="text-center">
                <div className="text-2xl mb-2">&#10003;</div>
                <div className="text-sm font-semibold text-gray-900">
                  {candidateName} has been rejected
                </div>
                {result.emailSent && (
                  <div className="text-xs text-emerald-600 mt-1">Rejection email sent to {candidateEmail}</div>
                )}
                {result.emailError && (
                  <div className="text-xs text-red-600 mt-1">Email issue: {result.emailError}</div>
                )}
                <div className="text-xs text-gray-400 mt-2">Closing...</div>
              </div>
            ) : (
              <div className="text-center">
                <div className="text-sm text-red-600">{result.emailError ?? "Something went wrong"}</div>
                <button onClick={onClose} className="mt-3 text-xs text-gray-500 hover:text-gray-700">Close</button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
