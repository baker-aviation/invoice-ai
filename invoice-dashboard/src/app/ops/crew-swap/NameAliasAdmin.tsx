"use client";

import { useState, useEffect, useCallback } from "react";

type AliasEntry = {
  id: string;
  crew_member_id: string;
  source: string;
  alias_name: string;
  normalized_name: string;
  confirmed: boolean;
  created_at: string;
};

type CrewAliasGroup = {
  crew_member: { id: string; name: string; role: string };
  aliases: AliasEntry[];
};

interface NameAliasAdminProps {
  onClose: () => void;
}

export default function NameAliasAdmin({ onClose }: NameAliasAdminProps) {
  const [groups, setGroups] = useState<CrewAliasGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [adding, setAdding] = useState<{ crewId: string; source: string; name: string } | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  const loadAliases = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/crew/name-aliases");
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      setGroups(data.aliases ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load aliases");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadAliases(); }, [loadAliases]);

  const addAlias = async (crewMemberId: string, source: string, aliasName: string) => {
    try {
      const res = await fetch("/api/crew/name-aliases", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ crew_member_id: crewMemberId, source, alias_name: aliasName }),
      });
      if (!res.ok) throw new Error(await res.text());
      setAdding(null);
      loadAliases();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to add alias");
    }
  };

  const deleteAlias = async (id: string) => {
    setDeleting(id);
    try {
      const res = await fetch("/api/crew/name-aliases", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      if (!res.ok) throw new Error(await res.text());
      loadAliases();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to delete alias");
    } finally {
      setDeleting(null);
    }
  };

  const filtered = filter
    ? groups.filter((g) =>
        g.crew_member.name.toLowerCase().includes(filter.toLowerCase()) ||
        g.aliases.some((a) => a.alias_name.toLowerCase().includes(filter.toLowerCase()))
      )
    : groups;

  // Only show crew members that have at least one alias or filter is active
  const displayed = filter ? filtered : filtered.filter((g) => g.aliases.length > 0);

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-2xl max-w-4xl w-full max-h-[85vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b">
          <div>
            <h2 className="text-sm font-semibold text-gray-900">Name Alias Manager</h2>
            <p className="text-xs text-gray-500 mt-0.5">Map crew names across Sheet, JetInsight, and Slack</p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-lg">✕</button>
        </div>

        {/* Search */}
        <div className="px-5 py-2 border-b">
          <input
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Search crew names or aliases..."
            className="w-full text-xs border rounded-lg px-3 py-1.5 bg-gray-50"
          />
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-5 py-3">
          {loading ? (
            <div className="text-xs text-gray-500 text-center py-8">Loading aliases...</div>
          ) : error ? (
            <div className="text-xs text-red-600 text-center py-4">{error}</div>
          ) : displayed.length === 0 ? (
            <div className="text-xs text-gray-500 text-center py-8">
              {filter ? "No matches found" : "No aliases configured yet"}
            </div>
          ) : (
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-gray-500 border-b">
                  <th className="pb-2 font-medium w-[180px]">Crew Member</th>
                  <th className="pb-2 font-medium">Sheet Names</th>
                  <th className="pb-2 font-medium">JetInsight Names</th>
                  <th className="pb-2 font-medium">Slack Names</th>
                  <th className="pb-2 font-medium w-[60px]"></th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {displayed.map((g) => {
                  const sheetAliases = g.aliases.filter((a) => a.source === "sheet");
                  const jiAliases = g.aliases.filter((a) => a.source === "jetinsight");
                  const slackAliases = g.aliases.filter((a) => a.source === "slack");

                  return (
                    <tr key={g.crew_member.id} className="hover:bg-gray-50">
                      <td className="py-2 pr-3">
                        <div className="font-medium text-gray-900">{g.crew_member.name}</div>
                        <div className="text-gray-400">{g.crew_member.role}</div>
                      </td>
                      <td className="py-2 pr-3">
                        <AliasCell
                          aliases={sheetAliases}
                          onDelete={deleteAlias}
                          deleting={deleting}
                          onAdd={() => setAdding({ crewId: g.crew_member.id, source: "sheet", name: "" })}
                        />
                      </td>
                      <td className="py-2 pr-3">
                        <AliasCell
                          aliases={jiAliases}
                          onDelete={deleteAlias}
                          deleting={deleting}
                          onAdd={() => setAdding({ crewId: g.crew_member.id, source: "jetinsight", name: "" })}
                        />
                      </td>
                      <td className="py-2 pr-3">
                        <AliasCell
                          aliases={slackAliases}
                          onDelete={deleteAlias}
                          deleting={deleting}
                          onAdd={() => setAdding({ crewId: g.crew_member.id, source: "slack", name: "" })}
                        />
                      </td>
                      <td className="py-2">
                        <button
                          onClick={() => setAdding({ crewId: g.crew_member.id, source: "manual", name: "" })}
                          className="text-blue-600 hover:text-blue-800"
                          title="Add alias"
                        >
                          +
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        {/* Add alias modal */}
        {adding && (
          <div className="border-t px-5 py-3 bg-gray-50 flex items-center gap-3">
            <span className="text-xs text-gray-600">Add alias:</span>
            <select
              value={adding.source}
              onChange={(e) => setAdding({ ...adding, source: e.target.value })}
              className="text-xs border rounded px-2 py-1"
            >
              <option value="sheet">Sheet</option>
              <option value="jetinsight">JetInsight</option>
              <option value="slack">Slack</option>
              <option value="manual">Manual</option>
            </select>
            <input
              type="text"
              value={adding.name}
              onChange={(e) => setAdding({ ...adding, name: e.target.value })}
              placeholder="Name as it appears..."
              className="flex-1 text-xs border rounded px-2 py-1"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter" && adding.name.trim()) {
                  addAlias(adding.crewId, adding.source, adding.name.trim());
                }
                if (e.key === "Escape") setAdding(null);
              }}
            />
            <button
              onClick={() => adding.name.trim() && addAlias(adding.crewId, adding.source, adding.name.trim())}
              disabled={!adding.name.trim()}
              className="px-3 py-1 text-xs font-medium bg-blue-600 text-white rounded hover:bg-blue-700 disabled:bg-gray-300"
            >
              Save
            </button>
            <button
              onClick={() => setAdding(null)}
              className="px-2 py-1 text-xs text-gray-500 hover:text-gray-700"
            >
              Cancel
            </button>
          </div>
        )}

        {/* Footer */}
        <div className="px-5 py-2 border-t text-xs text-gray-400 flex justify-between">
          <span>{groups.length} crew members, {groups.reduce((n, g) => n + g.aliases.length, 0)} aliases</span>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-700">Close</button>
        </div>
      </div>
    </div>
  );
}

function AliasCell({
  aliases,
  onDelete,
  deleting,
  onAdd,
}: {
  aliases: { id: string; alias_name: string; confirmed: boolean }[];
  onDelete: (id: string) => void;
  deleting: string | null;
  onAdd: () => void;
}) {
  if (aliases.length === 0) {
    return (
      <button onClick={onAdd} className="text-gray-300 hover:text-blue-500 italic">
        + add
      </button>
    );
  }
  return (
    <div className="flex flex-wrap gap-1">
      {aliases.map((a) => (
        <span
          key={a.id}
          className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] ${
            a.confirmed ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700"
          }`}
        >
          {a.alias_name}
          <button
            onClick={() => onDelete(a.id)}
            disabled={deleting === a.id}
            className="text-gray-400 hover:text-red-500 ml-0.5"
          >
            ×
          </button>
        </span>
      ))}
      <button onClick={onAdd} className="text-gray-300 hover:text-blue-500 text-[10px]">+</button>
    </div>
  );
}
