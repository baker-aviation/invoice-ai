"use client";

import { useEffect, useState } from "react";
import { SECTIONS, type SectionKey } from "@/lib/permissions";

type UserRow = {
  id: string;
  email: string;
  role: string | null;
  permissions: string[];
  created_at: string;
  last_sign_in_at: string | null;
};

const ROLES = ["admin", "dashboard", "pilot"] as const;

const ROLE_LABELS: Record<string, { label: string; color: string }> = {
  admin: { label: "Admin", color: "bg-purple-100 text-purple-800" },
  dashboard: { label: "Dashboard", color: "bg-slate-100 text-slate-800" },
  pilot: { label: "Pilot", color: "bg-blue-100 text-blue-800" },
};

export default function UsersPage() {
  const [users, setUsers] = useState<UserRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [updating, setUpdating] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [expandedUser, setExpandedUser] = useState<string | null>(null);

  async function fetchUsers() {
    setLoading(true);
    setError("");
    const res = await fetch("/api/admin/users");
    if (!res.ok) {
      setError("Failed to load users");
      setLoading(false);
      return;
    }
    const data = await res.json();
    setUsers(data.users ?? []);
    setLoading(false);
  }

  useEffect(() => {
    fetchUsers();
  }, []);

  async function handleRoleChange(userId: string, newRole: string) {
    setUpdating(userId);
    const res = await fetch("/api/admin/users", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId, role: newRole }),
    });

    if (res.ok) {
      setUsers((prev) =>
        prev.map((u) => (u.id === userId ? { ...u, role: newRole } : u))
      );
    } else {
      const data = await res.json();
      alert(data.error ?? "Failed to update role");
    }
    setUpdating(null);
  }

  async function handlePermissionToggle(userId: string, key: SectionKey, current: string[]) {
    const updated = current.includes(key)
      ? current.filter((k) => k !== key)
      : [...current, key];

    setUpdating(userId);
    const res = await fetch("/api/admin/users", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId, permissions: updated }),
    });

    if (res.ok) {
      setUsers((prev) =>
        prev.map((u) => (u.id === userId ? { ...u, permissions: updated } : u))
      );
    } else {
      const data = await res.json();
      alert(data.error ?? "Failed to update permissions");
    }
    setUpdating(null);
  }

  async function handleDelete(userId: string, email: string) {
    const confirmed = window.confirm(
      `Are you sure you want to delete ${email}? This cannot be undone.`
    );
    if (!confirmed) return;

    setDeleting(userId);
    const res = await fetch("/api/admin/users", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId }),
    });

    if (res.ok) {
      setUsers((prev) => prev.filter((u) => u.id !== userId));
    } else {
      const data = await res.json();
      alert(data.error ?? "Failed to delete user");
    }
    setDeleting(null);
  }

  if (loading) {
    return <p className="text-sm text-gray-500">Loading users...</p>;
  }

  if (error) {
    return <p className="text-sm text-red-600">{error}</p>;
  }

  return (
    <div>
      <p className="text-sm text-gray-500 mb-6">
        Manage user access. <strong>Admin</strong> users can access everything.{" "}
        <strong>Dashboard</strong> users see allowed sections (click row to configure).{" "}
        <strong>Pilot</strong> users access the pilot portal only.
      </p>

      <div className="border border-gray-200 rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50">
            <tr>
              <th className="text-left px-4 py-3 font-medium text-gray-600">Email</th>
              <th className="text-left px-4 py-3 font-medium text-gray-600">Role</th>
              <th className="text-left px-4 py-3 font-medium text-gray-600">Last Sign In</th>
              <th className="text-left px-4 py-3 font-medium text-gray-600">Actions</th>
            </tr>
          </thead>
          <tbody>
            {users.map((user) => {
              const roleInfo = ROLE_LABELS[user.role ?? ""] ?? {
                label: user.role ?? "No role",
                color: "bg-gray-100 text-gray-600",
              };
              const isExpanded = expandedUser === user.id;
              const isDashboard = user.role === "dashboard";
              return (
                <tr key={user.id} className="border-t border-gray-100 group">
                  <td className="px-4 py-3 align-top">
                    <div>
                      <button
                        type="button"
                        onClick={() => isDashboard && setExpandedUser(isExpanded ? null : user.id)}
                        className={`text-gray-800 text-left ${isDashboard ? "hover:text-slate-600 cursor-pointer" : ""}`}
                      >
                        {user.email}
                      </button>
                      {isDashboard && (
                        <p className="text-xs text-gray-400 mt-0.5">
                          {user.permissions.length === 0
                            ? "All sections"
                            : `${user.permissions.length} section${user.permissions.length === 1 ? "" : "s"}`}
                        </p>
                      )}
                    </div>
                    {isDashboard && isExpanded && (
                      <div className="mt-3 mb-1 p-3 bg-gray-50 rounded-lg border border-gray-200">
                        <p className="text-xs font-medium text-gray-600 mb-2">
                          Allowed sections {user.permissions.length === 0 && <span className="text-gray-400 font-normal">(none selected = all access)</span>}
                        </p>
                        <div className="grid grid-cols-3 gap-2">
                          {SECTIONS.map((section) => (
                            <label
                              key={section.key}
                              className="flex items-center gap-2 text-xs text-gray-700 cursor-pointer"
                            >
                              <input
                                type="checkbox"
                                checked={user.permissions.includes(section.key)}
                                onChange={() =>
                                  handlePermissionToggle(user.id, section.key, user.permissions)
                                }
                                disabled={updating === user.id}
                                className="rounded border-gray-300 text-slate-600 focus:ring-slate-500"
                              />
                              {section.label}
                            </label>
                          ))}
                        </div>
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-3 align-top">
                    <span className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-medium ${roleInfo.color}`}>
                      {roleInfo.label}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-gray-500 align-top">
                    {user.last_sign_in_at
                      ? new Date(user.last_sign_in_at).toLocaleDateString()
                      : "Never"}
                  </td>
                  <td className="px-4 py-3 align-top">
                    <div className="flex items-center gap-2">
                      <select
                        value={user.role ?? ""}
                        onChange={(e) => handleRoleChange(user.id, e.target.value)}
                        disabled={updating === user.id}
                        className="border border-gray-300 rounded-md px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-slate-500 disabled:opacity-50"
                      >
                        <option value="" disabled>
                          Select role
                        </option>
                        {ROLES.map((r) => (
                          <option key={r} value={r}>
                            {ROLE_LABELS[r].label}
                          </option>
                        ))}
                      </select>
                      <button
                        onClick={() => handleDelete(user.id, user.email)}
                        disabled={deleting === user.id}
                        className="text-red-500 hover:text-red-700 disabled:opacity-50 text-sm font-medium"
                        title="Delete user"
                      >
                        {deleting === user.id ? "…" : "Delete"}
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
