"use client";

import { useState } from "react";
import Link from "next/link";
import type { PilotProfile, OnboardingItem } from "@/lib/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function InfoRow({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div className="flex justify-between py-2 border-b border-gray-100 last:border-0">
      <span className="text-sm text-gray-500">{label}</span>
      <span className="text-sm font-medium text-gray-900">{value || "—"}</span>
    </div>
  );
}

function Badge({ label, color }: { label: string; color: string }) {
  const map: Record<string, string> = {
    green: "bg-green-100 text-green-800",
    yellow: "bg-yellow-100 text-yellow-800",
    blue: "bg-blue-100 text-blue-800",
    gray: "bg-gray-100 text-gray-600",
  };
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${map[color] ?? map.gray}`}>
      {label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Checklist Item
// ---------------------------------------------------------------------------

function ChecklistItem({
  item,
  pilotId,
  onToggled,
}: {
  item: OnboardingItem;
  pilotId: number;
  onToggled: (updated: OnboardingItem, allComplete: boolean) => void;
}) {
  const [saving, setSaving] = useState(false);

  async function toggle() {
    setSaving(true);
    const res = await fetch(`/api/pilots/${pilotId}/onboarding/${item.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ completed: !item.completed }),
    });
    const data = await res.json();
    setSaving(false);
    if (data.ok) {
      onToggled(data.item, data.onboarding_complete);
    }
  }

  return (
    <div className="flex items-center gap-3 py-2 border-b border-gray-100 last:border-0">
      <button
        onClick={toggle}
        disabled={saving}
        className={`w-5 h-5 rounded border-2 flex items-center justify-center transition-colors flex-shrink-0 ${
          item.completed
            ? "bg-green-500 border-green-500 text-white"
            : "border-gray-300 hover:border-blue-400"
        } ${saving ? "opacity-50" : ""}`}
      >
        {item.completed && (
          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
          </svg>
        )}
      </button>
      <div className="flex-1 min-w-0">
        <span className={`text-sm ${item.completed ? "text-gray-400 line-through" : "text-gray-900"}`}>
          {item.item_label}
        </span>
        {item.required_for === "pic_only" && (
          <span className="ml-2 text-xs text-blue-500">(PIC only)</span>
        )}
      </div>
      {item.completed && item.completed_at && (
        <span className="text-xs text-gray-400 flex-shrink-0">
          {new Date(item.completed_at).toLocaleDateString()}
        </span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main Component
// ---------------------------------------------------------------------------

export default function PilotDetailClient({ pilot: initialPilot }: { pilot: PilotProfile }) {
  const [pilot, setPilot] = useState(initialPilot);
  const items = pilot.onboarding_items ?? [];
  const sicItems = items.filter((i) => i.required_for === "all");
  const picItems = items.filter((i) => i.required_for === "pic_only");

  function handleItemToggled(updated: OnboardingItem, allComplete: boolean) {
    setPilot((prev) => {
      const newItems = (prev.onboarding_items ?? []).map((i) =>
        i.id === updated.id ? updated : i,
      );
      const completed = newItems.filter((i) => i.completed).length;
      return {
        ...prev,
        onboarding_items: newItems,
        onboarding_complete: allComplete,
        available_to_fly: allComplete,
        onboarding_progress: { completed, total: newItems.length },
      };
    });
  }

  const prog = pilot.onboarding_progress ?? { completed: 0, total: 0 };
  const pct = prog.total === 0 ? 0 : Math.round((prog.completed / prog.total) * 100);

  return (
    <div className="p-4 sm:p-6 max-w-4xl">
      <Link href="/pilots" className="text-sm text-blue-600 hover:underline mb-4 inline-block">
        &larr; Back to Pilots
      </Link>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Profile Info */}
        <div className="bg-white rounded-xl border shadow-sm p-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-base font-semibold">Profile</h2>
            <div className="flex gap-2">
              <Badge label={pilot.role} color={pilot.role === "PIC" ? "blue" : "gray"} />
              {pilot.available_to_fly ? (
                <Badge label="Available" color="green" />
              ) : (
                <Badge label="Onboarding" color="yellow" />
              )}
            </div>
          </div>
          <InfoRow label="Email" value={pilot.email} />
          <InfoRow label="Phone" value={pilot.phone} />
          <InfoRow label="Employee ID" value={pilot.employee_id} />
          <InfoRow label="Hire Date" value={pilot.hire_date} />
          <InfoRow label="Home Airports" value={pilot.home_airports?.join(", ")} />
          <InfoRow label="Aircraft Types" value={pilot.aircraft_types?.join(", ")} />
          <InfoRow label="Medical Class" value={pilot.medical_class} />
          <InfoRow label="Medical Expiry" value={pilot.medical_expiry} />
          <InfoRow label="Passport Expiry" value={pilot.passport_expiry} />
        </div>

        {/* Onboarding Checklist */}
        <div className="bg-white rounded-xl border shadow-sm p-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-base font-semibold">Onboarding Checklist</h2>
            <span className="text-sm text-gray-500">{pct}% complete</span>
          </div>

          {/* Progress bar */}
          <div className="h-2 bg-gray-200 rounded-full overflow-hidden mb-4">
            <div
              className={`h-full rounded-full transition-all ${pct === 100 ? "bg-green-500" : "bg-blue-500"}`}
              style={{ width: `${pct}%` }}
            />
          </div>

          {/* SIC Items */}
          {sicItems.length > 0 && (
            <div className="mb-4">
              <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">
                Required (All Pilots)
              </h3>
              {sicItems.map((item) => (
                <ChecklistItem
                  key={item.id}
                  item={item}
                  pilotId={pilot.id}
                  onToggled={handleItemToggled}
                />
              ))}
            </div>
          )}

          {/* PIC-only Items */}
          {picItems.length > 0 && (
            <div>
              <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">
                PIC Only
              </h3>
              {picItems.map((item) => (
                <ChecklistItem
                  key={item.id}
                  item={item}
                  pilotId={pilot.id}
                  onToggled={handleItemToggled}
                />
              ))}
            </div>
          )}

          {items.length === 0 && (
            <div className="text-center text-gray-400 py-4">No onboarding items.</div>
          )}
        </div>
      </div>
    </div>
  );
}
