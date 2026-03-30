"use client";

import { useState, useCallback } from "react";
import type { AlertRule } from "@/lib/types";

type Props = { initialRules: AlertRule[] };

type EditingRule = {
  id: string;
  min_total: string;
  min_line_item_amount: string;
  min_handling_fee: string;
  min_service_fee: string;
  min_surcharge: string;
  min_risk_score: string;
  require_charged_line_items: boolean;
  keywords: string;
};

function numOrNull(s: string): number | null {
  const trimmed = s.trim();
  if (!trimmed) return null;
  const n = Number(trimmed);
  return isNaN(n) ? null : n;
}

function fmtNum(v: number | null): string {
  if (v == null) return "";
  return v.toLocaleString("en-US");
}

function fmtDate(s: string | null): string {
  if (!s) return "—";
  const d = new Date(s);
  if (isNaN(d.getTime())) return s;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export default function RulesTable({ initialRules }: Props) {
  const [rules, setRules] = useState(initialRules);
  const [editing, setEditing] = useState<EditingRule | null>(null);
  const [saving, setSaving] = useState(false);
  const [togglingId, setTogglingId] = useState<string | null>(null);

  const toggle = useCallback(async (rule: AlertRule) => {
    setTogglingId(rule.id);
    try {
      const res = await fetch(`/api/alerts/rules/${rule.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ is_enabled: !rule.is_enabled }),
      });
      if (res.ok) {
        setRules((prev) =>
          prev.map((r) => (r.id === rule.id ? { ...r, is_enabled: !r.is_enabled } : r))
        );
      }
    } finally {
      setTogglingId(null);
    }
  }, []);

  const startEdit = useCallback((rule: AlertRule) => {
    setEditing({
      id: rule.id,
      min_total: rule.min_total?.toString() ?? "",
      min_line_item_amount: rule.min_line_item_amount?.toString() ?? "",
      min_handling_fee: rule.min_handling_fee?.toString() ?? "",
      min_service_fee: rule.min_service_fee?.toString() ?? "",
      min_surcharge: rule.min_surcharge?.toString() ?? "",
      min_risk_score: rule.min_risk_score?.toString() ?? "",
      require_charged_line_items: rule.require_charged_line_items,
      keywords: (rule.keywords ?? []).join(", "),
    });
  }, []);

  const cancelEdit = useCallback(() => setEditing(null), []);

  const saveEdit = useCallback(async () => {
    if (!editing) return;
    setSaving(true);
    try {
      const payload = {
        min_total: numOrNull(editing.min_total),
        min_line_item_amount: numOrNull(editing.min_line_item_amount),
        min_handling_fee: numOrNull(editing.min_handling_fee),
        min_service_fee: numOrNull(editing.min_service_fee),
        min_surcharge: numOrNull(editing.min_surcharge),
        min_risk_score: numOrNull(editing.min_risk_score),
        require_charged_line_items: editing.require_charged_line_items,
        keywords: editing.keywords
          .split(",")
          .map((k) => k.trim())
          .filter(Boolean),
      };
      const res = await fetch(`/api/alerts/rules/${editing.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (res.ok) {
        const { rule } = await res.json();
        setRules((prev) =>
          prev.map((r) => (r.id === editing.id ? { ...r, ...rule } : r))
        );
        setEditing(null);
      }
    } finally {
      setSaving(false);
    }
  }, [editing]);

  const enabled = rules.filter((r) => r.is_enabled);
  const disabled = rules.filter((r) => !r.is_enabled);

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-gray-700">
          {rules.length} rule{rules.length !== 1 ? "s" : ""} ({enabled.length} active)
        </h3>
      </div>

      {/* Active rules */}
      <div className="space-y-2">
        {enabled.map((rule) => (
          <RuleCard
            key={rule.id}
            rule={rule}
            editing={editing?.id === rule.id ? editing : null}
            onToggle={() => toggle(rule)}
            onEdit={() => startEdit(rule)}
            onCancel={cancelEdit}
            onSave={saveEdit}
            onEditChange={setEditing}
            saving={saving}
            toggling={togglingId === rule.id}
          />
        ))}
      </div>

      {/* Disabled rules */}
      {disabled.length > 0 && (
        <DisabledSection
          rules={disabled}
          editing={editing}
          togglingId={togglingId}
          saving={saving}
          onToggle={toggle}
          onEdit={startEdit}
          onCancel={cancelEdit}
          onSave={saveEdit}
          onEditChange={setEditing}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function DisabledSection({
  rules,
  editing,
  togglingId,
  saving,
  onToggle,
  onEdit,
  onCancel,
  onSave,
  onEditChange,
}: {
  rules: AlertRule[];
  editing: EditingRule | null;
  togglingId: string | null;
  saving: boolean;
  onToggle: (r: AlertRule) => void;
  onEdit: (r: AlertRule) => void;
  onCancel: () => void;
  onSave: () => void;
  onEditChange: (e: EditingRule | null) => void;
}) {
  const [show, setShow] = useState(false);

  return (
    <div className="pt-4 border-t border-gray-200">
      <button
        onClick={() => setShow(!show)}
        className="text-sm text-gray-500 hover:text-gray-700 flex items-center gap-1"
      >
        <svg
          className={`w-3.5 h-3.5 transition-transform ${show ? "rotate-90" : ""}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
        </svg>
        Disabled ({rules.length})
      </button>
      {show && (
        <div className="space-y-2 mt-2">
          {rules.map((rule) => (
            <RuleCard
              key={rule.id}
              rule={rule}
              editing={editing?.id === rule.id ? editing : null}
              onToggle={() => onToggle(rule)}
              onEdit={() => onEdit(rule)}
              onCancel={onCancel}
              onSave={onSave}
              onEditChange={onEditChange}
              saving={saving}
              toggling={togglingId === rule.id}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function RuleCard({
  rule,
  editing,
  onToggle,
  onEdit,
  onCancel,
  onSave,
  onEditChange,
  saving,
  toggling,
}: {
  rule: AlertRule;
  editing: EditingRule | null;
  onToggle: () => void;
  onEdit: () => void;
  onCancel: () => void;
  onSave: () => void;
  onEditChange: (e: EditingRule | null) => void;
  saving: boolean;
  toggling: boolean;
}) {
  const isEditing = editing !== null;

  return (
    <div
      className={`rounded-lg border p-4 transition-colors ${
        rule.is_enabled ? "border-gray-200 bg-white" : "border-gray-200 bg-gray-50 opacity-60"
      }`}
    >
      {/* Header row */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          {/* Toggle */}
          <button
            onClick={onToggle}
            disabled={toggling}
            className={`relative w-9 h-5 rounded-full transition-colors shrink-0 ${
              rule.is_enabled ? "bg-green-500" : "bg-gray-300"
            } ${toggling ? "opacity-50" : ""}`}
          >
            <span
              className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${
                rule.is_enabled ? "translate-x-4" : ""
              }`}
            />
          </button>

          <div className="min-w-0">
            <span className="text-sm font-semibold text-gray-900 truncate block">{rule.name}</span>
            <div className="flex flex-wrap gap-1 mt-1">
              {(rule.keywords ?? []).map((kw) => (
                <span
                  key={kw}
                  className="text-[10px] px-1.5 py-0.5 rounded bg-blue-100 text-blue-700"
                >
                  {kw}
                </span>
              ))}
              {(rule.vendor_normalized_in ?? []).map((v) => (
                <span
                  key={v}
                  className="text-[10px] px-1.5 py-0.5 rounded bg-purple-100 text-purple-700"
                >
                  {v}
                </span>
              ))}
              {(rule.airport_code_in ?? []).map((a) => (
                <span
                  key={a}
                  className="text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-700"
                >
                  {a}
                </span>
              ))}
              {(rule.doc_type_in ?? []).map((d) => (
                <span
                  key={d}
                  className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-600"
                >
                  {d}
                </span>
              ))}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {!isEditing && (
            <button
              onClick={onEdit}
              className="text-xs text-gray-500 hover:text-gray-700 px-2 py-1 rounded hover:bg-gray-100"
            >
              Edit
            </button>
          )}
        </div>
      </div>

      {/* Threshold summary (read-only) */}
      {!isEditing && (
        <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-[11px] text-gray-500">
          {rule.min_total != null && <span>Min total: ${fmtNum(rule.min_total)}</span>}
          {rule.min_line_item_amount != null && (
            <span>Min line item: ${fmtNum(rule.min_line_item_amount)}</span>
          )}
          {rule.min_handling_fee != null && <span>Min handling: ${fmtNum(rule.min_handling_fee)}</span>}
          {rule.min_service_fee != null && <span>Min service: ${fmtNum(rule.min_service_fee)}</span>}
          {rule.min_surcharge != null && <span>Min surcharge: ${fmtNum(rule.min_surcharge)}</span>}
          {rule.min_risk_score != null && <span>Min risk: {rule.min_risk_score}</span>}
          {rule.require_charged_line_items && <span>Charged items only</span>}
          {rule.slack_channel_name && <span>#{rule.slack_channel_name}</span>}
          <span className="text-gray-400">Created {fmtDate(rule.created_at)}</span>
        </div>
      )}

      {/* Edit form */}
      {isEditing && editing && (
        <div className="mt-3 pt-3 border-t border-gray-100 space-y-3">
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            <Field
              label="Min Invoice Total"
              value={editing.min_total}
              onChange={(v) => onEditChange({ ...editing, min_total: v })}
              prefix="$"
            />
            <Field
              label="Min Line Item"
              value={editing.min_line_item_amount}
              onChange={(v) => onEditChange({ ...editing, min_line_item_amount: v })}
              prefix="$"
            />
            <Field
              label="Min Handling Fee"
              value={editing.min_handling_fee}
              onChange={(v) => onEditChange({ ...editing, min_handling_fee: v })}
              prefix="$"
            />
            <Field
              label="Min Service Fee"
              value={editing.min_service_fee}
              onChange={(v) => onEditChange({ ...editing, min_service_fee: v })}
              prefix="$"
            />
            <Field
              label="Min Surcharge"
              value={editing.min_surcharge}
              onChange={(v) => onEditChange({ ...editing, min_surcharge: v })}
              prefix="$"
            />
            <Field
              label="Min Risk Score"
              value={editing.min_risk_score}
              onChange={(v) => onEditChange({ ...editing, min_risk_score: v })}
            />
          </div>

          <div>
            <label className="block text-[11px] font-medium text-gray-500 mb-1">
              Keywords (comma-separated)
            </label>
            <input
              type="text"
              className="w-full text-xs border border-gray-300 rounded px-2 py-1.5"
              value={editing.keywords}
              onChange={(e) => onEditChange({ ...editing, keywords: e.target.value })}
            />
          </div>

          <label className="flex items-center gap-2 text-xs text-gray-600">
            <input
              type="checkbox"
              checked={editing.require_charged_line_items}
              onChange={(e) =>
                onEditChange({ ...editing, require_charged_line_items: e.target.checked })
              }
              className="rounded border-gray-300"
            />
            Require charged line items only
          </label>

          <div className="flex items-center gap-2 pt-1">
            <button
              onClick={onSave}
              disabled={saving}
              className="text-xs px-3 py-1.5 rounded bg-gray-900 text-white hover:bg-gray-800 disabled:opacity-50"
            >
              {saving ? "Saving..." : "Save"}
            </button>
            <button
              onClick={onCancel}
              className="text-xs px-3 py-1.5 rounded border border-gray-300 text-gray-600 hover:bg-gray-50"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function Field({
  label,
  value,
  onChange,
  prefix,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  prefix?: string;
}) {
  return (
    <div>
      <label className="block text-[11px] font-medium text-gray-500 mb-1">{label}</label>
      <div className="flex items-center">
        {prefix && <span className="text-xs text-gray-400 mr-1">{prefix}</span>}
        <input
          type="text"
          inputMode="decimal"
          className="w-full text-xs border border-gray-300 rounded px-2 py-1.5"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="—"
        />
      </div>
    </div>
  );
}
