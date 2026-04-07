"use client";

import { useState, useEffect, useCallback } from "react";
import type { ValidationIssue, ValidationResult } from "@/lib/swapValidation";

interface SheetValidationPanelProps {
  selectedWeek: string;
  onValidationComplete: (result: ValidationResult | null) => void;
}

export default function SheetValidationPanel({ selectedWeek, onValidationComplete }: SheetValidationPanelProps) {
  const [validating, setValidating] = useState(false);
  const [result, setResult] = useState<(ValidationResult & { row_count?: number }) | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expandErrors, setExpandErrors] = useState(true);
  const [expandWarnings, setExpandWarnings] = useState(false);

  const validate = useCallback(async (sheetName: string) => {
    if (!sheetName) {
      setResult(null);
      onValidationComplete(null);
      return;
    }

    setValidating(true);
    setError(null);
    try {
      const res = await fetch("/api/crew/validate-sheet", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sheet_name: sheetName }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      const data = await res.json();
      const validationResult: ValidationResult = {
        valid: data.valid,
        errors: data.errors ?? [],
        warnings: data.warnings ?? [],
      };
      setResult({ ...validationResult, row_count: data.row_count });
      onValidationComplete(validationResult);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Validation failed";
      setError(msg);
      onValidationComplete(null);
    } finally {
      setValidating(false);
    }
  }, [onValidationComplete]);

  useEffect(() => {
    validate(selectedWeek);
  }, [selectedWeek, validate]);

  if (!selectedWeek) return null;

  if (validating) {
    return (
      <div className="flex items-center gap-2 px-3 py-2 text-xs text-gray-500 bg-gray-50 rounded-lg border">
        <svg className="animate-spin h-3.5 w-3.5" viewBox="0 0 24 24">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
        Validating sheet data...
      </div>
    );
  }

  if (error) {
    return (
      <div className="px-3 py-2 text-xs text-red-700 bg-red-50 rounded-lg border border-red-200">
        Validation error: {error}
      </div>
    );
  }

  if (!result) return null;

  const { valid, errors, warnings } = result;

  // All clean — show compact success
  if (errors.length === 0 && warnings.length === 0) {
    return (
      <div className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-emerald-700 bg-emerald-50 rounded-lg border border-emerald-200">
        <span>✓</span>
        <span>Sheet validated — {result.row_count ?? "?"} rows, no issues found</span>
      </div>
    );
  }

  return (
    <div className={`rounded-lg border text-xs ${
      !valid ? "border-red-200 bg-red-50" : "border-amber-200 bg-amber-50"
    }`}>
      {/* Header */}
      <div className={`flex items-center justify-between px-3 py-2 ${
        !valid ? "text-red-800" : "text-amber-800"
      }`}>
        <div className="flex items-center gap-2">
          {!valid ? (
            <>
              <span className="font-semibold">⚠ {errors.length} error{errors.length !== 1 ? "s" : ""} must be fixed</span>
              {warnings.length > 0 && (
                <span className="text-amber-600">+ {warnings.length} warning{warnings.length !== 1 ? "s" : ""}</span>
              )}
            </>
          ) : (
            <span className="font-semibold">⚡ {warnings.length} warning{warnings.length !== 1 ? "s" : ""} — proceed with caution</span>
          )}
        </div>
        <span className="text-gray-500">{result.row_count ?? "?"} rows</span>
      </div>

      {/* Errors list */}
      {errors.length > 0 && (
        <div className="border-t border-red-200">
          <button
            onClick={() => setExpandErrors(!expandErrors)}
            className="w-full flex items-center justify-between px-3 py-1.5 text-red-700 hover:bg-red-100/50"
          >
            <span className="font-medium">Errors ({errors.length})</span>
            <span>{expandErrors ? "▾" : "▸"}</span>
          </button>
          {expandErrors && (
            <ul className="px-3 pb-2 space-y-1">
              {errors.map((issue, i) => (
                <IssueRow key={`e-${i}`} issue={issue} severity="error" />
              ))}
            </ul>
          )}
        </div>
      )}

      {/* Warnings list */}
      {warnings.length > 0 && (
        <div className={`border-t ${!valid ? "border-red-200" : "border-amber-200"}`}>
          <button
            onClick={() => setExpandWarnings(!expandWarnings)}
            className={`w-full flex items-center justify-between px-3 py-1.5 hover:bg-amber-100/50 ${
              !valid ? "text-amber-600" : "text-amber-700"
            }`}
          >
            <span className="font-medium">Warnings ({warnings.length})</span>
            <span>{expandWarnings ? "▾" : "▸"}</span>
          </button>
          {expandWarnings && (
            <ul className="px-3 pb-2 space-y-1">
              {warnings.map((issue, i) => (
                <IssueRow key={`w-${i}`} issue={issue} severity="warning" />
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function IssueRow({ issue, severity }: { issue: ValidationIssue; severity: "error" | "warning" }) {
  return (
    <li className={`flex items-start gap-1.5 ${severity === "error" ? "text-red-700" : "text-amber-700"}`}>
      <span className="mt-0.5 shrink-0">{severity === "error" ? "✕" : "△"}</span>
      <span>
        {issue.row && <span className="font-mono text-gray-500">Row {issue.row}: </span>}
        {issue.message}
      </span>
    </li>
  );
}
