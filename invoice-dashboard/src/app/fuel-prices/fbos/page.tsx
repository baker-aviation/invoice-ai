"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

// ─── Types ────────���───────────────────────────���─────────────────────────────

type FboProfile = {
  id: number;
  airport_code: string;
  fbo_name: string;
  chain: string;
  aircraft_type: string;
  // JI fees
  facility_fee: number | null;
  gallons_to_waive: number | null;
  security_fee: number | null;
  landing_fee: number | null;
  overnight_fee: number | null;
  parking_info: string;
  hangar_fee: number | null;
  gpu_fee: number | null;
  lavatory_fee: number | null;
  jet_a_price: number | null;
  // Contact
  phone: string;
  hours: string;
  is_24hr: boolean;
  email: string;
  url: string;
  services: string[];
  // Location (from website data)
  city: string;
  state: string;
  // Other sources
  website_fees: WebsiteFees | null;
  direct_fees: DirectFees | null;
};

type WebsiteFees = {
  facility_fee: number | null;
  handling_fee: number | null;
  gallons_to_waive: number | null;
  security_fee: number | null;
  infrastructure_fee: number | null;
  landing_fee: number | null;
  overnight_fee: number | null;
  hangar_fee: number | null;
  hangar_info: string;
  gpu_fee: number | null;
  lavatory_fee: number | null;
  water_fee: number | null;
  jet_a_price: number | null;
  jet_a_additive_price: number | null;
  avgas_price: number | null;
  saf_price: number | null;
  email: string;
  phone: string;
};

type DirectFees = {
  facility_fee: number | null;
  gallons_to_waive: number | null;
  security_fee: number | null;
  landing_fee: number | null;
  overnight_fee: number | null;
  hangar_fee: number | null;
  gpu_fee: number | null;
  lavatory_fee: number | null;
  jet_a_price: number | null;
  source_date: string | null;
  confidence: string;
};

type ApiResponse = {
  profiles: FboProfile[];
  total: number;
  page: number;
  limit: number;
  stats: { totalFbos: number; totalWithEmail: number; totalWebsiteFees: number };
};

type AircraftFilter = "Citation X" | "Challenger 300" | "";

// ─── Helpers ───────────���────────────────────────────────────────────────────

