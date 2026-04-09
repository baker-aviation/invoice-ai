"use client";

import { Fragment, useCallback, useEffect, useState } from "react";

// ─── Types ───────────────────────────────────────────────────────────────────

type FboTarget = {
  id: number;
  airport_code: string;
  fbo_name: string;
  email: string;
  facility_fee: number | null;
  jet_a_price: number | null;
  source: string;
};

type FeeRequest = {
  id: number;
  airport_code: string;
  fbo_name: string;
  fbo_email: string;
  status: string;
  sent_at: string | null;
  reply_received_at: string | null;
  parsed_at: string | null;
  parse_confidence: string;
  batch_id: string;
  reply_body: string | null;
  reply_from: string | null;
};

type PreviewData = {
  subject: string;
  html: string;
  plainText: string;
};

type DirectFee = {
  id: number;
  airport_code: string;
  fbo_name: string;
  aircraft_type: string;
  jet_a_price: number | null;
  facility_fee: number | null;
  gallons_to_waive: number | null;
  security_fee: number | null;
  overnight_fee: number | null;
  hangar_fee: number | null;
  gpu_fee: number | null;
  lavatory_fee: number | null;
  deice_fee: number | null;
  afterhours_fee: number | null;
  callout_fee: number | null;
  ramp_fee: number | null;
  landing_fee: number | null;
  parking_info: string | null;
  confidence: string | null;
};

const FEE_FIELDS: { key: keyof DirectFee; label: string }[] = [
  { key: "jet_a_price", label: "Jet-A Price" },
  { key: "facility_fee", label: "Facility Fee" },
  { key: "gallons_to_waive", label: "Gal. to Waive" },
  { key: "security_fee", label: "Security" },
  { key: "overnight_fee", label: "Overnight" },
  { key: "hangar_fee", label: "Hangar" },
  { key: "gpu_fee", label: "GPU" },
  { key: "lavatory_fee", label: "Lavatory" },
  { key: "deice_fee", label: "De-ice" },
  { key: "landing_fee", label: "Landing" },
  { key: "afterhours_fee", label: "After Hours" },
  { key: "callout_fee", label: "Callout" },
];

