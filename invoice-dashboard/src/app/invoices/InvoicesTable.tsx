"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { fetchInvoices } from "@/lib/invoiceApi";

function normalize(v: any) {
  return String(v ?? "").trim();
}

function fmtCreated(s: any) {
  return String(s ?? "").replace("T", " ").replace("+00:00", "Z");
}

function invoiceFileUrl(documentId: string) {
  // Next.js route (or rewrite) that ultimately hits:
  // invoice-alerts Cloud Run: GET /api/invoices/:document_id/file -> 302 to signed GCS URL
  return `/api/invoices/${encodeURIComponent(documentId)}/file`;
}

export default function InvoicesTable({ initialInvoices }: { initialInvoices: any[] }) {
  // LIVE DATA (not frozen to initial prop)
  const [invoices, setInvoices] = useState<any[]>(initialInvoices ?? []);
  const [isRefreshing, setIsRefreshing] = useState(false);

  // Filters
  const [q, setQ] = useState("");
  const [airport, setAirport] = useState("ALL");
  const [vendor, setVendor] = useState("ALL");

  // If server sends a newer set (navigation), sync it in
  useEffect(() => {
    setInvoices(initialInvoices ?? []);
  }, [initialInvoices]);

  async function refresh() {
    try {
      setIsRefreshing(true);
      const data = await fetchInvoices({ limit: 200 });
      setInvoices(data.invoices ?? []);
    } catch (e) {
      // optional: console.error(e);
    } finally {
      setIsRefreshing(false);
    }
  }

  // AUTO-REFRESH
  useEffect(() => {
    // refresh immediately on mount, then poll
    refresh();
    const id = setInterval(refresh, 30_000); // <--- change to 10_000 for 10s, etc.
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const airports = useMemo(() => {
    const set = new Set<string>();
    for (const inv of invoices) {
      const a = normalize(inv.airport_code).toUpperCase();
      if (a) set.add(a);
    }
    return ["ALL", ...Array.from(set).sort()];
  }, [invoices]);

  const vendors = useMemo(() => {
    const set = new Set<string>();
    for (const inv of invoices) {
      const v = normalize(inv.vendor_name);
      if (v) set.add(v);
    }
    return ["ALL", ...Array.from(set).sort((a, b) => a.localeCompare(b))];
  }, [invoices]);

  const filtered = useMemo(() => {
    const query = q.toLowerCase().trim();

    return invoices.filter((inv) => {
      const invAirport = normalize(inv.airport_code).toUpperCase();
      const invVendor = normalize(inv.vendor_name);

      if (airport !== "ALL" && invAirport !== airport) return false;
      if (vendor !== "ALL" && invVendor !== vendor) return false;

      if (!query) return true;

      const haystack = [
        inv.document_id,
        inv.vendor_name,
        inv.airport_code,
        inv.tail_number,
        inv.invoice_number,
        inv.currency,
      ]
        .map((v) => String(v ?? "").toLowerCase())
        .join(" ");

      return haystack.includes(query);
    });
  }, [invoices, q, airport, vendor]);

  return (
    <div className="p-6 space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search vendor, airport, tail, invoice #…"
          className="w-full max-w-xl rounded-xl border bg-white px-4 py-2 text-sm shadow-sm outline-none"
        />

        <select
          value={airport}
          onChange={(e) => setAirport(e.target.value)}
          className="rounded-xl border bg-white px-3 py-2 text-sm shadow-sm"
        >
          {airports.map((a) => (
            <option key={a} value={a}>
              {a === "ALL" ? "All airports" : a}
            </option>
          ))}
        </select>

        <select
          value={vendor}
          onChange={(e) => setVendor(e.target.value)}
          className="rounded-xl border bg-white px-3 py-2 text-sm shadow-sm max-w-[320px]"
        >
          {vendors.map((v) => (
            <option key={v} value={v}>
              {v === "ALL" ? "All vendors" : v}
            </option>
          ))}
        </select>

        <button
          onClick={() => {
            setQ("");
            setAirport("ALL");
            setVendor("ALL");
          }}
          className="rounded-xl border bg-white px-3 py-2 text-sm shadow-sm hover:bg-gray-50"
        >
          Clear
        </button>

        <button
          onClick={refresh}
          disabled={isRefreshing}
          className="rounded-xl border bg-white px-3 py-2 text-sm shadow-sm hover:bg-gray-50 disabled:opacity-50"
        >
          {isRefreshing ? "Refreshing…" : "Refresh"}
        </button>

        <div className="text-xs text-gray-500">
          {filtered.length} shown{" "}
          <span className="ml-2 text-gray-400">(total {invoices.length})</span>
        </div>
      </div>

      <div className="rounded-xl border bg-white overflow-hidden shadow-sm">
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-gray-100 text-left text-gray-700">
              <tr>
                <th className="px-4 py-3 font-medium">Created</th>
                <th className="px-4 py-3 font-medium">Vendor</th>
                <th className="px-4 py-3 font-medium">Airport</th>
                <th className="px-4 py-3 font-medium">Tail</th>
                <th className="px-4 py-3 font-medium">Invoice #</th>
                <th className="px-4 py-3 font-medium">Total</th>
                <th className="px-4 py-3 text-right font-medium">Actions</th>
              </tr>
            </thead>

            <tbody>
              {filtered.map((inv) => (
                <tr key={inv.id ?? inv.document_id} className="border-t hover:bg-gray-50">
                  <td className="px-4 py-3">{fmtCreated(inv.created_at)}</td>
                  <td className="px-4 py-3">{inv.vendor_name ?? "—"}</td>
                  <td className="px-4 py-3">{inv.airport_code ?? "—"}</td>
                  <td className="px-4 py-3">{inv.tail_number ?? "—"}</td>
                  <td className="px-4 py-3">{inv.invoice_number ?? "—"}</td>
                  <td className="px-4 py-3">
                    {inv.total ?? "—"} {inv.currency ?? ""}
                  </td>

                  <td className="px-4 py-3 text-right">
                    {inv.document_id ? (
                      <div className="flex justify-end gap-4">
                        <Link
                          href={`/invoices/${inv.document_id}`}
                          className="text-blue-600 hover:underline whitespace-nowrap"
                        >
                          View →
                        </Link>

                        <a
                          href={invoiceFileUrl(inv.document_id)}
                          target="_blank"
                          rel="noreferrer"
                          className="text-blue-600 hover:underline whitespace-nowrap"
                        >
                          PDF →
                        </a>
                      </div>
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
              ))}

              {filtered.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-10 text-center text-gray-500">
                    No invoices found.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}