function fmt$(v: number | null | undefined): string {
  if (v == null) return "\u2014";
  return `$${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtGal(v: number | null | undefined): string {
  if (v == null) return "\u2014";
  return `${Math.round(v)} gal`;
}

const CHAIN_COLORS: Record<string, string> = {
  "Atlantic Aviation": "bg-blue-100 text-blue-800",
  "Signature Flight Support": "bg-emerald-100 text-emerald-800",
  "Jet Aviation": "bg-purple-100 text-purple-800",
  "Million Air": "bg-amber-100 text-amber-800",
  "Sheltair": "bg-cyan-100 text-cyan-800",
  "Modern Aviation": "bg-rose-100 text-rose-800",
  "Cutter Aviation": "bg-orange-100 text-orange-800",
  "Pentastar Aviation": "bg-indigo-100 text-indigo-800",
};

type FeeField = { key: string; label: string; format: "dollar" | "gal" };
const FEE_FIELDS: FeeField[] = [
  { key: "facility_fee", label: "Handling / Facility", format: "dollar" },
  { key: "handling_fee", label: "Handling Fee", format: "dollar" },
  { key: "gallons_to_waive", label: "Gallons to Waive", format: "gal" },
  { key: "security_fee", label: "Security / Ramp", format: "dollar" },
  { key: "infrastructure_fee", label: "Infrastructure", format: "dollar" },
  { key: "landing_fee", label: "Landing Fee", format: "dollar" },
  { key: "overnight_fee", label: "Overnight", format: "dollar" },
  { key: "hangar_fee", label: "Hangar", format: "dollar" },
  { key: "gpu_fee", label: "GPU", format: "dollar" },
  { key: "lavatory_fee", label: "Lavatory", format: "dollar" },
  { key: "water_fee", label: "Water Service", format: "dollar" },
  { key: "jet_a_price", label: "Jet-A", format: "dollar" },
];

function getVal(obj: Record<string, unknown> | null, key: string): number | null {
  if (!obj) return null;
  const v = obj[key];
  return typeof v === "number" ? v : null;
}

// ─── Component ──────────────────────────��───────────────────────────────────

export default function FBOProfilesPage() {
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [aircraft, setAircraft] = useState<AircraftFilter>("Citation X");
  const [hasEmail, setHasEmail] = useState(false);
  const [is24hr, setIs24hr] = useState(false);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<ApiResponse | null>(null);
  const [expandedIds, setExpandedIds] = useState<Set<number>>(new Set());

  useEffect(() => {
    const t = setTimeout(() => { setDebouncedSearch(search); setPage(1); }, 350);
    return () => clearTimeout(t);
  }, [search]);

  const fetchData = useCallback(async () => {
    setLoading(true);
    const params = new URLSearchParams();
    if (debouncedSearch) params.set("search", debouncedSearch);
    if (aircraft) params.set("aircraft", aircraft);
    if (hasEmail) params.set("hasEmail", "true");
    if (is24hr) params.set("is24hr", "true");
    params.set("page", String(page));
    params.set("limit", "50");
    try {
      const res = await fetch(`/api/fbo-profiles?${params}`);
      setData(await res.json());
    } catch { /* */ }
    finally { setLoading(false); }
  }, [debouncedSearch, aircraft, hasEmail, is24hr, page]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const grouped = useMemo(() => {
    if (!data?.profiles) return new Map<string, FboProfile[]>();
    const map = new Map<string, FboProfile[]>();
    for (const p of data.profiles) {
      if (!map.has(p.airport_code)) map.set(p.airport_code, []);
      map.get(p.airport_code)!.push(p);
    }
    return map;
  }, [data]);

  const toggleExpand = (id: number) =>
    setExpandedIds((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });

  const totalPages = data ? Math.ceil(data.total / data.limit) : 0;

  const exportCsv = () => {
    if (!data?.profiles?.length) return;
    const headers = [
      "Airport","City","State","FBO Name","Chain","Aircraft","Email","Phone","URL","Hours","24hr",
      "JI Facility Fee","JI Gallons to Waive","JI Security","JI Landing","JI Overnight","JI Hangar","JI GPU","JI Lavatory","JI Jet-A",
      "Web Facility Fee","Web Handling","Web Security","Web Infrastructure","Web GPU","Web Hangar","Web Lavatory","Web Water","Web Jet-A",
    ];
    const rows = data.profiles.map((p) => {
      const w = p.website_fees as Record<string, unknown> | null;
      return [
        p.airport_code, p.city || "", p.state || "", p.fbo_name, p.chain, p.aircraft_type,
        p.email, p.phone, p.url, p.hours, p.is_24hr ? "Yes" : "No",
        p.facility_fee ?? "", p.gallons_to_waive ?? "", p.security_fee ?? "", p.landing_fee ?? "",
        p.overnight_fee ?? "", p.hangar_fee ?? "", p.gpu_fee ?? "", p.lavatory_fee ?? "", p.jet_a_price ?? "",
        getVal(w, "facility_fee") ?? "", getVal(w, "handling_fee") ?? "", getVal(w, "security_fee") ?? "",
        getVal(w, "infrastructure_fee") ?? "", getVal(w, "gpu_fee") ?? "", getVal(w, "hangar_fee") ?? "",
        getVal(w, "lavatory_fee") ?? "", getVal(w, "water_fee") ?? "", getVal(w, "jet_a_price") ?? "",
      ];
    });
    const csv = [headers.join(","), ...rows.map((r) => r.map((v) => `"${v}"`).join(","))].join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const u = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = u;
    a.download = `fbo-profiles-${new Date().toISOString().split("T")[0]}.csv`;
    a.click(); URL.revokeObjectURL(u);
  };

  return (
    <div className="space-y-4">
      {/* Stats */}
      {data?.stats && (
        <div className="flex gap-6 text-xs text-gray-500">
          <span><strong className="text-gray-900">{data.total}</strong> results</span>
          <span><strong className="text-gray-900">{data.stats.totalFbos}</strong> JetInsight FBOs</span>
          <span><strong className="text-gray-900">{data.stats.totalWebsiteFees}</strong> FBO website records</span>
          <span><strong className="text-gray-900">{data.stats.totalWithEmail}</strong> with email</span>
        </div>
      )}

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1 max-w-md">
          <input
            type="text" value={search} onChange={(e) => setSearch(e.target.value)}
            placeholder="Search airport, FBO name, or chain..."
            className="w-full rounded-lg border border-gray-300 bg-white px-4 py-2.5 text-sm shadow-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 focus:outline-none"
          />
        </div>
        <div className="flex rounded-lg border bg-gray-100 p-0.5">
          {(["Citation X", "Challenger 300"] as const).map((ac) => (
            <button key={ac} type="button"
              onClick={() => { setAircraft(aircraft === ac ? "" : ac); setPage(1); }}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                aircraft === ac ? "bg-white text-gray-900 shadow-sm" : "text-gray-500 hover:text-gray-700"
              }`}
            >{ac}</button>
          ))}
        </div>
        <button type="button" onClick={() => { setHasEmail(!hasEmail); setPage(1); }}
          className={`px-3 py-1.5 text-xs font-medium rounded-full border transition-colors ${
            hasEmail ? "bg-blue-100 text-blue-800 border-blue-300" : "bg-white text-gray-500 border-gray-300 hover:bg-gray-50"
          }`}
        >Has Email</button>
        <button type="button" onClick={() => { setIs24hr(!is24hr); setPage(1); }}
          className={`px-3 py-1.5 text-xs font-medium rounded-full border transition-colors ${
            is24hr ? "bg-green-100 text-green-800 border-green-300" : "bg-white text-gray-500 border-gray-300 hover:bg-gray-50"
          }`}
        >24hr Only</button>
        <button type="button" onClick={exportCsv}
          className="ml-auto px-3 py-1.5 text-xs font-medium rounded-md border border-gray-300 bg-white text-gray-600 hover:bg-gray-50 transition-colors"
        >Export CSV</button>
      </div>

      {loading && !data && (
        <div className="rounded-lg border border-gray-200 bg-white p-8 text-center text-gray-400 text-sm">Loading FBO profiles...</div>
      )}

      {data && data.profiles.length === 0 && (
        <div className="rounded-lg border border-gray-200 bg-white p-8 text-center text-gray-500">
          No FBOs found{debouncedSearch ? ` for "${debouncedSearch}"` : ""}.
        </div>
      )}

      {/* Airport groups */}
      {Array.from(grouped.entries()).map(([airportCode, profiles]) => (
        <div key={airportCode} className="rounded-lg border border-gray-200 bg-white shadow-sm overflow-hidden">
          <div className="bg-slate-800 text-white px-5 py-3 flex items-center gap-3">
            <span className="text-lg font-bold tracking-wide">{airportCode}</span>
            {profiles[0]?.city && (
              <span className="text-slate-300 text-sm">
                {profiles[0].city}{profiles[0].state ? `, ${profiles[0].state}` : ""}
              </span>
            )}
            <span className="text-slate-400 text-xs">
              {profiles.length} FBO{profiles.length !== 1 ? "s" : ""}
            </span>
            {/* Best fuel */}
            {(() => {
              const best = profiles.reduce<{ price: number; name: string } | null>((b, p) => {
                if (p.jet_a_price && (!b || p.jet_a_price < b.price)) return { price: p.jet_a_price, name: p.fbo_name };
                return b;
              }, null);
              return best ? (
                <div className="ml-auto flex items-center gap-2">
                  <div className="text-right">
                    <div className="text-[10px] text-emerald-300 uppercase tracking-wide">Best Fuel</div>
                    <div className="text-sm font-bold text-emerald-400">${best.price.toFixed(2)}/gal</div>
                  </div>
                  <div className="text-[10px] text-slate-400">via {best.name}</div>
                </div>
              ) : null;
            })()}
          </div>

          <div className="divide-y divide-gray-200">
            {profiles
              .sort((a, b) => {
                const ap = (a.facility_fee || a.jet_a_price) ? 0 : 1;
                const bp = (b.facility_fee || b.jet_a_price) ? 0 : 1;
                return ap - bp || a.fbo_name.localeCompare(b.fbo_name);
              })
              .map((p) => {
                const isExpanded = expandedIds.has(p.id);
                const ji = p as Record<string, unknown>;
                const web = p.website_fees as Record<string, unknown> | null;
                const direct = p.direct_fees as Record<string, unknown> | null;
                const hasAnyFee = FEE_FIELDS.some((f) => getVal(ji, f.key) != null || getVal(web, f.key) != null || getVal(direct, f.key) != null);

                return (
                  <div key={p.id} className="px-5 py-4">
                    {/* Row header */}
                    <button type="button" onClick={() => toggleExpand(p.id)} className="w-full flex items-center gap-2 text-left group">
                      <svg className={`w-4 h-4 text-gray-400 transition-transform flex-shrink-0 ${isExpanded ? "rotate-90" : ""}`}
                        fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                      </svg>
                      <span className="font-semibold text-sm group-hover:text-blue-600 transition-colors">{p.fbo_name}</span>
                      {p.chain && (
                        <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${CHAIN_COLORS[p.chain] || "bg-gray-100 text-gray-700"}`}>
                          {p.chain}
                        </span>
                      )}
                      {p.email && <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-blue-50 text-blue-600">email</span>}
                      {p.is_24hr && <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-green-50 text-green-600">24hr</span>}
                      {web && <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-violet-50 text-violet-600">website</span>}
                      {direct && <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-teal-50 text-teal-600">direct</span>}
                      <div className="ml-auto flex items-center gap-4 text-xs text-gray-400">
                        {p.jet_a_price && <span className="font-medium text-amber-600">${p.jet_a_price.toFixed(2)}/gal</span>}
                        {p.facility_fee != null && <span>Facility: {fmt$(p.facility_fee)}</span>}
                        {p.phone && <span>{p.phone}</span>}
                      </div>
                    </button>

                    {/* Expanded */}
                    {isExpanded && (
                      <div className="mt-3 ml-6 space-y-3">
                        {/* Contact */}
                        <div className="flex flex-wrap gap-4 text-xs">
                          {p.email && <a href={`mailto:${p.email}`} className="text-blue-600 hover:underline">{p.email}</a>}
                          {p.phone && <span className="text-gray-600">{p.phone}</span>}
                          {p.url && (
                            <a href={p.url.startsWith("http") ? p.url : `https://${p.url}`}
                              target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">{p.url}</a>
                          )}
                          {p.hours && <span className="text-gray-500">Hours: {p.hours}</span>}
                        </div>

                        {/* Services */}
                        {p.services?.length > 0 && (
                          <div className="flex flex-wrap gap-1">
                            {p.services.map((s, i) => (
                              <span key={i} className="text-[10px] px-2 py-0.5 rounded-full bg-gray-100 text-gray-600">
                                {s.length > 60 ? s.slice(0, 60) + "..." : s}
                              </span>
                            ))}
                          </div>
                        )}

                        {/* 3-source fee comparison */}
                        {hasAnyFee && (
                          <div className="overflow-x-auto">
                            <table className="text-xs w-full max-w-3xl">
                              <thead>
                                <tr className="text-left text-gray-500 border-b">
                                  <th className="py-1.5 pr-4 font-medium">Fee</th>
                                  <th className="py-1.5 pr-4 font-medium">
                                    <span className="inline-flex items-center gap-1">
                                      <span className="w-2 h-2 rounded-full bg-blue-500" />JetInsight
                                    </span>
                                  </th>
                                  <th className="py-1.5 pr-4 font-medium">
                                    <span className="inline-flex items-center gap-1">
                                      <span className="w-2 h-2 rounded-full bg-violet-500" />FBO Website
                                    </span>
                                  </th>
                                  <th className="py-1.5 pr-4 font-medium">
                                    <span className="inline-flex items-center gap-1">
                                      <span className="w-2 h-2 rounded-full bg-teal-500" />Direct (Email)
                                    </span>
                                  </th>
                                </tr>
                              </thead>
                              <tbody>
                                {FEE_FIELDS.map((f) => {
                                  const jiVal = getVal(ji, f.key);
                                  const webVal = getVal(web, f.key);
                                  const dirVal = getVal(direct, f.key);
                                  if (jiVal == null && webVal == null && dirVal == null) return null;

                                  const fmtVal = f.format === "gal" ? fmtGal : fmt$;

                                  return (
                                    <tr key={f.key} className="border-b border-gray-100">
                                      <td className="py-1.5 pr-4 text-gray-600">{f.label}</td>
                                      <td className="py-1.5 pr-4 font-medium text-blue-800">{fmtVal(jiVal)}</td>
                                      <td className="py-1.5 pr-4 font-medium text-violet-800">{fmtVal(webVal)}</td>
                                      <td className="py-1.5 pr-4">
                                        {dirVal != null ? (
                                          <span className="font-medium text-teal-800">{fmtVal(dirVal)}</span>
                                        ) : (
                                          <span className="text-gray-300 italic">Pending</span>
                                        )}
                                      </td>
                                    </tr>
                                  );
                                })}
                              </tbody>
                            </table>
                          </div>
                        )}

                        {/* Website-only extra info */}
                        {web && (
                          <div className="flex flex-wrap gap-2 text-xs">
                            {getVal(web, "jet_a_additive_price") != null && (
                              <span className="text-gray-500">Jet-A + Additive: <strong className="text-gray-700">{fmt$(getVal(web, "jet_a_additive_price"))}</strong></span>
                            )}
                            {getVal(web, "saf_price") != null && (
                              <span className="text-gray-500">SAF: <strong className="text-gray-700">{fmt$(getVal(web, "saf_price"))}</strong></span>
                            )}
                            {getVal(web, "avgas_price") != null && (
                              <span className="text-gray-500">AvGas: <strong className="text-gray-700">{fmt$(getVal(web, "avgas_price"))}</strong></span>
                            )}
                            {(web as Record<string, unknown>)?.hangar_info && (
                              <span className="text-gray-500">Hangar: {String((web as Record<string, unknown>).hangar_info)}</span>
                            )}
                          </div>
                        )}

                        {!hasAnyFee && (
                          <div className="text-xs text-gray-400 italic">
                            No fee data available
                            {p.email && <> &mdash; <a href={`mailto:${p.email}`} className="text-blue-500 hover:underline">email FBO for rates</a></>}
                          </div>
                        )}

                        {p.parking_info && (
                          <div className="text-xs text-gray-500"><span className="font-medium">Parking:</span> {p.parking_info}</div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
          </div>
        </div>
      ))}

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-2 py-4">
          <button type="button" disabled={page <= 1} onClick={() => setPage(page - 1)}
            className="px-3 py-1.5 text-xs font-medium rounded-md border bg-white text-gray-600 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
          >Prev</button>
          <span className="text-xs text-gray-500">Page {page} of {totalPages}</span>
          <button type="button" disabled={page >= totalPages} onClick={() => setPage(page + 1)}
            className="px-3 py-1.5 text-xs font-medium rounded-md border bg-white text-gray-600 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed"
          >Next</button>
        </div>
      )}
    </div>
  );
}
