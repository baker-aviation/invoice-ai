"use client";

import Link from "next/link";
import { useMemo, useState } from "react";

const PAGE_SIZE = 25;

function normalize(v: any) {
  return String(v ?? "").trim();
}

function fmtTime(s: any): string {
  const t = normalize(s);
  if (!t) return "—";
  const d = new Date(t);
  if (isNaN(d.getTime())) return t.replace("T", " ").slice(0, 16);
  return d.toISOString().slice(0, 16).replace("T", " ");
}

export default function InvoicesTable({ initialInvoices }: { initialInvoices: any[] }) {
  const [q, setQ] = useState("");
  const [airport, setAirport] = useState("ALL");
  const [vendor, setVendor] = useState("ALL");
  const [page, setPage] = useState(0);

  const airports = useMemo(() => {
    const set = new Set<string>();
    for (const inv of initialInvoices) {
      const a = normalize(inv.airport_code).toUpperCase();
      if (a) set.add(a);
    }
    return ["ALL", ...Array.from(set).sort()];
  }, [initialInvoices]);

  const vendors = useMemo(() => {
    const set = new Set<string>();
    for (const inv of initialInvoices) {
      const v = normalize(inv.vendor_name);
      if (v) set.add(v);
    }
    return ["ALL", ...Array.from(set).sort((a, b) => a.localeCompare(b))];
  }, [initialInvoices]);

  const filtered = useMemo(() => {
    const query = q.toLowerCase().trim();

    return initialInvoices.filter((inv) => {
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
  }, [initialInvoices, q, airport, vendor]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const paged = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  const clear = () => {
    setQ("");
    setAirport("ALL");
    setVendor("ALL");
    setPage(0);
  };

  return (
    <div className="p-6 space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <input
          value={q}
          onChange={(e) => { setQ(e.target.value); setPage(0); }}
          placeholder="Search vendor, airport, tail, invoice #…"
          className="w-full max-w-xl rounded-xl border bg-white px-4 py-2 text-sm shadow-sm outline-none"
        />

        <select
          value={airport}
          onChange={(e) => { setAirport(e.target.value); setPage(0); }}
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
          onChange={(e) => { setVendor(e.target.value); setPage(0); }}
          className="rounded-xl border bg-white px-3 py-2 text-sm shadow-sm max-w-[320px]"
        >
          {vendors.map((v) => (
            <option key={v} value={v}>
              {v === "ALL" ? "All vendors" : v}
            </option>
          ))}
        </select>

        <button
          onClick={clear}
          className="rounded-xl border bg-white px-3 py-2 text-sm shadow-sm hover:bg-gray-50"
        >
          Clear
        </button>

        <div className="text-xs text-gray-500">{filtered.length} shown</div>
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
                <th className="px-4 py-3"></th>
              </tr>
            </thead>

            <tbody>
              {paged.map((inv) => (
                <tr key={inv.id ?? inv.document_id} className="border-t hover:bg-gray-50">
                  <td className="px-4 py-3 whitespace-nowrap">{fmtTime(inv.created_at)}</td>
                  <td className="px-4 py-3">{inv.vendor_name ?? "—"}</td>
                  <td className="px-4 py-3">{inv.airport_code ?? "—"}</td>
                  <td className="px-4 py-3">{inv.tail_number ?? "—"}</td>
                  <td className="px-4 py-3">{inv.invoice_number ?? "—"}</td>
                  <td className="px-4 py-3">
                    {inv.total ?? "—"} {inv.currency ?? ""}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {inv.document_id ? (
                      <Link href={`/invoices/${inv.document_id}`} className="text-blue-600 hover:underline">
                        View →
                      </Link>
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
              ))}

              {paged.length === 0 && (
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

      {totalPages > 1 && (
        <div className="flex items-center justify-between">
          <button
            type="button"
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            disabled={page === 0}
            className="h-9 rounded-lg border px-4 text-sm hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            ← Previous
          </button>
          <span className="text-xs text-gray-500">
            Page {page + 1} of {totalPages}
          </span>
          <button
            type="button"
            onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
            disabled={page >= totalPages - 1}
            className="h-9 rounded-lg border px-4 text-sm hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Next →
          </button>
        </div>
      )}

      <div className="text-xs text-gray-500">
        Showing {filtered.length} invoice{filtered.length === 1 ? "" : "s"} across {totalPages} page{totalPages === 1 ? "" : "s"}.
      </div>
    </div>
  );
}
