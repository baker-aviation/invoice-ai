"use client";

import { useState } from "react";

function fmtDate(s: any) {
  return String(s ?? "").replace("T", " ").replace("+00:00", "Z");
}

function isDocx(f: any): boolean {
  const ct = (f.content_type ?? "").toLowerCase();
  const fn = (f.filename ?? "").toLowerCase();
  return ct.includes("wordprocessingml") || ct.includes("msword") || fn.endsWith(".docx") || fn.endsWith(".doc");
}

function isPdf(f: any): boolean {
  const ct = (f.content_type ?? "").toLowerCase();
  const fn = (f.filename ?? "").toLowerCase();
  return ct.includes("pdf") || fn.endsWith(".pdf");
}

export default function FileViewer({
  file,
  downloadUrl,
}: {
  file: any;
  downloadUrl: string;
}) {
  const [open, setOpen] = useState(false);

  const canViewInline = isPdf(file) || (isDocx(file) && !!file.signed_url);

  // PDF: embed directly via the redirect URL (browser renders natively)
  // DOCX: use Microsoft Office online viewer with the signed GCS URL
  const viewerSrc = isPdf(file)
    ? downloadUrl
    : isDocx(file) && file.signed_url
    ? `https://view.officeapps.live.com/op/embed.aspx?src=${encodeURIComponent(file.signed_url)}`
    : null;

  return (
    <div className="border rounded-lg overflow-hidden">
      {/* Header row */}
      <div className="flex items-center justify-between gap-3 px-4 py-3 text-sm bg-white">
        <div className="min-w-0">
          <div className="font-medium truncate">{file.filename ?? "file"}</div>
          <div className="text-xs text-gray-500">
            {file.content_type ?? "—"}
            {typeof file.size_bytes === "number" ? ` • ${(file.size_bytes / 1024).toFixed(0)} KB` : ""}
            {file.created_at ? ` • ${fmtDate(file.created_at)}` : ""}
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {canViewInline && (
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              className="text-xs px-2.5 py-1.5 rounded border border-gray-300 hover:bg-gray-50 font-medium"
            >
              {open ? "Hide" : "View inline"}
            </button>
          )}
          <a
            href={downloadUrl}
            target="_blank"
            rel="noreferrer"
            className="text-blue-600 hover:underline whitespace-nowrap text-xs"
          >
            Open →
          </a>
        </div>
      </div>

      {/* Inline viewer */}
      {open && viewerSrc && (
        <div className="border-t bg-gray-50">
          <iframe
            src={viewerSrc}
            className="w-full"
            style={{ height: "720px" }}
            title={file.filename ?? "file"}
            sandbox="allow-scripts allow-same-origin"
          />
        </div>
      )}
    </div>
  );
}
