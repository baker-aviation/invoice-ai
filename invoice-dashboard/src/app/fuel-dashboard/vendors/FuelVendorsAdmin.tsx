"use client";

import React, { useState, useEffect, useCallback } from "react";

type FuelVendor = {
  id: number;
  name: string;
  slug: string;
  contact_email: string | null;
  release_type: "email" | "card" | "api";
  is_international: boolean;
  requires_destination: boolean;
  notes: string | null;
  active: boolean;
  created_at: string;
  updated_at: string;
};

type ReleaseType = "email" | "card" | "api";

const EMPTY_FORM: {
  name: string;
  slug: string;
  contact_email: string;
  release_type: ReleaseType;
  is_international: boolean;
  requires_destination: boolean;
  notes: string;
} = {
  name: "",
  slug: "",
  contact_email: "",
  release_type: "email",
  is_international: false,
  requires_destination: false,
  notes: "",
};

const RELEASE_TYPE_LABELS: Record<string, string> = {
  email: "Email",
  card: "Physical Card",
  api: "API",
};

const RELEASE_TYPE_COLORS: Record<string, string> = {
  email: "bg-blue-100 text-blue-700",
  card: "bg-amber-100 text-amber-700",
  api: "bg-green-100 text-green-700",
};

export default function FuelVendorsAdmin() {
  const [vendors, setVendors] = useState<FuelVendor[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [seeding, setSeeding] = useState(false);

  const fetchVendors = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/fuel-vendors");
      if (!res.ok) throw new Error("Failed to fetch vendors");
      const json = await res.json();
      setVendors(json.vendors ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load vendors");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchVendors(); }, [fetchVendors]);

  const clearMessages = () => { setError(""); setSuccess(""); };

  const handleSeed = async () => {
    clearMessages();
    setSeeding(true);
    try {
      const res = await fetch("/api/admin/fuel-vendors/seed", { method: "POST" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Seed failed");
      setSuccess(`Seeded ${json.count} vendors`);
      fetchVendors();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Seed failed");
    } finally {
      setSeeding(false);
    }
  };

  const autoSlug = (name: string) =>
    name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    clearMessages();

    const payload = {
      ...form,
      contact_email: form.contact_email || null,
      notes: form.notes || null,
      ...(editingId ? { id: editingId } : {}),
    };

    try {
      const res = await fetch("/api/admin/fuel-vendors", {
        method: editingId ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Save failed");
      setSuccess(editingId ? "Vendor updated" : "Vendor created");
      setShowForm(false);
      setEditingId(null);
      setForm(EMPTY_FORM);
      fetchVendors();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    }
  };

  const handleEdit = (v: FuelVendor) => {
    clearMessages();
    setForm({
      name: v.name,
      slug: v.slug,
      contact_email: v.contact_email ?? "",
      release_type: v.release_type,
      is_international: v.is_international,
      requires_destination: v.requires_destination,
      notes: v.notes ?? "",
    });
    setEditingId(v.id);
    setShowForm(true);
  };

  const handleDelete = async (v: FuelVendor) => {
    if (!confirm(`Delete "${v.name}"? This cannot be undone.`)) return;
    clearMessages();
    try {
      const res = await fetch("/api/admin/fuel-vendors", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: v.id }),
      });
      if (!res.ok) {
        const json = await res.json();
        throw new Error(json.error || "Delete failed");
      }
      setSuccess(`Deleted "${v.name}"`);
      fetchVendors();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed");
    }
  };

  const handleToggleActive = async (v: FuelVendor) => {
    clearMessages();
    try {
      const res = await fetch("/api/admin/fuel-vendors", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: v.id, active: !v.active }),
      });
      if (!res.ok) {
        const json = await res.json();
        throw new Error(json.error || "Update failed");
      }
      fetchVendors();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Toggle failed");
    }
  };

  const domesticVendors = vendors.filter((v) => !v.is_international);
  const intlVendors = vendors.filter((v) => v.is_international);

  if (loading) {
    return (
      <div className="max-w-5xl mx-auto">
        <h1 className="text-2xl font-bold text-slate-900 mb-6">Fuel Vendors</h1>
        <div className="text-gray-500">Loading...</div>
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Fuel Vendors</h1>
          <p className="text-sm text-gray-500 mt-1">
            Manage fuel vendors and their release methods
          </p>
        </div>
        <div className="flex gap-2">
          {vendors.length === 0 && (
            <button
              onClick={handleSeed}
              disabled={seeding}
              className="px-4 py-2 text-sm font-medium rounded-md bg-amber-500 text-white hover:bg-amber-600 disabled:opacity-50"
            >
              {seeding ? "Seeding..." : "Seed Default Vendors"}
            </button>
          )}
          <button
            onClick={() => {
              clearMessages();
              setForm(EMPTY_FORM);
              setEditingId(null);
              setShowForm(!showForm);
            }}
            className="px-4 py-2 text-sm font-medium rounded-md bg-slate-900 text-white hover:bg-slate-700"
          >
            {showForm ? "Cancel" : "+ Add Vendor"}
          </button>
        </div>
      </div>

      {error && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
          {error}
        </div>
      )}
      {success && (
        <div className="mb-4 p-3 bg-green-50 border border-green-200 rounded-lg text-green-700 text-sm">
          {success}
        </div>
      )}

      {/* Add / Edit Form */}
      {showForm && (
        <form onSubmit={handleSubmit} className="mb-6 p-4 bg-gray-50 border border-gray-200 rounded-lg space-y-4">
          <h3 className="font-semibold text-slate-900">
            {editingId ? "Edit Vendor" : "Add New Vendor"}
          </h3>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Name</label>
              <input
                type="text"
                value={form.name}
                onChange={(e) => {
                  const name = e.target.value;
                  setForm((f) => ({
                    ...f,
                    name,
                    ...(editingId ? {} : { slug: autoSlug(name) }),
                  }));
                }}
                className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-500"
                required
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Slug</label>
              <input
                type="text"
                value={form.slug}
                onChange={(e) => setForm((f) => ({ ...f, slug: e.target.value }))}
                className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-500 font-mono"
                required
                pattern="[a-z0-9-]+"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Contact Email</label>
              <input
                type="email"
                value={form.contact_email}
                onChange={(e) => setForm((f) => ({ ...f, contact_email: e.target.value }))}
                className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-500"
                placeholder="dispatch@vendor.com"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Release Type</label>
              <select
                value={form.release_type}
                onChange={(e) => setForm((f) => ({ ...f, release_type: e.target.value as "email" | "card" | "api" }))}
                className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-500"
              >
                <option value="email">Email</option>
                <option value="card">Physical Card</option>
                <option value="api">API</option>
              </select>
            </div>
          </div>
          <div className="flex gap-6">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={form.is_international}
                onChange={(e) => setForm((f) => ({ ...f, is_international: e.target.checked }))}
                className="rounded border-gray-300"
              />
              International
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={form.requires_destination}
                onChange={(e) => setForm((f) => ({ ...f, requires_destination: e.target.checked }))}
                className="rounded border-gray-300"
              />
              Requires Destination
            </label>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Notes</label>
            <input
              type="text"
              value={form.notes}
              onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
              className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-500"
              placeholder="Optional notes..."
            />
          </div>
          <div className="flex gap-2">
            <button
              type="submit"
              className="px-5 py-2 text-sm font-medium rounded-md bg-slate-900 text-white hover:bg-slate-700"
            >
              {editingId ? "Update Vendor" : "Create Vendor"}
            </button>
            <button
              type="button"
              onClick={() => { setShowForm(false); setEditingId(null); setForm(EMPTY_FORM); }}
              className="px-5 py-2 text-sm font-medium rounded-md bg-gray-200 text-gray-700 hover:bg-gray-300"
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {/* Domestic Vendors */}
      <VendorTable
        title="Domestic Fuel Releases"
        vendors={domesticVendors}
        onEdit={handleEdit}
        onDelete={handleDelete}
        onToggleActive={handleToggleActive}
      />

      {/* International Vendors */}
      <div className="mt-8">
        <VendorTable
          title="International Releases"
          vendors={intlVendors}
          onEdit={handleEdit}
          onDelete={handleDelete}
          onToggleActive={handleToggleActive}
        />
      </div>

      {vendors.length === 0 && (
        <div className="text-center py-12 text-gray-500">
          <p className="text-lg font-medium">No fuel vendors configured</p>
          <p className="text-sm mt-1">Click &quot;Seed Default Vendors&quot; to load the standard vendor list</p>
        </div>
      )}
    </div>
  );
}

function VendorTable({
  title,
  vendors,
  onEdit,
  onDelete,
  onToggleActive,
}: {
  title: string;
  vendors: FuelVendor[];
  onEdit: (v: FuelVendor) => void;
  onDelete: (v: FuelVendor) => void;
  onToggleActive: (v: FuelVendor) => void;
}) {
  if (vendors.length === 0) return null;

  return (
    <div>
      <h2 className="text-lg font-semibold text-slate-900 mb-3">{title}</h2>
      <div className="border border-gray-200 rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50">
            <tr>
              <th className="text-left px-4 py-3 font-medium text-gray-600">Vendor</th>
              <th className="text-left px-4 py-3 font-medium text-gray-600">Contact Email</th>
              <th className="text-left px-4 py-3 font-medium text-gray-600">Type</th>
              <th className="text-left px-4 py-3 font-medium text-gray-600">Flags</th>
              <th className="text-left px-4 py-3 font-medium text-gray-600">Notes</th>
              <th className="text-right px-4 py-3 font-medium text-gray-600">Actions</th>
            </tr>
          </thead>
          <tbody>
            {vendors.map((v) => (
              <tr
                key={v.id}
                className={`border-t border-gray-100 ${!v.active ? "opacity-50" : ""}`}
              >
                <td className="px-4 py-3 font-medium text-slate-900">
                  {v.name}
                  <span className="ml-2 text-xs text-gray-400 font-mono">{v.slug}</span>
                </td>
                <td className="px-4 py-3 text-gray-600 font-mono text-xs">
                  {v.contact_email ?? "—"}
                </td>
                <td className="px-4 py-3">
                  <span className={`inline-block px-2.5 py-0.5 text-xs font-medium rounded-full ${RELEASE_TYPE_COLORS[v.release_type] ?? "bg-gray-100 text-gray-600"}`}>
                    {RELEASE_TYPE_LABELS[v.release_type] ?? v.release_type}
                  </span>
                </td>
                <td className="px-4 py-3">
                  <div className="flex gap-1.5">
                    {v.requires_destination && (
                      <span className="inline-block px-2 py-0.5 text-xs font-medium rounded-full bg-purple-100 text-purple-700">
                        Dest Required
                      </span>
                    )}
                  </div>
                </td>
                <td className="px-4 py-3 text-gray-500 text-xs max-w-[200px] truncate">
                  {v.notes ?? "—"}
                </td>
                <td className="px-4 py-3 text-right">
                  <div className="flex justify-end gap-2">
                    <button
                      onClick={() => onToggleActive(v)}
                      className={`text-xs px-2 py-1 rounded ${v.active ? "text-gray-500 hover:text-red-600" : "text-green-600 hover:text-green-700"}`}
                    >
                      {v.active ? "Disable" : "Enable"}
                    </button>
                    <button
                      onClick={() => onEdit(v)}
                      className="text-xs px-2 py-1 rounded text-blue-600 hover:text-blue-700"
                    >
                      Edit
                    </button>
                    <button
                      onClick={() => onDelete(v)}
                      className="text-xs px-2 py-1 rounded text-red-500 hover:text-red-700"
                    >
                      Delete
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
