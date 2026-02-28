"use client";

import { useState } from "react";

export function PdfViewer({ url, label }: { url: string; label?: string }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium hover:bg-gray-50 transition-colors"
        >
          {open ? "Hide PDF" : label ?? "View PDF"}
        </button>
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          className="text-sm text-blue-600 hover:underline"
        >
          Open in new tab
        </a>
      </div>

      {open && (
        <div className="rounded-lg border overflow-hidden bg-gray-50">
          <iframe
            src={url}
            className="w-full"
            style={{ height: "720px" }}
            title="PDF viewer"
          />
        </div>
      )}
    </div>
  );
}
