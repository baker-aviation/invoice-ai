"use client";

import { useState, useRef, useCallback } from "react";
import { usePathname } from "next/navigation";
import { Bug, Camera, Loader2, CheckCircle2 } from "lucide-react";
import html2canvas from "html2canvas";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";

// ---------------------------------------------------------------------------
// Route → ticket section mapping
// ---------------------------------------------------------------------------

type TicketSection =
  | "general"
  | "crew-swap"
  | "international"
  | "current-ops"
  | "duty"
  | "notams"
  | "hiring"
  | "invoices";

const ROUTE_SECTION_MAP: Record<string, TicketSection> = {
  "/ops": "current-ops",
  "/invoices": "invoices",
  "/alerts": "invoices",
  "/fees": "invoices",
  "/fuel-prices": "invoices",
  "/fuel-dashboard": "general",
  "/foreflight": "general",
  "/jobs": "hiring",
  "/job-applications": "hiring",
  "/pipeline": "hiring",
  "/maintenance": "general",
  "/van": "general",
  "/vehicles": "general",
  "/crew-cars": "general",
  "/pilots": "general",
  "/aircraft": "general",
  "/jetinsight": "general",
  "/admin": "general",
  "/health": "general",
  "/crew-swap": "crew-swap",
  "/tanker": "general",
  "/pending": "general",
};

function detectSection(pathname: string): TicketSection {
  // Check international ops (nested under /ops but has its own section)
  if (pathname.includes("international") || pathname.includes("intl")) {
    return "international";
  }
  for (const [route, section] of Object.entries(ROUTE_SECTION_MAP)) {
    if (pathname.startsWith(route)) return section;
  }
  return "general";
}

const SECTION_OPTIONS: { value: TicketSection; label: string }[] = [
  { value: "general", label: "General" },
  { value: "current-ops", label: "Current Ops" },
  { value: "invoices", label: "Invoices" },
  { value: "hiring", label: "Hiring" },
  { value: "crew-swap", label: "Crew Swap" },
  { value: "international", label: "International" },
  { value: "duty", label: "Duty" },
  { value: "notams", label: "NOTAMs" },
];

