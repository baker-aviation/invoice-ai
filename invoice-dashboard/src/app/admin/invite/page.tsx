"use client";

import { useState } from "react";

type InviteResult = { email: string; status: string; error?: string };

export default function InvitePage() {
  const [emailsText, setEmailsText] = useState("");
  const [results, setResults] = useState<InviteResult[]>([]);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const emails = emailsText
      .split(/[\n,]+/)
      .map((s) => s.trim())
      .filter(Boolean);

    if (emails.length === 0) return;

    setLoading(true);
    setResults([]);

    const res = await fetch("/api/admin/invite", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ emails }),
    });

    const data = await res.json();
    setResults(data.results ?? []);
    setLoading(false);
  }

  return (
    <div className="max-w-xl">
      <h1 className="text-2xl font-bold text-slate-900 mb-2">Invite Users</h1>
      <p className="text-sm text-gray-500 mb-6">
        Enter email addresses (one per line or comma-separated). Each person
        will receive an invite link to set their own password.
      </p>

      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <textarea
          value={emailsText}
          onChange={(e) => setEmailsText(e.target.value)}
          rows={6}
          placeholder={"alice@baker-aviation.com\nbob@baker-aviation.com"}
          className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-slate-500"
        />
        <button
          type="submit"
          disabled={loading}
          className="self-start bg-slate-900 text-white rounded-md px-5 py-2 text-sm font-medium hover:bg-slate-700 disabled:opacity-50"
        >
          {loading ? "Sending…" : "Send Invites"}
        </button>
      </form>

      {results.length > 0 && (
        <div className="mt-6 border border-gray-200 rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50">
              <tr>
                <th className="text-left px-4 py-2 font-medium text-gray-600">Email</th>
                <th className="text-left px-4 py-2 font-medium text-gray-600">Status</th>
              </tr>
            </thead>
            <tbody>
              {results.map((r) => (
                <tr key={r.email} className="border-t border-gray-100">
                  <td className="px-4 py-2 text-gray-800">{r.email}</td>
                  <td className="px-4 py-2">
                    {r.status === "sent" ? (
                      <span className="text-green-600 font-medium">Sent</span>
                    ) : (
                      <span className="text-red-600">{r.error ?? "Failed"}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
