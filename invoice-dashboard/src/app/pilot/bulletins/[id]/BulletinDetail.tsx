"use client";

import { useState } from "react";

/**
 * Extract a YouTube or Vimeo embed URL from a video URL.
 */
function getEmbedUrl(url: string): string | null {
  // YouTube
  const ytMatch = url.match(
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/,
  );
  if (ytMatch) return `https://www.youtube.com/embed/${ytMatch[1]}`;

  // Vimeo
  const vimeoMatch = url.match(/vimeo\.com\/(\d+)/);
  if (vimeoMatch) return `https://player.vimeo.com/video/${vimeoMatch[1]}`;

  return null;
}

export default function BulletinDetail({
  bulletinId,
  downloadUrl,
  pdfFilename,
  videoUrl,
}: {
  bulletinId: number;
  downloadUrl: string | null;
  pdfFilename: string | null;
  videoUrl: string | null;
}) {
  const [pdfOpen, setPdfOpen] = useState(true);

  const embedUrl = videoUrl ? getEmbedUrl(videoUrl) : null;

  return (
    <div className="space-y-4">
      {/* PDF viewer */}
      {downloadUrl && (
        <div className="border rounded-lg overflow-hidden">
          <div className="flex items-center justify-between gap-3 px-4 py-3 text-sm bg-gray-50">
            <div className="min-w-0">
              <div className="font-medium truncate">{pdfFilename ?? "Bulletin PDF"}</div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={() => setPdfOpen((v) => !v)}
                className="text-xs px-2.5 py-1.5 rounded border border-gray-300 hover:bg-gray-100 font-medium"
              >
                {pdfOpen ? "Hide" : "View inline"}
              </button>
              <a
                href={downloadUrl}
                target="_blank"
                rel="noreferrer"
                className="text-xs px-2.5 py-1.5 rounded border border-gray-300 hover:bg-gray-100 font-medium text-blue-600"
              >
                Download PDF
              </a>
            </div>
          </div>

          {pdfOpen && (
            <div className="border-t bg-gray-50">
              <iframe
                src={downloadUrl}
                className="w-full"
                style={{ height: "720px" }}
                title={pdfFilename ?? "Bulletin PDF"}
              />
            </div>
          )}
        </div>
      )}

      {/* Video embed */}
      {videoUrl && embedUrl && (
        <div className="border rounded-lg overflow-hidden">
          <div className="px-4 py-3 text-sm bg-gray-50 font-medium">
            Video
          </div>
          <div className="border-t aspect-video">
            <iframe
              src={embedUrl}
              className="w-full h-full"
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
              allowFullScreen
              title="Bulletin video"
            />
          </div>
        </div>
      )}

      {/* Video link fallback (non-embeddable URL) */}
      {videoUrl && !embedUrl && (
        <div className="border rounded-lg px-4 py-3 bg-gray-50">
          <span className="text-sm font-medium text-gray-700">Video: </span>
          <a
            href={videoUrl}
            target="_blank"
            rel="noreferrer"
            className="text-sm text-blue-600 hover:underline"
          >
            {videoUrl}
          </a>
        </div>
      )}

      {/* No attachments */}
      {!downloadUrl && !videoUrl && (
        <p className="text-sm text-gray-400">No attachments.</p>
      )}
    </div>
  );
}
