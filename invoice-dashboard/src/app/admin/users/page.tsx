"use client";

import { useEffect, useState } from "react";

type UserRow = {
  id: string;
  email: string;
  role: string | null;
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
        <strong>Dashboard</strong> users see the operations dashboard.{" "}
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
              return (
                <tr key={user.id} className="border-t border-gray-100">
                  <td className="px-4 py-3 text-gray-800">{user.email}</td>
                  <td className="px-4 py-3">
                    <span className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-medium ${roleInfo.color}`}>
                      {roleInfo.label}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-gray-500">
                    {user.last_sign_in_at
                      ? new Date(user.last_sign_in_at).toLocaleDateString()
                      : "Never"}
                  </td>
                  <td className="px-4 py-3">
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
