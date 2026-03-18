"use client";

import { useState } from "react";

const OFFER_STATUS_BADGE: Record<string, { label: string; cls: string }> = {
  draft: { label: "Draft", cls: "bg-gray-100 text-gray-600 border-gray-200" },
  sent: { label: "Offer Sent", cls: "bg-blue-100 text-blue-700 border-blue-200" },
  accepted: { label: "Accepted", cls: "bg-emerald-100 text-emerald-700 border-emerald-200" },
  declined: { label: "Declined", cls: "bg-red-100 text-red-700 border-red-200" },
};

export default function OfferPreview({
  applicationId,
  initialOfferStatus,
}: {
  applicationId: number;
  initialOfferStatus?: string | null;
}) {
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [html, setHtml] = useState<string | null>(null);
  const [candidateName, setCandidateName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [offerStatus, setOfferStatus] = useState<string | null>(
    initialOfferStatus ?? null,
  );

  const fetchOffer = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/jobs/${applicationId}/offer`);
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Failed to generate offer");
        return;
      }
      setHtml(data.html);
      setCandidateName(data.candidate_name);
      setOpen(true);
    } catch {
      setError("Network error");
    } finally {
      setLoading(false);
    }
  };

  const handleSendOffer = async () => {
    setSending(true);
    setError(null);
    setSuccessMsg(null);
    try {
      // Fetch the offer HTML first if not already loaded
      if (!html) {
        const offerRes = await fetch(`/api/jobs/${applicationId}/offer`);
        const offerData = await offerRes.json();
        if (!offerRes.ok) {
          setError(offerData.error ?? "Failed to generate offer");
          setSending(false);
          return;
        }
        setHtml(offerData.html);
        setCandidateName(offerData.candidate_name);
      }

      // Mark as sent
      const res = await fetch(`/api/jobs/${applicationId}/profile`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          offer_sent_at: new Date().toISOString(),
          offer_status: "sent",
        }),
      });

      if (!res.ok) {
        setError("Failed to mark offer as sent");
      } else {
        setOfferStatus("sent");
        setSuccessMsg("Offer marked as sent. Send the offer letter manually via email.");
      }
    } catch {
      setError("Network error");
    } finally {
      setSending(false);
    }
  };

  const handleStatusChange = async (newStatus: string) => {
    const prev = offerStatus;
    setOfferStatus(newStatus);
    try {
      const res = await fetch(`/api/jobs/${applicationId}/profile`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          offer_status: newStatus,
          ...(newStatus === "sent"
            ? { offer_sent_at: new Date().toISOString() }
            : {}),
        }),
      });
      if (!res.ok) {
        setOfferStatus(prev);
      }
    } catch {
      setOfferStatus(prev);
    }
  };

  const handlePrint = () => {
    window.print();
  };

  const badge = offerStatus ? OFFER_STATUS_BADGE[offerStatus] : null;

  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        <button
          onClick={fetchOffer}
          disabled={loading}
          className="px-4 py-2 bg-slate-800 text-white text-sm font-medium rounded-lg hover:bg-slate-700 disabled:opacity-50 transition-colors"
        >
          {loading ? "Loading..." : "Preview Offer"}
        </button>

        <button
          onClick={handleSendOffer}
          disabled={sending || offerStatus === "sent" || offerStatus === "accepted"}
          className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors"
        >
          {sending
            ? "Marking..."
            : offerStatus === "sent" || offerStatus === "accepted"
              ? "Offer Sent"
              : "Send Offer"}
        </button>

        {badge && (
          <span
            className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-semibold ${badge.cls}`}
          >
            {badge.label}
          </span>
        )}

        <div className="flex items-center gap-1.5">
          <label className="text-xs text-gray-500">Status:</label>
          <select
            value={offerStatus ?? ""}
            onChange={(e) => handleStatusChange(e.target.value)}
            className="rounded-lg border border-gray-200 px-2 py-1 text-xs outline-none focus:border-gray-400 bg-white"
          >
            <option value="">No status</option>
            <option value="draft">Draft</option>
            <option value="sent">Sent</option>
            <option value="accepted">Accepted</option>
            <option value="declined">Declined</option>
          </select>
        </div>
      </div>

      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}

      {successMsg && (
        <p className="mt-2 text-sm text-emerald-600">{successMsg}</p>
      )}

      {open && html && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 print:bg-white print:static print:block">
          {/* Modal content */}
          <div className="relative bg-white rounded-xl shadow-2xl max-w-3xl w-full max-h-[90vh] overflow-auto m-4 print:max-w-none print:max-h-none print:m-0 print:shadow-none print:rounded-none">
            {/* Toolbar -- hidden in print */}
            <div className="sticky top-0 z-10 flex items-center justify-between bg-slate-800 text-white px-4 py-3 rounded-t-xl print:hidden">
              <span className="text-sm font-medium">
                Offer Letter -- {candidateName}
              </span>
              <div className="flex items-center gap-2">
                <button
                  onClick={handlePrint}
                  className="px-3 py-1.5 bg-white text-slate-800 text-sm font-medium rounded-lg hover:bg-gray-100 transition-colors"
                >
                  Print / Save PDF
                </button>
                <button
                  onClick={() => setOpen(false)}
                  className="px-3 py-1.5 text-sm font-medium rounded-lg hover:bg-slate-700 transition-colors"
                >
                  Close
                </button>
              </div>
            </div>

            {/* Offer letter content */}
            <div
              id="offer-letter-print"
              className="p-8 print:p-0"
              dangerouslySetInnerHTML={{ __html: html }}
            />
          </div>

          {/* Print-only styles */}
          <style>{`
            @media print {
              body > *:not(.fixed) { display: none !important; }
              #offer-letter-print { display: block !important; }
            }
          `}</style>
        </div>
      )}
    </>
  );
}
