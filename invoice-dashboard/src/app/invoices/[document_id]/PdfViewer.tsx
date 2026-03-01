"use client";

import { useState } from "react";

export default function PdfViewer({ url, filename }: { url: string; filename?: string }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="rounded-xl border bg-white shadow-sm overflow-hidden">
      <div className="flex items-center justify-between gap-3 px-4 py-3 text-sm">
        <div className="font-medium text-gray-700 truncate">
          {filename || "Invoice PDF"}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="text-xs px-2.5 py-1.5 rounded border border-gray-300 hover:bg-gray-50 font-medium"
          >
            {open ? "Hide PDF" : "View inline"}
          </button>
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            className="rounded-md bg-black px-3 py-2 text-xs font-medium text-white"
          >
            Open PDF
          </a>
        </div>
      </div>

      {open && (
        <div className="border-t bg-gray-50">
          <iframe
            src={url}
            className="w-full"
            style={{ height: "800px" }}
            title={filename || "Invoice PDF"}
          />
        </div>
      )}
    </div>
  );
}
