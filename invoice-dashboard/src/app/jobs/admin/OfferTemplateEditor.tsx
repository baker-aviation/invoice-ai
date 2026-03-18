"use client";

import { useState, useCallback } from "react";

interface Template {
  id?: number;
  role: string;
  name: string;
  html_body: string;
  updated_at?: string;
  updated_by?: string;
}

const ROLES = ["pic", "sic"] as const;

const DEFAULT_TEMPLATE = `<div style="font-family: Georgia, serif; max-width: 700px; margin: 0 auto; padding: 40px;">
  <h1 style="text-align: center; color: #1a1a1a;">Baker Aviation</h1>
  <p>{{date}}</p>
  <p>Dear {{candidate_name}},</p>
  <p>We are pleased to extend this offer of employment...</p>
  <p>Please confirm your acceptance by replying to {{email}}.</p>
  <br/>
  <p>Sincerely,<br/>Baker Aviation</p>
</div>`;

export default function OfferTemplateEditor({
  initialTemplates,
}: {
  initialTemplates: Template[];
}) {
  const [activeRole, setActiveRole] = useState<"pic" | "sic">("pic");
  const [templates, setTemplates] = useState<Record<string, string>>(() => {
    const map: Record<string, string> = {};
    for (const t of initialTemplates) {
      map[t.role] = t.html_body;
    }
    return map;
  });
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<{ type: "success" | "error"; msg: string } | null>(null);

  const htmlBody = templates[activeRole] ?? DEFAULT_TEMPLATE;

  const setHtml = useCallback(
    (html: string) => {
      setTemplates((prev) => ({ ...prev, [activeRole]: html }));
    },
    [activeRole],
  );

  const handleSave = async () => {
    setSaving(true);
    setToast(null);
    try {
      const res = await fetch("/api/jobs/templates", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: activeRole, html_body: htmlBody }),
      });
      const data = await res.json();
      if (!res.ok) {
        setToast({ type: "error", msg: data.error ?? "Save failed" });
      } else {
        setToast({ type: "success", msg: `${activeRole.toUpperCase()} template saved.` });
      }
    } catch {
      setToast({ type: "error", msg: "Network error" });
    } finally {
      setSaving(false);
      setTimeout(() => setToast(null), 4000);
    }
  };

  // Replace merge fields with sample data for preview
  const previewHtml = htmlBody
    .replace(/\{\{candidate_name\}\}/g, "Jane Doe")
    .replace(/\{\{date\}\}/g, "March 18, 2026")
    .replace(/\{\{email\}\}/g, "jane.doe@example.com");

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-gray-900">Offer Letter Templates</h2>
        <div className="flex items-center gap-2">
          {toast && (
            <span
              className={`text-sm font-medium px-3 py-1 rounded-lg ${
                toast.type === "success"
                  ? "bg-green-100 text-green-800"
                  : "bg-red-100 text-red-800"
              }`}
            >
              {toast.msg}
            </span>
          )}
          <button
            onClick={handleSave}
            disabled={saving}
            className="px-4 py-2 bg-slate-800 text-white text-sm font-medium rounded-lg hover:bg-slate-700 disabled:opacity-50 transition-colors"
          >
            {saving ? "Saving..." : "Save Template"}
          </button>
        </div>
      </div>

      {/* Role tabs */}
      <div className="flex items-center gap-1">
        {ROLES.map((role) => (
          <button
            key={role}
            onClick={() => setActiveRole(role)}
            className={`px-4 py-1.5 text-sm font-medium rounded-lg transition-colors ${
              activeRole === role
                ? "bg-slate-800 text-white"
                : "text-gray-500 hover:text-gray-800 hover:bg-gray-100"
            }`}
          >
            {role.toUpperCase()}
          </button>
        ))}
      </div>

      {/* Merge field reference */}
      <div className="rounded-lg border border-blue-100 bg-blue-50/50 px-4 py-2 text-sm text-blue-800">
        <span className="font-medium">Merge fields:</span>{" "}
        <code className="bg-blue-100 px-1.5 py-0.5 rounded text-xs">{"{{candidate_name}}"}</code>{" "}
        <code className="bg-blue-100 px-1.5 py-0.5 rounded text-xs">{"{{date}}"}</code>{" "}
        <code className="bg-blue-100 px-1.5 py-0.5 rounded text-xs">{"{{email}}"}</code>
      </div>

      {/* Split panes */}
      <div className="grid grid-cols-2 gap-4" style={{ minHeight: 650 }}>
        {/* Editor */}
        <div className="flex flex-col">
          <div className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">
            HTML Source
          </div>
          <textarea
            value={htmlBody}
            onChange={(e) => setHtml(e.target.value)}
            className="flex-1 w-full rounded-lg border border-gray-300 p-3 font-mono text-sm text-gray-800 focus:outline-none focus:ring-2 focus:ring-slate-400 resize-none"
            style={{ minHeight: 620 }}
            spellCheck={false}
          />
        </div>

        {/* Preview */}
        <div className="flex flex-col">
          <div className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">
            Live Preview
          </div>
          <div
            className="flex-1 rounded-lg border border-gray-300 bg-white p-6 overflow-auto shadow-inner"
            style={{ minHeight: 620 }}
            dangerouslySetInnerHTML={{ __html: previewHtml }}
          />
        </div>
      </div>
    </div>
  );
}
