"use client";

import { useState, useEffect, useCallback } from "react";

type BakerPprAirport = {
  id: number;
  icao: string;
  created_at: string;
};

type SlackMapping = {
  id: number;
  salesperson_name: string;
  slack_user_id: string;
  quotes_enabled: boolean;
  custom_summary_hour: number | null;
  created_at: string;
};

type Quote = {
  id: number;
  quote: string;
  author: string | null;
  category: string;
};

export default function SettingsPage() {
  // Baker PPR state
  const [pprAirports, setPprAirports] = useState<BakerPprAirport[]>([]);
  const [pprLoading, setPprLoading] = useState(true);
  const [pprError, setPprError] = useState<string | null>(null);
  const [newIcao, setNewIcao] = useState("");
  const [addingIcao, setAddingIcao] = useState(false);

  // Trip CSV upload state
  const [csvUploading, setCsvUploading] = useState(false);
  const [csvResult, setCsvResult] = useState<string | null>(null);

  // Salesperson Slack mapping state
  const [slackMappings, setSlackMappings] = useState<SlackMapping[]>([]);
  const [slackLoading, setSlackLoading] = useState(true);
  const [slackError, setSlackError] = useState<string | null>(null);
  const [newSpName, setNewSpName] = useState("");
  const [newSpSlackId, setNewSpSlackId] = useState("");
  const [addingSp, setAddingSp] = useState(false);

  // Slack test DM state
  const [testingSlackId, setTestingSlackId] = useState<string | null>(null);

  // Notification check state
  const [notifChecking, setNotifChecking] = useState(false);
  const [notifResult, setNotifResult] = useState<string | null>(null);

  // Daily summary state
  const [summaryChecking, setSummaryChecking] = useState(false);
  const [summaryResult, setSummaryResult] = useState<string | null>(null);

  // Summary log state
  type SummaryLog = {
    id: number;
    salesperson_name: string;
    summary_date: string;
    leg_count: number;
    sent_at: string;
  };
  const [summaryLog, setSummaryLog] = useState<SummaryLog[]>([]);
  const [summaryLogLoading, setSummaryLogLoading] = useState(false);
  const [summaryLogError, setSummaryLogError] = useState<string | null>(null);
  const [summaryLogLoaded, setSummaryLogLoaded] = useState(false);

  // Motivational quotes state
  const [quotes, setQuotes] = useState<Quote[]>([]);
  const [quotesLoading, setQuotesLoading] = useState(true);
  const [newQuoteText, setNewQuoteText] = useState("");
  const [newQuoteAuthor, setNewQuoteAuthor] = useState("");
  const [newQuoteCategory, setNewQuoteCategory] = useState("sales");
  const [addingQuote, setAddingQuote] = useState(false);

  // Notification log state
  type NotifLog = {
    id: number;
    salesperson_name: string;
    sent_at: string;
    tail_number: string;
    departure_icao: string;
    arrival_icao: string;
    scheduled_departure: string | null;
    flight_type: string | null;
    customer: string | null;
    trip_id: string;
  };
  const [notifLog, setNotifLog] = useState<NotifLog[]>([]);
  const [notifLogLoading, setNotifLogLoading] = useState(false);
  const [notifLogError, setNotifLogError] = useState<string | null>(null);
  const [notifLogLoaded, setNotifLogLoaded] = useState(false);

  // ── Baker PPR fetching & handlers ────────────────────────────────────────

  const fetchPprAirports = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/baker-ppr");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setPprAirports(data.airports ?? []);
      setPprError(null);
    } catch (err) {
      setPprError(err instanceof Error ? err.message : "Failed to load");
    } finally {
      setPprLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchPprAirports();
  }, [fetchPprAirports]);

  // ── Salesperson Slack mapping fetching & handlers ──────────────────────────

  const fetchSlackMappings = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/salesperson-slack");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setSlackMappings(data.mappings ?? []);
      setSlackError(null);
    } catch (err) {
      setSlackError(err instanceof Error ? err.message : "Failed to load");
    } finally {
      setSlackLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchSlackMappings();
  }, [fetchSlackMappings]);

  async function handleCsvUpload(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const fileInput = form.elements.namedItem("csvFile") as HTMLInputElement;
    const file = fileInput?.files?.[0];
    if (!file) return;

    setCsvUploading(true);
    setCsvResult(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/admin/trip-salespersons/upload", { method: "POST", body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail ? `${data.error}: ${data.detail}` : (data.error ?? `HTTP ${res.status}`));
      setCsvResult(`Uploaded ${data.inserted ?? data.upserted} trip(s) from ${data.totalParsed} parsed rows.`);
      fileInput.value = "";
    } catch (err) {
      setCsvResult(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setCsvUploading(false);
    }
  }

  async function handleAddSlackMapping(e: React.FormEvent) {
    e.preventDefault();
    if (!newSpName.trim() || !newSpSlackId.trim()) return;
    setAddingSp(true);
    try {
      const res = await fetch("/api/admin/salesperson-slack", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ salesperson_name: newSpName.trim(), slack_user_id: newSpSlackId.trim() }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      setNewSpName("");
      setNewSpSlackId("");
      await fetchSlackMappings();
    } catch (err) {
      setSlackError(err instanceof Error ? err.message : "Failed to add");
    } finally {
      setAddingSp(false);
    }
  }

  async function handleDeleteSlackMapping(name: string) {
    if (!confirm(`Remove Slack mapping for "${name}"?`)) return;
    try {
      const res = await fetch("/api/admin/salesperson-slack", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ salesperson_name: name }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await fetchSlackMappings();
    } catch (err) {
      setSlackError(err instanceof Error ? err.message : "Failed to delete");
    }
  }

  async function handleTestSlackDm(slackUserId: string) {
    setTestingSlackId(slackUserId);
    try {
      const res = await fetch("/api/admin/salesperson-slack/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slack_user_id: slackUserId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setSlackError(null);
      alert("Test DM sent! Check Slack.");
    } catch (err) {
      setSlackError(err instanceof Error ? err.message : "Test DM failed");
    } finally {
      setTestingSlackId(null);
    }
  }

  // ── Quotes fetching & handlers ─────────────────────────────────────────────

  const fetchQuotes = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/quotes");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setQuotes(data.quotes ?? []);
    } catch {
      // Silently fail — table may not exist yet
    } finally {
      setQuotesLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchQuotes();
  }, [fetchQuotes]);

  async function handleSummaryHourChange(name: string, hour: number | null) {
    try {
      const res = await fetch("/api/admin/salesperson-slack", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ salesperson_name: name, custom_summary_hour: hour }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await fetchSlackMappings();
    } catch (err) {
      setSlackError(err instanceof Error ? err.message : "Failed to update summary time");
    }
  }

  async function handleToggleQuotes(name: string, enabled: boolean) {
    try {
      const res = await fetch("/api/admin/salesperson-slack", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ salesperson_name: name, quotes_enabled: enabled }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await fetchSlackMappings();
    } catch (err) {
      setSlackError(err instanceof Error ? err.message : "Failed to toggle quotes");
    }
  }

  async function handleAddQuote(e: React.FormEvent) {
    e.preventDefault();
    if (!newQuoteText.trim()) return;
    setAddingQuote(true);
    try {
      const res = await fetch("/api/admin/quotes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          quote: newQuoteText.trim(),
          author: newQuoteAuthor.trim() || null,
          category: newQuoteCategory,
        }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      setNewQuoteText("");
      setNewQuoteAuthor("");
      setNewQuoteCategory("sales");
      await fetchQuotes();
    } catch (err) {
      setSlackError(err instanceof Error ? err.message : "Failed to add quote");
    } finally {
      setAddingQuote(false);
    }
  }

  async function handleDeleteQuote(id: number) {
    try {
      const res = await fetch("/api/admin/quotes", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await fetchQuotes();
    } catch (err) {
      setSlackError(err instanceof Error ? err.message : "Failed to delete quote");
    }
  }

  async function handleCheckNotifications() {
    setNotifChecking(true);
    setNotifResult(null);
    try {
      const res = await fetch("/api/admin/trip-notifications/check", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      let msg = `Checked ${data.checked} flight(s): ${data.sent} DM(s) sent, ${data.skipped} skipped.`;
      if (data.sentDetails?.length) {
        const details = data.sentDetails.map(
          (d: { salesperson: string; tail: string; route: string; time: string }) =>
            `${d.salesperson} — ${d.tail} ${d.route} at ${d.time}`
        );
        msg += "\n\nSent to:\n" + details.join("\n");
      }
      if (data.errors?.length) msg += "\n\nErrors: " + data.errors.join("; ");
      if (data.message) msg = data.message;
      setNotifResult(msg);
    } catch (err) {
      setNotifResult(err instanceof Error ? err.message : "Check failed");
    } finally {
      setNotifChecking(false);
    }
  }

  async function handleDailySummary(day: "today" | "tomorrow") {
    setSummaryChecking(true);
    setSummaryResult(null);
    try {
      const res = await fetch(`/api/admin/trip-notifications/daily-summary?day=${day}`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      let msg = `Daily summary for ${data.date}: sent ${data.sent}/${data.total} DMs.`;
      if (data.sentDetails?.length) {
        const details = data.sentDetails.map(
          (d: { salesperson: string; legCount: number }) =>
            `${d.salesperson} — ${d.legCount} leg(s)`
        );
        msg += "\n\n" + details.join("\n");
      }
      if (data.errors?.length) msg += "\n\nErrors: " + data.errors.join("; ");
      if (data.message) msg = data.message;
      setSummaryResult(msg);
    } catch (err) {
      setSummaryResult(err instanceof Error ? err.message : "Summary failed");
    } finally {
      setSummaryChecking(false);
    }
  }

  async function fetchSummaryLog() {
    setSummaryLogLoading(true);
    setSummaryLogError(null);
    try {
      const res = await fetch("/api/admin/trip-notifications/summary-log");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setSummaryLog(data.summaries ?? []);
      setSummaryLogLoaded(true);
    } catch (err) {
      setSummaryLogError(err instanceof Error ? err.message : "Failed to load");
    } finally {
      setSummaryLogLoading(false);
    }
  }

  async function fetchNotifLog() {
    setNotifLogLoading(true);
    setNotifLogError(null);
    try {
      const res = await fetch("/api/admin/trip-notifications/log");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setNotifLog(data.notifications ?? []);
      setNotifLogLoaded(true);
    } catch (err) {
      setNotifLogError(err instanceof Error ? err.message : "Failed to load");
    } finally {
      setNotifLogLoading(false);
    }
  }

  async function handleAddIcao(e: React.FormEvent) {
    e.preventDefault();
    if (!newIcao.trim()) return;
    setAddingIcao(true);
    try {
      const res = await fetch("/api/admin/baker-ppr", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ icao: newIcao.trim() }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      setNewIcao("");
      await fetchPprAirports();
    } catch (err) {
      setPprError(err instanceof Error ? err.message : "Failed to add");
    } finally {
      setAddingIcao(false);
    }
  }

  async function handleDeleteIcao(icao: string) {
    if (!confirm(`Remove ${icao} from Baker PPR list?`)) return;
    try {
      const res = await fetch("/api/admin/baker-ppr", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ icao }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await fetchPprAirports();
    } catch (err) {
      setPprError(err instanceof Error ? err.message : "Failed to delete");
    }
  }

  return (
    <div>
      {/* ── Baker PPR Airports ────────────────────────────────────────────── */}
      <h2 className="text-lg font-semibold text-slate-900 mb-1">Baker PPR Airports</h2>
      <p className="text-sm text-gray-500 mb-4">
        Airports that require Baker PPR (Prior Permission Required). Flights
        to/from these airports will show a &quot;Baker PPR&quot; alert on the ops board.
      </p>

      {pprError && (
        <div className="mb-4 px-4 py-2 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
          {pprError}
          <button onClick={() => setPprError(null)} className="ml-2 text-red-400 hover:text-red-600">&times;</button>
        </div>
      )}

      <form onSubmit={handleAddIcao} className="mb-4 flex gap-2">
        <input
          type="text"
          value={newIcao}
          onChange={(e) => setNewIcao(e.target.value.toUpperCase())}
          placeholder="ICAO code (e.g. KNUQ)"
          maxLength={5}
          className="border border-gray-300 rounded-md px-3 py-2 text-sm w-44 font-mono uppercase focus:outline-none focus:ring-2 focus:ring-slate-500"
        />
        <button
          type="submit"
          disabled={addingIcao || !newIcao.trim()}
          className="bg-slate-900 text-white rounded-md px-5 py-2 text-sm font-medium hover:bg-slate-700 disabled:opacity-50 whitespace-nowrap"
        >
          {addingIcao ? "Adding…" : "Add"}
        </button>
      </form>

      {pprLoading ? (
        <div className="text-sm text-gray-400 py-4 text-center">Loading…</div>
      ) : pprAirports.length === 0 ? (
        <div className="text-sm text-gray-400 py-4 text-center border border-dashed border-gray-300 rounded-lg">
          No Baker PPR airports configured.
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          {pprAirports.map((a) => (
            <span
              key={a.id}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-amber-50 border border-amber-200 rounded-full text-sm font-mono font-semibold text-amber-800"
            >
              {a.icao}
              <button
                type="button"
                onClick={() => handleDeleteIcao(a.icao)}
                className="text-amber-400 hover:text-red-600 transition-colors"
                title={`Remove ${a.icao}`}
              >
                &times;
              </button>
            </span>
          ))}
        </div>
      )}

      {/* ── Trip Salesperson CSV Upload ─────────────────────────────────────── */}
      <hr className="my-8 border-gray-200" />
      <h2 className="text-lg font-semibold text-slate-900 mb-1">JetInsight Import</h2>
      <p className="text-sm text-gray-500 mb-4">
        Upload a JetInsight Aircraft Activity CSV. Expected columns:
        Start Z, Start time Z, End time Z, Tail #, Trip, Salesperson, Customer, Orig, Orig FBO, Dest, Dest FBO.
      </p>

      <form onSubmit={handleCsvUpload} className="mb-4 flex gap-2 items-center">
        <input
          type="file"
          name="csvFile"
          accept=".csv"
          className="text-sm text-gray-600 file:mr-3 file:py-2 file:px-4 file:rounded-md file:border-0 file:text-sm file:font-medium file:bg-slate-100 file:text-slate-700 hover:file:bg-slate-200"
        />
        <button
          type="submit"
          disabled={csvUploading}
          className="bg-slate-900 text-white rounded-md px-5 py-2 text-sm font-medium hover:bg-slate-700 disabled:opacity-50 whitespace-nowrap"
        >
          {csvUploading ? "Uploading…" : "Upload CSV"}
        </button>
      </form>

      {csvResult && (
        <div className="mb-4 px-4 py-2 bg-blue-50 border border-blue-200 rounded-lg text-sm text-blue-700">
          {csvResult}
        </div>
      )}

      {/* ── Email Signature ──────────────────────────────────────────────── */}
      <hr className="my-8 border-gray-200" />
      <h2 className="text-lg font-semibold text-slate-900 mb-1">Email Signature</h2>
      <p className="text-sm text-gray-500 mb-4">
        Your signature for international trip document emails sent from handling@baker-aviation.com.
        Saved per browser.
      </p>
      <div className="mb-4">
        <textarea
          id="emailSig"
          defaultValue={typeof window !== "undefined" ? localStorage.getItem("baker_email_signature") || "Best regards,\nBaker Aviation Handling" : ""}
          rows={4}
          className="w-full max-w-lg border border-gray-300 rounded-md px-3 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
          placeholder="Best regards,&#10;Your Name&#10;Baker Aviation Handling"
        />
        <button
          type="button"
          onClick={() => {
            const el = document.getElementById("emailSig") as HTMLTextAreaElement;
            if (el) { localStorage.setItem("baker_email_signature", el.value); alert("Signature saved!"); }
          }}
          className="mt-2 bg-slate-900 text-white rounded-md px-5 py-2 text-sm font-medium hover:bg-slate-700"
        >
          Save Signature
        </button>
      </div>

      {/* ── Salesperson Slack Mapping ───────────────────────────────────────── */}
      <hr className="my-8 border-gray-200" />
      <h2 className="text-lg font-semibold text-slate-900 mb-1">Salesperson Slack Mapping</h2>
      <p className="text-sm text-gray-500 mb-4">
        Map salesperson names (as they appear in JetInsight) to Slack user IDs
        for departure DM notifications.
      </p>

      {slackError && (
        <div className="mb-4 px-4 py-2 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
          {slackError}
          <button onClick={() => setSlackError(null)} className="ml-2 text-red-400 hover:text-red-600">&times;</button>
        </div>
      )}

      <form onSubmit={handleAddSlackMapping} className="mb-4 flex gap-2">
        <input
          type="text"
          value={newSpName}
          onChange={(e) => setNewSpName(e.target.value)}
          placeholder="Salesperson name"
          className="border border-gray-300 rounded-md px-3 py-2 text-sm w-48 focus:outline-none focus:ring-2 focus:ring-slate-500"
        />
        <input
          type="text"
          value={newSpSlackId}
          onChange={(e) => setNewSpSlackId(e.target.value)}
          placeholder="Slack user ID (U...)"
          className="border border-gray-300 rounded-md px-3 py-2 text-sm w-44 font-mono focus:outline-none focus:ring-2 focus:ring-slate-500"
        />
        <button
          type="submit"
          disabled={addingSp || !newSpName.trim() || !newSpSlackId.trim()}
          className="bg-slate-900 text-white rounded-md px-5 py-2 text-sm font-medium hover:bg-slate-700 disabled:opacity-50 whitespace-nowrap"
        >
          {addingSp ? "Adding…" : "Add Mapping"}
        </button>
      </form>

      {slackLoading ? (
        <div className="text-sm text-gray-400 py-4 text-center">Loading…</div>
      ) : slackMappings.length === 0 ? (
        <div className="text-sm text-gray-400 py-4 text-center border border-dashed border-gray-300 rounded-lg">
          No salesperson Slack mappings configured.
        </div>
      ) : (
        <div className="border border-gray-200 rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50">
              <tr>
                <th className="text-left px-4 py-2 font-medium text-gray-600">Salesperson</th>
                <th className="text-left px-4 py-2 font-medium text-gray-600">Slack User ID</th>
                <th className="text-center px-4 py-2 font-medium text-gray-600 w-24">Quotes</th>
                <th className="text-center px-4 py-2 font-medium text-gray-600 w-36">Summary Time</th>
                <th className="text-right px-4 py-2 font-medium text-gray-600 w-36">Actions</th>
              </tr>
            </thead>
            <tbody>
              {slackMappings.map((m) => (
                <tr key={m.id} className="border-t border-gray-100">
                  <td className="px-4 py-2 font-medium text-gray-800">{m.salesperson_name}</td>
                  <td className="px-4 py-2 font-mono text-xs text-gray-500">{m.slack_user_id}</td>
                  <td className="px-4 py-2 text-center">
                    <button
                      type="button"
                      onClick={() => handleToggleQuotes(m.salesperson_name, !m.quotes_enabled)}
                      className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
                        m.quotes_enabled ? "bg-emerald-500" : "bg-gray-300"
                      }`}
                      title={m.quotes_enabled ? "Quotes enabled — click to disable" : "Quotes disabled — click to enable"}
                    >
                      <span
                        className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform ${
                          m.quotes_enabled ? "translate-x-[18px]" : "translate-x-[3px]"
                        }`}
                      />
                    </button>
                  </td>
                  <td className="px-4 py-2 text-center">
                    <select
                      value={m.custom_summary_hour ?? 18}
                      onChange={(e) => {
                        const val = parseInt(e.target.value, 10);
                        handleSummaryHourChange(m.salesperson_name, val === 18 ? null : val);
                      }}
                      className="border border-gray-300 rounded px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-slate-500"
                    >
                      {Array.from({ length: 24 }, (_, h) => {
                        const ampm = h === 0 ? "12am" : h < 12 ? `${h}am` : h === 12 ? "12pm" : `${h - 12}pm`;
                        return (
                          <option key={h} value={h}>
                            {ampm} ET{h === 18 ? " (default)" : ""}
                          </option>
                        );
                      })}
                    </select>
                  </td>
                  <td className="px-4 py-2 text-right">
                    <div className="flex items-center justify-end gap-1">
                      <button
                        type="button"
                        onClick={() => handleTestSlackDm(m.slack_user_id)}
                        disabled={testingSlackId === m.slack_user_id}
                        className="text-xs text-blue-500 hover:text-blue-700 px-2 py-1 rounded hover:bg-blue-50 disabled:opacity-50"
                      >
                        {testingSlackId === m.slack_user_id ? "Sending…" : "Test DM"}
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDeleteSlackMapping(m.salesperson_name)}
                        className="text-xs text-gray-400 hover:text-red-600 px-2 py-1 rounded hover:bg-red-50"
                      >
                        Remove
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ── Motivational Quotes ──────────────────────────────────────────── */}
      <hr className="my-8 border-gray-200" />
      <h2 className="text-lg font-semibold text-slate-900 mb-1">Motivational Quotes</h2>
      <p className="text-sm text-gray-500 mb-4">
        Curated quotes appended to the evening summary for salespeople with quotes enabled above.
      </p>

      <form onSubmit={handleAddQuote} className="mb-4 flex gap-2">
        <input
          type="text"
          value={newQuoteText}
          onChange={(e) => setNewQuoteText(e.target.value)}
          placeholder="Quote text"
          className="flex-1 border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-500"
        />
        <input
          type="text"
          value={newQuoteAuthor}
          onChange={(e) => setNewQuoteAuthor(e.target.value)}
          placeholder="Author (optional)"
          className="border border-gray-300 rounded-md px-3 py-2 text-sm w-40 focus:outline-none focus:ring-2 focus:ring-slate-500"
        />
        <select
          value={newQuoteCategory}
          onChange={(e) => setNewQuoteCategory(e.target.value)}
          className="border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-500"
        >
          <option value="sales">Sales</option>
          <option value="motivation">Motivation</option>
        </select>
        <button
          type="submit"
          disabled={addingQuote || !newQuoteText.trim()}
          className="bg-slate-900 text-white rounded-md px-5 py-2 text-sm font-medium hover:bg-slate-700 disabled:opacity-50 whitespace-nowrap"
        >
          {addingQuote ? "Adding…" : "Add Quote"}
        </button>
      </form>

      {quotesLoading ? (
        <div className="text-sm text-gray-400 py-4 text-center">Loading…</div>
      ) : quotes.length === 0 ? (
        <div className="text-sm text-gray-400 py-4 text-center border border-dashed border-gray-300 rounded-lg">
          No quotes configured. Run the migration to seed the initial set.
        </div>
      ) : (
        <div className="border border-gray-200 rounded-lg overflow-hidden max-h-80 overflow-y-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 sticky top-0">
              <tr>
                <th className="text-left px-4 py-2 font-medium text-gray-600">Quote</th>
                <th className="text-left px-4 py-2 font-medium text-gray-600 w-36">Author</th>
                <th className="text-left px-4 py-2 font-medium text-gray-600 w-24">Category</th>
                <th className="text-right px-4 py-2 font-medium text-gray-600 w-16"></th>
              </tr>
            </thead>
            <tbody>
              {quotes.map((q) => (
                <tr key={q.id} className="border-t border-gray-100">
                  <td className="px-4 py-2 text-gray-700 italic">&ldquo;{q.quote}&rdquo;</td>
                  <td className="px-4 py-2 text-gray-500 text-xs">{q.author ?? "—"}</td>
                  <td className="px-4 py-2">
                    <span className={`inline-block rounded-full border px-2 py-0.5 text-[10px] font-semibold ${
                      q.category === "sales"
                        ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                        : "bg-blue-50 text-blue-700 border-blue-200"
                    }`}>
                      {q.category}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-right">
                    <button
                      type="button"
                      onClick={() => handleDeleteQuote(q.id)}
                      className="text-xs text-gray-400 hover:text-red-600 px-2 py-1 rounded hover:bg-red-50"
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-xs text-gray-400 mt-2">{quotes.length} quote(s) in rotation</p>

      {/* ── Test Notifications ─────────────────────────────────────────────── */}
      <hr className="my-8 border-gray-200" />
      <h2 className="text-lg font-semibold text-slate-900 mb-1">Test Departure Notifications</h2>
      <p className="text-sm text-gray-500 mb-4">
        Manually run the notification check. This scans flights departing in the
        next ~75 minutes, matches them to trip salespersons, and sends Slack DMs.
      </p>

      <button
        type="button"
        onClick={handleCheckNotifications}
        disabled={notifChecking}
        className="bg-slate-900 text-white rounded-md px-5 py-2 text-sm font-medium hover:bg-slate-700 disabled:opacity-50"
      >
        {notifChecking ? "Checking…" : "Run Notification Check"}
      </button>

      {notifResult && (
        <div className="mt-3 px-4 py-2 bg-blue-50 border border-blue-200 rounded-lg text-sm text-blue-700 whitespace-pre-line">
          {notifResult}
        </div>
      )}

      {/* ── Daily Summary ──────────────────────────────────────────────── */}
      <hr className="my-8 border-gray-200" />
      <h2 className="text-lg font-semibold text-slate-900 mb-1">Daily Evening Summary</h2>
      <p className="text-sm text-gray-500 mb-4">
        Send each salesperson a Slack DM with their sold legs for today or tomorrow.
        Salespersons with no legs get a &quot;no sold legs&quot; message.
        Automated cron uses each person&apos;s Summary Time (default 6pm ET).
      </p>

      <div className="flex gap-3">
        <button
          type="button"
          onClick={() => handleDailySummary("today")}
          disabled={summaryChecking}
          className="bg-slate-900 text-white rounded-md px-5 py-2 text-sm font-medium hover:bg-slate-700 disabled:opacity-50"
        >
          {summaryChecking ? "Sending…" : "Send for Today"}
        </button>
        <button
          type="button"
          onClick={() => handleDailySummary("tomorrow")}
          disabled={summaryChecking}
          className="bg-slate-700 text-white rounded-md px-5 py-2 text-sm font-medium hover:bg-slate-600 disabled:opacity-50"
        >
          {summaryChecking ? "Sending…" : "Send for Tomorrow"}
        </button>
      </div>

      {summaryResult && (
        <div className="mt-3 px-4 py-2 bg-blue-50 border border-blue-200 rounded-lg text-sm text-blue-700 whitespace-pre-line">
          {summaryResult}
        </div>
      )}

      {/* ── Daily Summary Log ────────────────────────────────────────────── */}
      <hr className="my-8 border-gray-200" />
      <h2 className="text-lg font-semibold text-slate-900 mb-1">Daily Summary Log</h2>
      <p className="text-sm text-gray-500 mb-4">
        View evening summary DMs sent in the last 30 days. Shows which
        salespersons received their daily leg summary and how many legs were included.
      </p>

      <button
        type="button"
        onClick={fetchSummaryLog}
        disabled={summaryLogLoading}
        className="bg-slate-900 text-white rounded-md px-5 py-2 text-sm font-medium hover:bg-slate-700 disabled:opacity-50"
      >
        {summaryLogLoading ? "Loading…" : summaryLogLoaded ? "Refresh Log" : "Load Summary Log"}
      </button>

      {summaryLogError && (
        <div className="mt-3 px-4 py-2 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
          {summaryLogError}
        </div>
      )}

      {summaryLogLoaded && summaryLog.length === 0 && (
        <div className="mt-3 text-sm text-gray-400 py-4 text-center border border-dashed border-gray-300 rounded-lg">
          No daily summaries sent in the last 30 days.
        </div>
      )}

      {summaryLog.length > 0 && (
        <div className="mt-3 border border-gray-200 rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50">
              <tr>
                <th className="text-left px-4 py-2 font-medium text-gray-600">Sent At</th>
                <th className="text-left px-4 py-2 font-medium text-gray-600">Salesperson</th>
                <th className="text-left px-4 py-2 font-medium text-gray-600">Summary For</th>
                <th className="text-left px-4 py-2 font-medium text-gray-600">Legs</th>
              </tr>
            </thead>
            <tbody>
              {summaryLog.map((s) => {
                const sentStr = new Date(s.sent_at).toLocaleString("en-US", {
                  month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
                  hour12: true, timeZone: "America/Chicago",
                });
                const dateStr = new Date(s.summary_date + "T12:00:00").toLocaleDateString("en-US", {
                  weekday: "short", month: "short", day: "numeric",
                });
                return (
                  <tr key={s.id} className="border-t border-gray-100 hover:bg-gray-50">
                    <td className="px-4 py-2 text-xs text-gray-500 whitespace-nowrap">{sentStr}</td>
                    <td className="px-4 py-2 font-medium text-gray-800">{s.salesperson_name}</td>
                    <td className="px-4 py-2 text-xs text-gray-600">{dateStr}</td>
                    <td className="px-4 py-2 text-xs text-gray-700">
                      {s.leg_count === 0 ? (
                        <span className="text-gray-400">No legs</span>
                      ) : (
                        <span className="font-medium">{s.leg_count} leg{s.leg_count !== 1 ? "s" : ""}</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* ── Notification Log ─────────────────────────────────────────────── */}
      <hr className="my-8 border-gray-200" />
      <h2 className="text-lg font-semibold text-slate-900 mb-1">Departure Notification Log</h2>
      <p className="text-sm text-gray-500 mb-4">
        View departure DMs sent in the last 7 days. Use this to verify if a
        salesperson received an alert for a specific flight.
      </p>

      <button
        type="button"
        onClick={fetchNotifLog}
        disabled={notifLogLoading}
        className="bg-slate-900 text-white rounded-md px-5 py-2 text-sm font-medium hover:bg-slate-700 disabled:opacity-50"
      >
        {notifLogLoading ? "Loading…" : notifLogLoaded ? "Refresh Log" : "Load Notification Log"}
      </button>

      {notifLogError && (
        <div className="mt-3 px-4 py-2 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
          {notifLogError}
        </div>
      )}

      {notifLogLoaded && notifLog.length === 0 && (
        <div className="mt-3 text-sm text-gray-400 py-4 text-center border border-dashed border-gray-300 rounded-lg">
          No notifications sent in the last 7 days.
        </div>
      )}

      {notifLog.length > 0 && (
        <div className="mt-3 border border-gray-200 rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50">
              <tr>
                <th className="text-left px-4 py-2 font-medium text-gray-600">Sent At</th>
                <th className="text-left px-4 py-2 font-medium text-gray-600">Salesperson</th>
                <th className="text-left px-4 py-2 font-medium text-gray-600">Tail</th>
                <th className="text-left px-4 py-2 font-medium text-gray-600">Route</th>
                <th className="text-left px-4 py-2 font-medium text-gray-600">Sched Dep</th>
                <th className="text-left px-4 py-2 font-medium text-gray-600">Customer</th>
              </tr>
            </thead>
            <tbody>
              {notifLog.map((n) => {
                const sentDate = new Date(n.sent_at);
                const sentStr = sentDate.toLocaleString("en-US", {
                  month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
                  hour12: true, timeZone: "America/Chicago",
                });
                const depStr = n.scheduled_departure
                  ? new Date(n.scheduled_departure).toLocaleString("en-US", {
                      month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
                      hour12: true, timeZone: "America/Chicago",
                    })
                  : "—";
                const depIcao = n.departure_icao?.startsWith("K") ? n.departure_icao.slice(1) : n.departure_icao;
                const arrIcao = n.arrival_icao?.startsWith("K") ? n.arrival_icao.slice(1) : n.arrival_icao;
                return (
                  <tr key={n.id} className="border-t border-gray-100 hover:bg-gray-50">
                    <td className="px-4 py-2 text-xs text-gray-500 whitespace-nowrap">{sentStr}</td>
                    <td className="px-4 py-2 font-medium text-gray-800">{n.salesperson_name}</td>
                    <td className="px-4 py-2 font-mono text-xs text-gray-700">{n.tail_number}</td>
                    <td className="px-4 py-2 font-mono text-xs text-gray-700">{depIcao} → {arrIcao}</td>
                    <td className="px-4 py-2 text-xs text-gray-500 whitespace-nowrap">{depStr}</td>
                    <td className="px-4 py-2 text-xs text-gray-500">{n.customer ?? "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
