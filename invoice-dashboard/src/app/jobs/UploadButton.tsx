"use client";

import { useState } from "react";
import UploadResumeModal from "./UploadResumeModal";

export default function UploadButton() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-lg border border-gray-300 bg-white text-gray-700 hover:bg-gray-50 transition-colors"
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M8 12V3" />
          <path d="M4 7l4-4 4 4" />
          <path d="M2 14h12" />
        </svg>
        Upload
      </button>
      <UploadResumeModal open={open} onClose={() => setOpen(false)} />
    </>
  );
}
