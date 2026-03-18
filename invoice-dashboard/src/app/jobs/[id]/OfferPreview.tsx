"use client";

import { useState } from "react";

export default function OfferPreview({
  applicationId,
}: {
  applicationId: number;
}) {
  const [loading, setLoading] = useState(false);
  const [html, setHtml] = useState<string | null>(null);
  const [candidateName, setCandidateName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

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

  const handlePrint = () => {
    window.print();
  };

  return (
    <>
      <button
        onClick={fetchOffer}
        disabled={loading}
        className="px-4 py-2 bg-slate-800 text-white text-sm font-medium rounded-lg hover:bg-slate-700 disabled:opacity-50 transition-colors"
      >
        {loading ? "Loading..." : "Preview Offer"}
      </button>

      {error && (
        <p className="mt-2 text-sm text-red-600">{error}</p>
      )}

      {open && html && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 print:bg-white print:static print:block">
          {/* Modal content */}
          <div className="relative bg-white rounded-xl shadow-2xl max-w-3xl w-full max-h-[90vh] overflow-auto m-4 print:max-w-none print:max-h-none print:m-0 print:shadow-none print:rounded-none">
            {/* Toolbar — hidden in print */}
            <div className="sticky top-0 z-10 flex items-center justify-between bg-slate-800 text-white px-4 py-3 rounded-t-xl print:hidden">
              <span className="text-sm font-medium">
                Offer Letter — {candidateName}
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
