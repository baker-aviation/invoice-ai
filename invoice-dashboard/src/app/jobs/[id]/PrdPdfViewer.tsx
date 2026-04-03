"use client";

import { useState } from "react";

export default function PrdPdfViewer({ url }: { url: string }) {
  const [open, setOpen] = useState(false);

  return (
    <div>
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 text-sm text-blue-600 hover:text-blue-800 font-medium transition-colors"
      >
        <svg
          width="12"
          height="12"
          viewBox="0 0 12 12"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={`transition-transform ${open ? "rotate-90" : ""}`}
        >
          <path d="M4.5 2l4 4-4 4" />
        </svg>
        {open ? "Hide PRD PDF" : "View PRD PDF"}
      </button>
      {open && (
        <iframe
          src={url}
          className="w-full rounded-lg border border-gray-200 mt-2"
          style={{ height: "600px" }}
          title="PRD Document"
        />
      )}
    </div>
  );
}
