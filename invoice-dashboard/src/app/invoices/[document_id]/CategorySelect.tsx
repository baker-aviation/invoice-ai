"use client";

import { useState } from "react";
import { ALL_CATEGORIES, CATEGORY_COLORS, type InvoiceCategory } from "@/lib/invoiceCategory";

type Props = {
  documentId: string;
  invoiceId: string;
  currentCategory: InvoiceCategory;
  categoryOverride: string | null;
};

export default function CategorySelect({ documentId, invoiceId, currentCategory, categoryOverride }: Props) {
  const [value, setValue] = useState(categoryOverride ?? "");
  const [saving, setSaving] = useState(false);

  const displayCat = (value || currentCategory) as InvoiceCategory;
  const colorClass = CATEGORY_COLORS[displayCat] || CATEGORY_COLORS["Other"];

  async function handleChange(newValue: string) {
    setValue(newValue);
    setSaving(true);
    try {
      await fetch(`/api/invoices/${documentId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ category_override: newValue, invoice_id: invoiceId }),
      });
    } catch {
      // Revert on error
      setValue(categoryOverride ?? "");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="inline-flex items-center gap-1.5">
      <select
        value={value}
        onChange={(e) => handleChange(e.target.value)}
        disabled={saving}
        className={`rounded-full px-2 py-0.5 text-xs font-medium border-0 cursor-pointer appearance-none pr-5 ${colorClass} ${saving ? "opacity-50" : ""}`}
        style={{ backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='8' height='8' viewBox='0 0 8 8'%3E%3Cpath d='M0 2l4 4 4-4z' fill='%236b7280'/%3E%3C/svg%3E")`, backgroundRepeat: "no-repeat", backgroundPosition: "right 6px center" }}
      >
        <option value="">Auto: {currentCategory}</option>
        {ALL_CATEGORIES.map((cat) => (
          <option key={cat} value={cat}>{cat}</option>
        ))}
      </select>
    </div>
  );
}