const PRIORITY_OPTIONS = [
  { value: 5, label: "P0 — Critical" },
  { value: 20, label: "P1 — High" },
  { value: 50, label: "P2 — Medium" },
  { value: 80, label: "P3 — Low" },
];

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function BugReportButton() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [description, setDescription] = useState("");
  const [expected, setExpected] = useState("");
  const [section, setSection] = useState<TicketSection>("general");
  const [priority, setPriority] = useState(50);
  const [screenshotBlob, setScreenshotBlob] = useState<Blob | null>(null);
  const [screenshotUrl, setScreenshotUrl] = useState<string | null>(null);
  const [capturing, setCapturing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);

  const captureScreenshot = useCallback(async () => {
    setCapturing(true);
    try {
      const canvas = await html2canvas(document.body, {
        useCORS: true,
        scale: 1, // 1x is plenty for bug context
        logging: false,
        ignoreElements: (el) => {
          // Don't capture the bug report button itself or the modal
          return (
            el.getAttribute("data-bug-report") === "true" ||
            el.getAttribute("data-slot") === "dialog-overlay" ||
            el.getAttribute("data-slot") === "dialog-content"
          );
        },
      });
      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, "image/png", 0.8)
      );
      if (blob) {
        setScreenshotBlob(blob);
        setScreenshotUrl(URL.createObjectURL(blob));
      }
    } catch (err) {
      console.error("Screenshot capture failed:", err);
    } finally {
      setCapturing(false);
    }
  }, []);

  const handleOpen = useCallback(() => {
    setSection(detectSection(pathname));
    setOpen(true);
    // Capture screenshot after a tick so the modal isn't in the shot
    setTimeout(() => captureScreenshot(), 50);
  }, [pathname, captureScreenshot]);

  const handleClose = useCallback(() => {
    setOpen(false);
    // Reset after animation
    setTimeout(() => {
      setDescription("");
      setExpected("");
      setPriority(50);
      setScreenshotBlob(null);
      if (screenshotUrl) URL.revokeObjectURL(screenshotUrl);
      setScreenshotUrl(null);
      setSubmitted(false);
    }, 200);
  }, [screenshotUrl]);

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!description.trim() || submitting) return;

      setSubmitting(true);
      try {
        const fd = new FormData();
        fd.append("description", description.trim());
        if (expected.trim()) fd.append("expected", expected.trim());
        fd.append("section", section);
        fd.append("priority", String(priority));
        fd.append("pathname", pathname);
        fd.append("viewport", `${window.innerWidth}x${window.innerHeight}`);
        fd.append("userAgent", navigator.userAgent);
        if (screenshotBlob) {
          fd.append("screenshot", screenshotBlob, "screenshot.png");
        }

        const res = await fetch("/api/bug-report", { method: "POST", body: fd });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || "Failed to submit");
        }

        setSubmitted(true);
        setTimeout(handleClose, 1500);
      } catch (err) {
        console.error("Bug report submission failed:", err);
        alert("Failed to submit bug report. Please try again.");
      } finally {
        setSubmitting(false);
      }
    },
    [description, expected, section, priority, pathname, screenshotBlob, submitting, handleClose]
  );

  // Success state
  if (submitted && open) {
    return (
      <>
        <FloatingBug onClick={handleOpen} />
        <Dialog open={open} onOpenChange={(o) => !o && handleClose()}>
          <DialogContent className="sm:max-w-md">
            <div className="flex flex-col items-center gap-3 py-6">
              <CheckCircle2 className="h-12 w-12 text-emerald-500" />
              <p className="text-base font-medium">Bug report submitted!</p>
              <p className="text-sm text-muted-foreground">Added to the ticket queue.</p>
            </div>
          </DialogContent>
        </Dialog>
      </>
    );
  }

  return (
    <>
      <FloatingBug onClick={handleOpen} />
      <Dialog open={open} onOpenChange={(o) => !o && handleClose()}>
        <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Report a Bug</DialogTitle>
            <DialogDescription>
              Describe what went wrong. A screenshot and page context will be included automatically.
            </DialogDescription>
          </DialogHeader>

          <form ref={formRef} onSubmit={handleSubmit} className="flex flex-col gap-4">
            {/* Screenshot preview */}
            <div className="rounded-lg border bg-muted/30 p-2">
              {capturing ? (
                <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Capturing screenshot...
                </div>
              ) : screenshotUrl ? (
                <div className="space-y-2">
                  <img
                    src={screenshotUrl}
                    alt="Screenshot"
                    className="w-full rounded border"
                  />
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={captureScreenshot}
                      className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
                    >
                      <Camera className="h-3 w-3" /> Retake
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setScreenshotBlob(null);
                        if (screenshotUrl) URL.revokeObjectURL(screenshotUrl);
                        setScreenshotUrl(null);
                      }}
                      className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                    >
                      Remove
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={captureScreenshot}
                  className="flex w-full items-center justify-center gap-2 py-4 text-sm text-muted-foreground hover:text-foreground transition-colors"
                >
                  <Camera className="h-4 w-4" /> Capture screenshot
                </button>
              )}
            </div>

            {/* Description */}
            <div>
              <label htmlFor="bug-desc" className="mb-1 block text-sm font-medium">
                What went wrong? <span className="text-red-500">*</span>
              </label>
              <textarea
                id="bug-desc"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Describe the bug..."
                rows={3}
                required
                className="w-full rounded-md border bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>

            {/* Expected */}
            <div>
              <label htmlFor="bug-expected" className="mb-1 block text-sm font-medium">
                Expected behavior <span className="text-xs text-muted-foreground">(optional)</span>
              </label>
              <textarea
                id="bug-expected"
                value={expected}
                onChange={(e) => setExpected(e.target.value)}
                placeholder="What should have happened?"
                rows={2}
                className="w-full rounded-md border bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>

            {/* Section + Priority row */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label htmlFor="bug-section" className="mb-1 block text-sm font-medium">
                  Section
                </label>
                <select
                  id="bug-section"
                  value={section}
                  onChange={(e) => setSection(e.target.value as TicketSection)}
                  className="w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                >
                  {SECTION_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor="bug-priority" className="mb-1 block text-sm font-medium">
                  Priority
                </label>
                <select
                  id="bug-priority"
                  value={priority}
                  onChange={(e) => setPriority(Number(e.target.value))}
                  className="w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                >
                  {PRIORITY_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <DialogFooter>
              <button
                type="submit"
                disabled={!description.trim() || submitting}
                className="inline-flex items-center gap-2 rounded-md bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {submitting ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" /> Submitting...
                  </>
                ) : (
                  <>
                    <Bug className="h-4 w-4" /> Submit Bug Report
                  </>
                )}
              </button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

// ---------------------------------------------------------------------------
// Floating action button
// ---------------------------------------------------------------------------

function FloatingBug({ onClick }: { onClick: () => void }) {
  return (
    <button
      data-bug-report="true"
      onClick={onClick}
      title="Report a bug"
      className="fixed bottom-14 right-4 z-40 flex h-10 w-10 items-center justify-center rounded-full bg-red-600/80 text-white shadow-lg backdrop-blur-sm transition-all hover:bg-red-600 hover:scale-110 hover:shadow-xl active:scale-95"
    >
      <Bug className="h-5 w-5" />
    </button>
  );
}
