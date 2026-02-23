"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";

function setOrDelete(sp: URLSearchParams, key: string, val: string) {
  const v = (val || "").trim();
  if (!v) sp.delete(key);
  else sp.set(key, v);
}

export function InvoiceFilters() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const initial = useMemo(() => {
    return {
      q: searchParams.get("q") ?? "",
      vendor: searchParams.get("vendor") ?? "",
      doc_type: searchParams.get("doc_type") ?? "",
      airport: searchParams.get("airport") ?? "",
      tail: searchParams.get("tail") ?? "",
      review_required: searchParams.get("review_required") ?? "",
      min_risk: searchParams.get("min_risk") ?? "",
    };
  }, [searchParams]);

  const [state, setState] = useState(initial);

  function apply() {
    const sp = new URLSearchParams(searchParams.toString());
    setOrDelete(sp, "q", state.q);
    setOrDelete(sp, "vendor", state.vendor);
    setOrDelete(sp, "doc_type", state.doc_type);
    setOrDelete(sp, "airport", state.airport);
    setOrDelete(sp, "tail", state.tail);
    setOrDelete(sp, "review_required", state.review_required);
    setOrDelete(sp, "min_risk", state.min_risk);
    router.push(`${pathname}?${sp.toString()}`);
  }

  function clear() {
    router.push(pathname);
  }

  return (
    <div className="rounded-xl border bg-white p-4 shadow-sm">
      <div className="grid gap-3 md:grid-cols-7">
        <input
          className="rounded-md border px-3 py-2 text-sm md:col-span-2"
          placeholder="Search vendor / invoice # / doc_id…"
          value={state.q}
          onChange={(e) => setState((s) => ({ ...s, q: e.target.value }))}
        />
        <input
          className="rounded-md border px-3 py-2 text-sm"
          placeholder="Vendor contains…"
          value={state.vendor}
          onChange={(e) => setState((s) => ({ ...s, vendor: e.target.value }))}
        />
        <input
          className="rounded-md border px-3 py-2 text-sm"
          placeholder="Doc type (fbo_fee, parts, hotel…) "
          value={state.doc_type}
          onChange={(e) => setState((s) => ({ ...s, doc_type: e.target.value }))}
        />
        <input
          className="rounded-md border px-3 py-2 text-sm"
          placeholder="Airport (KOPF, BCT…) "
          value={state.airport}
          onChange={(e) => setState((s) => ({ ...s, airport: e.target.value }))}
        />
        <input
          className="rounded-md border px-3 py-2 text-sm"
          placeholder="Tail (N125DZ…) "
          value={state.tail}
          onChange={(e) => setState((s) => ({ ...s, tail: e.target.value }))}
        />
        <select
          className="rounded-md border px-3 py-2 text-sm"
          value={state.review_required}
          onChange={(e) => setState((s) => ({ ...s, review_required: e.target.value }))}
        >
          <option value="">Review?</option>
          <option value="true">review_required = true</option>
          <option value="false">review_required = false</option>
        </select>

        <div className="flex gap-2 md:col-span-7">
          <input
            className="w-40 rounded-md border px-3 py-2 text-sm"
            placeholder="min risk (e.g. 50)"
            value={state.min_risk}
            onChange={(e) => setState((s) => ({ ...s, min_risk: e.target.value }))}
          />
          <button
            onClick={apply}
            className="rounded-md bg-black px-3 py-2 text-sm font-medium text-white"
          >
            Apply
          </button>
          <button
            onClick={clear}
            className="rounded-md border px-3 py-2 text-sm"
          >
            Clear
          </button>
        </div>
      </div>
    </div>
  );
}