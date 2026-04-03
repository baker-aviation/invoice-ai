"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function PrdParseButton({ applicationId }: { applicationId: number }) {
  const [parsing, setParsing] = useState(false);
  const router = useRouter();

  async function handleParse() {
    setParsing(true);
    try {
      const res = await fetch(`/api/jobs/${applicationId}/parse-prd`, { method: "POST" });
      const data = await res.json();
      if (data.ok) {
        router.refresh();
      } else {
        alert(`Parse failed: ${data.error ?? "Unknown error"}`);
      }
    } catch (err: any) {
      alert(`Parse failed: ${err.message}`);
    } finally {
      setParsing(false);
    }
  }

  return (
    <button
      onClick={handleParse}
      disabled={parsing}
      className="px-2 py-1 text-xs font-medium rounded border border-orange-300 bg-orange-50 text-orange-700 hover:bg-orange-100 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
    >
      {parsing ? "Parsing..." : "Parse PRD"}
    </button>
  );
}