function FeeEditor({ requestId, airportCode, fboName, replyBody, replyFrom, replyDate }: {
  requestId: number;
  airportCode: string;
  fboName: string;
  replyBody: string;
  replyFrom: string;
  replyDate: string;
}) {
  const [fees, setFees] = useState<DirectFee[]>([]);
  const [edits, setEdits] = useState<Record<string, Record<string, string>>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [loadingFees, setLoadingFees] = useState(true);

  useEffect(() => {
    setLoadingFees(true);
    fetch(`/api/fbo-fees/direct-fees?airport_code=${airportCode}&fbo_name=${encodeURIComponent(fboName)}`)
      .then((r) => r.json())
      .then((d) => { setFees(d.fees || []); setLoadingFees(false); })
      .catch(() => setLoadingFees(false));
  }, [airportCode, fboName]);

  const updateField = (acType: string, field: string, value: string) => {
    setEdits((prev) => ({
      ...prev,
      [acType]: { ...prev[acType], [field]: value },
    }));
  };

  const saveFees = async (acType: string) => {
    const changed = edits[acType];
    if (!changed || Object.keys(changed).length === 0) return;

    setSaving(acType);
    const feeUpdates: Record<string, number | null> = {};
    for (const [k, v] of Object.entries(changed)) {
      feeUpdates[k] = v === "" ? null : Number(v);
    }

    try {
      const res = await fetch("/api/fbo-fees/direct-fees", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          airport_code: airportCode,
          fbo_name: fboName,
          aircraft_type: acType,
          fees: feeUpdates,
        }),
      });
      if (res.ok) {
        const data = await res.json();
        setFees((prev) => prev.map((f) => (f.aircraft_type === acType ? data.updated : f)));
        setEdits((prev) => { const n = { ...prev }; delete n[acType]; return n; });
      }
    } catch { /* */ }
    finally { setSaving(null); }
  };

  // Format email body into readable paragraphs
  const formatEmail = (text: string) => {
    return text
      .replace(/\s{2,}/g, "\n")
      .replace(/([.!?])\s+/g, "$1\n")
      .split("\n")
      .filter((l) => l.trim())
      .join("\n\n");
  };

  return (
    <div className="grid grid-cols-2 gap-4 p-4 bg-gray-50">
      {/* Left: Email */}
      <div className="rounded-lg border border-gray-200 bg-white p-4 max-h-[400px] overflow-y-auto">
        <div className="flex items-center justify-between mb-3">
          <span className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide">Email Reply</span>
          <span className="text-[10px] text-gray-400">
            {replyFrom} &middot; {new Date(replyDate).toLocaleDateString()}
          </span>
        </div>
        <div className="text-xs text-gray-700 leading-relaxed whitespace-pre-wrap">
          {formatEmail(replyBody)}
        </div>
      </div>

      {/* Right: Fee fields */}
      <div className="rounded-lg border border-gray-200 bg-white p-4 max-h-[400px] overflow-y-auto">
        <span className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide">Parsed Fees</span>
        {loadingFees ? (
          <div className="text-xs text-gray-400 mt-3">Loading fees...</div>
        ) : fees.length === 0 ? (
          <div className="text-xs text-gray-400 mt-3">No parsed fees yet. Run the cron to parse this reply.</div>
        ) : (
          fees.map((fee) => (
            <div key={fee.aircraft_type} className="mt-3">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-bold text-gray-800">{fee.aircraft_type}</span>
                <div className="flex items-center gap-2">
                  {fee.confidence && (
                    <span className={`text-[9px] px-1.5 py-0.5 rounded-full ${
                      fee.confidence === "confirmed" ? "bg-green-100 text-green-700" : "bg-amber-100 text-amber-700"
                    }`}>
                      {fee.confidence}
                    </span>
                  )}
                  {edits[fee.aircraft_type] && Object.keys(edits[fee.aircraft_type]).length > 0 && (
                    <button
                      type="button"
                      onClick={() => saveFees(fee.aircraft_type)}
                      disabled={saving === fee.aircraft_type}
                      className="text-[10px] px-2 py-0.5 rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
                    >
                      {saving === fee.aircraft_type ? "Saving..." : "Save"}
                    </button>
                  )}
                </div>
              </div>
              <div className="grid grid-cols-3 gap-x-3 gap-y-1.5">
                {FEE_FIELDS.map(({ key, label }) => {
                  const editVal = edits[fee.aircraft_type]?.[key];
                  const currentVal = editVal !== undefined ? editVal : (fee[key] != null ? String(fee[key]) : "");
                  const isEdited = editVal !== undefined && editVal !== (fee[key] != null ? String(fee[key]) : "");
                  return (
                    <div key={key}>
                      <label className="text-[9px] text-gray-400 block">{label}</label>
                      <input
                        type="text"
                        value={currentVal}
                        onChange={(e) => updateField(fee.aircraft_type, key, e.target.value)}
                        className={`w-full text-xs px-1.5 py-1 rounded border ${
                          isEdited ? "border-blue-400 bg-blue-50" : "border-gray-200"
                        } focus:outline-none focus:border-blue-500`}
                      />
                    </div>
                  );
                })}
              </div>
              {fee.parking_info && (
                <div className="mt-2 text-[10px] text-gray-500">
                  <span className="font-medium">Parking:</span> {fee.parking_info}
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function FboOutreachPage() {
  const [targets, setTargets] = useState<FboTarget[]>([]);
  const [requests, setRequests] = useState<FeeRequest[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [preview, setPreview] = useState<PreviewData | null>(null);
  const [previewTarget, setPreviewTarget] = useState<FboTarget | null>(null);
  const [expandedReply, setExpandedReply] = useState<number | null>(null);
  const [filter, setFilter] = useState<"all" | "has_email" | "no_direct">("no_direct");
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 350);
    return () => clearTimeout(t);
  }, [search]);

  // Fetch FBOs with email that haven't been emailed yet
  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ limit: "200", hasEmail: "true" });
      if (debouncedSearch) params.set("search", debouncedSearch);
      const [profilesRes, requestsRes] = await Promise.all([
        fetch(`/api/fbo-profiles?${params}`),
        fetch("/api/fbo-fees/outreach-status"),
      ]);
      const profilesData = await profilesRes.json();
      const requestsData = requestsRes.ok ? await requestsRes.json() : { requests: [] };

      // Deduplicate profiles by airport+fbo (keep one per fbo, not per aircraft type)
      const seen = new Set<string>();
      const deduped: FboTarget[] = [];
      for (const p of profilesData.profiles || []) {
        const key = `${p.airport_code}|${p.fbo_name}`;
        if (seen.has(key) || !p.email) continue;
        seen.add(key);
        deduped.push(p);
      }

      setTargets(deduped);
      setRequests(requestsData.requests || []);
    } catch { /* */ }
    finally { setLoading(false); }
  }, [debouncedSearch]);

  useEffect(() => { fetchData(); }, [fetchData]);

  // Filter targets
  const requestedSet = new Set(requests.map((r) => `${r.airport_code}|${r.fbo_name}`));
  const filteredTargets = targets.filter((t) => {
    const key = `${t.airport_code}|${t.fbo_name}`;
    if (filter === "no_direct") return !requestedSet.has(key);
    if (filter === "has_email") return !!t.email;
    return true;
  });

  const toggleSelect = (key: string) => {
    setSelected((prev) => {
      const n = new Set(prev);
      n.has(key) ? n.delete(key) : n.add(key);
      return n;
    });
  };

  const selectAll = () => {
    if (selected.size === filteredTargets.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(filteredTargets.map((t) => `${t.airport_code}|${t.fbo_name}|${t.email}`)));
    }
  };

  // Preview email
  const showPreview = async (t: FboTarget) => {
    setPreviewTarget(t);
    const res = await fetch(
      `/api/fbo-fees/send-request?airport_code=${t.airport_code}&fbo_name=${encodeURIComponent(t.fbo_name)}&fbo_email=${encodeURIComponent(t.email)}`,
    );
    setPreview(await res.json());
  };

  // Send batch (dry run for now)
  const sendBatch = async (dryRun: boolean) => {
    if (selected.size === 0) return;
    setSending(true);

    const targets = [...selected].map((key) => {
      const [airport_code, fbo_name, fbo_email] = key.split("|");
      return { airport_code, fbo_name, fbo_email };
    });

    try {
      const res = await fetch("/api/fbo-fees/send-request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targets, dryRun }),
      });
      const data = await res.json();
      if (data.ok) {
        alert(
          dryRun
            ? `${data.count} drafts created (batch: ${data.batchId})`
            : `${data.sent} emails sent, ${data.failed} failed`,
        );
        setSelected(new Set());
        fetchData();
      } else {
        alert(`Error: ${data.error}`);
      }
    } catch {
      alert("Failed to send");
    } finally {
      setSending(false);
    }
  };

  // Status badge
  const statusBadge = (status: string) => {
    const colors: Record<string, string> = {
      draft: "bg-gray-100 text-gray-600",
      sent: "bg-blue-100 text-blue-700",
      replied: "bg-amber-100 text-amber-700",
      parsed: "bg-green-100 text-green-700",
      failed: "bg-red-100 text-red-700",
      no_reply: "bg-gray-100 text-gray-500",
    };
    return (
      <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${colors[status] || "bg-gray-100"}`}>
        {status}
      </span>
    );
  };

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-bold">FBO Fee Outreach</h2>
          <p className="text-xs text-gray-500">
            Send fee schedule requests to FBOs. Replies are auto-parsed into the database.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={async () => {
              if (!confirm("Queue ALL FBOs with email as drafts? You can then send them from the terminal script.")) return;
              setSending(true);
              try {
                const res = await fetch("/api/fbo-fees/queue-all", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
                const data = await res.json();
                if (data.ok) {
                  alert(`${data.queued} FBOs queued as drafts (batch: ${data.batchId}).\nSkipped ${data.skippedAlreadySent} already sent.\n\nRun from terminal:\nnode --experimental-strip-types scripts/send-fbo-fee-requests.mts`);
                  fetchData();
                } else {
                  alert(`Error: ${data.error}`);
                }
              } catch { alert("Failed"); }
              finally { setSending(false); }
            }}
            disabled={sending}
            className="px-3 py-1.5 text-xs font-medium rounded-md border-2 border-amber-400 bg-amber-50 text-amber-800 hover:bg-amber-100 disabled:opacity-40"
          >
            Queue All FBOs
          </button>
          <button
            type="button"
            onClick={() => sendBatch(true)}
            disabled={selected.size === 0 || sending}
            className="px-3 py-1.5 text-xs font-medium rounded-md border bg-white text-gray-600 hover:bg-gray-50 disabled:opacity-40"
          >
            Save Selected as Drafts ({selected.size})
          </button>
          <button
            type="button"
            onClick={() => {
              if (confirm(`Send ${selected.size} fee request emails from operations@baker-aviation.com?`)) {
                sendBatch(false);
              }
            }}
            disabled={selected.size === 0 || sending}
            className="px-3 py-1.5 text-xs font-medium rounded-md bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40"
          >
            {sending ? "Sending..." : `Send Emails (${selected.size})`}
          </button>
        </div>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search airport or FBO..."
          className="flex-1 max-w-sm rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm shadow-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 focus:outline-none"
        />
        <div className="flex rounded-lg border bg-gray-100 p-0.5">
          {([
            ["no_direct", "Not Yet Emailed"],
            ["has_email", "Has Email"],
            ["all", "All"],
          ] as const).map(([val, label]) => (
            <button
              key={val}
              type="button"
              onClick={() => setFilter(val)}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                filter === val ? "bg-white text-gray-900 shadow-sm" : "text-gray-500 hover:text-gray-700"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        <span className="text-xs text-gray-400">{filteredTargets.length} FBOs</span>
      </div>

      {/* Previously sent requests */}
      {requests.length > 0 && (() => {
        const filteredRequests = debouncedSearch
          ? requests.filter((r) =>
              r.airport_code.toLowerCase().includes(debouncedSearch.toLowerCase()) ||
              r.fbo_name.toLowerCase().includes(debouncedSearch.toLowerCase())
            )
          : requests;
        return (
        <div className="rounded-lg border border-gray-200 bg-white p-4">
          <h3 className="text-sm font-semibold mb-2">Previous Requests ({filteredRequests.length})</h3>
          <div className="max-h-96 overflow-y-auto">
            <table className="text-xs w-full">
              <thead>
                <tr className="text-left text-gray-500 border-b">
                  <th className="py-1 pr-3">Airport</th>
                  <th className="py-1 pr-3">FBO</th>
                  <th className="py-1 pr-3">Status</th>
                  <th className="py-1 pr-3">Sent</th>
                  <th className="py-1 pr-3">Reply</th>
                  <th className="py-1 pr-3"></th>
                </tr>
              </thead>
              <tbody>
                {filteredRequests.map((r) => (
                  <Fragment key={r.id}>
                    <tr
                      className={`border-b border-gray-50 ${r.reply_body ? "cursor-pointer hover:bg-gray-50" : ""}`}
                      onClick={() => r.reply_body && setExpandedReply(expandedReply === r.id ? null : r.id)}
                    >
                      <td className="py-1.5 pr-3 font-medium">{r.airport_code}</td>
                      <td className="py-1.5 pr-3">{r.fbo_name}</td>
                      <td className="py-1.5 pr-3">{statusBadge(r.status)}</td>
                      <td className="py-1.5 pr-3 text-gray-400">
                        {r.sent_at ? new Date(r.sent_at).toLocaleDateString() : "—"}
                      </td>
                      <td className="py-1.5 pr-3 text-gray-400">
                        {r.reply_received_at ? new Date(r.reply_received_at).toLocaleDateString() : "—"}
                      </td>
                      <td className="py-1.5 pr-3">
                        {r.reply_body && (
                          <span className="text-[10px] text-blue-600">
                            {expandedReply === r.id ? "▼ Hide" : "▶ View Reply"}
                          </span>
                        )}
                      </td>
                    </tr>
                    {expandedReply === r.id && r.reply_body && (
                      <tr className="border-b border-gray-100">
                        <td colSpan={6} className="p-0">
                          <FeeEditor
                            requestId={r.id}
                            airportCode={r.airport_code}
                            fboName={r.fbo_name}
                            replyBody={r.reply_body}
                            replyFrom={r.reply_from || r.fbo_email}
                            replyDate={r.reply_received_at || ""}
                          />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        );
      })()}

      {/* Select + send table */}
      <div className="rounded-lg border border-gray-200 bg-white overflow-hidden">
        <table className="text-sm w-full">
          <thead>
            <tr className="bg-slate-800 text-white text-xs">
              <th className="py-2.5 px-3 text-left w-8">
                <input
                  type="checkbox"
                  checked={selected.size === filteredTargets.length && filteredTargets.length > 0}
                  onChange={selectAll}
                  className="rounded"
                />
              </th>
              <th className="py-2.5 px-3 text-left">Airport</th>
              <th className="py-2.5 px-3 text-left">FBO</th>
              <th className="py-2.5 px-3 text-left">Email</th>
              <th className="py-2.5 px-3 text-left">Facility Fee</th>
              <th className="py-2.5 px-3 text-left">Jet-A</th>
              <th className="py-2.5 px-3 text-left">Preview</th>
            </tr>
          </thead>
          <tbody>
            {filteredTargets.slice(0, 100).map((t) => {
              const key = `${t.airport_code}|${t.fbo_name}|${t.email}`;
              return (
                <tr key={key} className="border-b border-gray-100 hover:bg-gray-50">
                  <td className="py-2 px-3">
                    <input
                      type="checkbox"
                      checked={selected.has(key)}
                      onChange={() => toggleSelect(key)}
                      className="rounded"
                    />
                  </td>
                  <td className="py-2 px-3 font-bold text-xs">{t.airport_code}</td>
                  <td className="py-2 px-3 text-xs">{t.fbo_name}</td>
                  <td className="py-2 px-3 text-xs text-blue-600">{t.email}</td>
                  <td className="py-2 px-3 text-xs text-gray-500">
                    {t.facility_fee ? `$${t.facility_fee.toLocaleString()}` : "—"}
                  </td>
                  <td className="py-2 px-3 text-xs text-gray-500">
                    {t.jet_a_price ? `$${t.jet_a_price.toFixed(2)}` : "—"}
                  </td>
                  <td className="py-2 px-3">
                    <button
                      type="button"
                      onClick={() => showPreview(t)}
                      className="text-[10px] text-blue-600 hover:underline"
                    >
                      Preview
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {filteredTargets.length > 100 && (
          <div className="px-3 py-2 text-xs text-gray-400 bg-gray-50">
            Showing 100 of {filteredTargets.length} — use search to narrow down
          </div>
        )}
      </div>

      {/* Email preview modal */}
      {preview && previewTarget && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50" onClick={() => setPreview(null)}>
          <div
            className="bg-white rounded-xl shadow-2xl max-w-2xl w-full max-h-[80vh] overflow-y-auto m-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="sticky top-0 bg-white border-b px-6 py-4 flex items-center justify-between">
              <div>
                <div className="text-sm font-bold">{preview.subject}</div>
                <div className="text-xs text-gray-400">
                  To: {previewTarget.email} &nbsp;|&nbsp; From: operations@baker-aviation.com
                </div>
              </div>
              <button type="button" onClick={() => setPreview(null)} className="text-gray-400 hover:text-gray-600 text-lg">
                ✕
              </button>
            </div>
            <div className="px-6 py-4">
              <div dangerouslySetInnerHTML={{ __html: preview.html }} />
            </div>
          </div>
        </div>
      )}

      {loading && !targets.length && (
        <div className="text-center text-gray-400 py-8 text-sm">Loading FBO data...</div>
      )}
    </div>
  );
}
