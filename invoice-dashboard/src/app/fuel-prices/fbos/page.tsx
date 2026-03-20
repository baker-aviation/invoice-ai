"use client";

import { useEffect, useMemo, useState } from "react";
import fboDataRaw from "@/data/fbo-fees.json";

// ─── Types ──────────────────────────────────────────────────────────────────

type FboRecord = {
  chain: string;
  airport_code: string;
  icao: string;
  city: string;
  state: string;
  country: string;
  fbo_name: string;
  aircraft_type: string;
  facility_fee: number | null;
  gallons_to_waive: number | null;
  security_fee: number | null;
  parking_info: string;
  hangar_info: string;
  handling_fee: number | null;
  infrastructure_fee: number | null;
  gpu_fee: number | null;
  hangar_fee: number | null;
  lavatory_fee: number | null;
  water_fee: number | null;
  jet_a_price: number | null;
  jet_a_additive_price: number | null;
  avgas_price: number | null;
  saf_price: number | null;
  phone: string;
  email: string;
};

type InvoiceFee = {
  airport_code: string;
  vendor_name: string;
  latest_fee_date: string;
  [key: string]: any;
};

type FuelPrice = {
  airport_code: string;
  vendor: string;
  product: string;
  price: number;
  volume_tier: string;
  week_start: string;
};

type InvoiceData = { fees: InvoiceFee[]; fuel: FuelPrice[] };

const fboData = fboDataRaw as FboRecord[];

// ─── Helpers ────────────────────────────────────────────────────────────────

function fmt$(v: number | null | undefined): string {
  if (v == null) return "\u2014";
  return `$${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtGal(v: number | null | undefined): string {
  if (v == null) return "\u2014";
  return `${Math.round(v)} gal`;
}

function fmtDate(d: string): string {
  if (!d) return "";
  try { return new Date(d + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" }); }
  catch { return d; }
}

function normAirport(code: string): string {
  const c = (code ?? "").toUpperCase().trim();
  if (c.length === 4 && /^K[A-Z]{3}$/.test(c)) return c.slice(1);
  return c;
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

const FEE_KEYS = [
  "handling_fee", "facility_fee", "security_fee", "infrastructure_fee",
  "gpu_fee", "hangar_fee", "lavatory_fee", "water_fee", "parking_fee",
  "overnight_fee", "landing_fee", "deice_fee", "catering_fee",
] as const;

const FEE_LABELS: Record<string, string> = {
  handling_fee: "Handling Fee", facility_fee: "Facility Fee",
  security_fee: "Security Fee", infrastructure_fee: "Infrastructure",
  gpu_fee: "GPU", hangar_fee: "Hangar", lavatory_fee: "Lavatory",
  water_fee: "Water Service", parking_fee: "Parking", overnight_fee: "Overnight",
  landing_fee: "Landing Fee", deice_fee: "De-Ice", catering_fee: "Catering",
};

/** Try to match an invoice vendor name to a scraped FBO chain */
function vendorMatchesChain(vendor: string, chain: string, fboName: string): boolean {
  const v = vendor.toLowerCase();
  const c = chain.toLowerCase();
  const f = fboName.toLowerCase();
  // Direct chain match
  if (c.includes("atlantic") && v.includes("atlantic")) return true;
  if (c.includes("signature") && v.includes("signature")) return true;
  if (c.includes("jet aviation") && v.includes("jet aviation")) return true;
  if (c.includes("million air") && v.includes("million air")) return true;
  if (c.includes("sheltair") && v.includes("sheltair")) return true;
  if (c.includes("modern") && v.includes("modern")) return true;
  if (c.includes("cutter") && v.includes("cutter")) return true;
  if (c.includes("pentastar") && v.includes("pentastar")) return true;
  // FBO name match
  if (f && v.includes(f.split(" ")[0])) return true;
  return false;
}

/** Try to match a fuel vendor to an FBO */
function fuelVendorMatchesFbo(fuelVendor: string, chain: string, fboName: string): boolean {
  const fv = fuelVendor.toLowerCase();
  // Fuel vendors like "Jet Aviation" or "Signature" map to FBOs
  if (chain.toLowerCase().includes("jet aviation") && fv.includes("jet aviation")) return true;
  if (chain.toLowerCase().includes("signature") && fv.includes("signature")) return true;
  if (chain.toLowerCase().includes("atlantic") && fv.includes("atlantic")) return true;
  // For third-party fuel vendors (Titan, Avfuel, etc.) — don't match to specific FBO
  return false;
}

type AircraftFilter = "Citation X" | "Challenger 300";

// ─── Component ──────────────────────────────────────────────────────────────

export default function FBOsPage() {
  const [search, setSearch] = useState("");
  const [aircraft, setAircraft] = useState<AircraftFilter>("Citation X");
  const [invoiceData, setInvoiceData] = useState<InvoiceData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/fbo-fees")
      .then((r) => r.json())
      .then((d) => setInvoiceData(d))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  // Index invoice fees by normalized airport
  const invoiceFeesByAirport = useMemo(() => {
    const map = new Map<string, InvoiceFee[]>();
    if (!invoiceData?.fees) return map;
    for (const f of invoiceData.fees) {
      const key = normAirport(f.airport_code);
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(f);
    }
    return map;
  }, [invoiceData]);

  // Index fuel by normalized airport
  const fuelByAirport = useMemo(() => {
    const map = new Map<string, FuelPrice[]>();
    if (!invoiceData?.fuel) return map;
    for (const f of invoiceData.fuel) {
      const key = normAirport(f.airport_code);
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(f);
    }
    return map;
  }, [invoiceData]);

  // All airport codes (normalized)
  const airportCodes = useMemo(() => {
    const codes = new Set<string>();
    fboData.forEach((r) => { if (r.airport_code) codes.add(normAirport(r.airport_code)); });
    invoiceData?.fees?.forEach((f) => { if (f.airport_code) codes.add(normAirport(f.airport_code)); });
    invoiceData?.fuel?.forEach((f) => { if (f.airport_code) codes.add(normAirport(f.airport_code)); });
    return Array.from(codes).sort();
  }, [invoiceData]);

  // Filter scraped data
  const filtered = useMemo(() => {
    const q = search.trim().toUpperCase();
    if (!q) return [];
    return fboData.filter((r) => {
      const code = normAirport(r.airport_code);
      const matchesAircraft = r.aircraft_type === aircraft;
      const matchesSearch =
        code === q || r.icao.toUpperCase() === q ||
        (q.length >= 2 && code.includes(q)) ||
        (q.length >= 2 && r.city.toUpperCase().includes(q)) ||
        (q.length >= 2 && r.fbo_name.toUpperCase().includes(q));
      return matchesAircraft && matchesSearch;
    });
  }, [search, aircraft]);

  // Airports with only invoice/fuel data
  const extraAirports = useMemo(() => {
    const q = search.trim().toUpperCase();
    if (!q) return new Set<string>();
    const s = new Set<string>();
    for (const code of airportCodes) {
      if (code === q || (q.length >= 2 && code.includes(q))) {
        if (invoiceFeesByAirport.has(code) || fuelByAirport.has(code)) s.add(code);
      }
    }
    return s;
  }, [search, airportCodes, invoiceFeesByAirport, fuelByAirport]);

  // Group by normalized airport
  const grouped = useMemo(() => {
    const map = new Map<string, FboRecord[]>();
    filtered.forEach((r) => {
      const key = normAirport(r.airport_code);
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(r);
    });
    for (const code of extraAirports) {
      if (!map.has(code)) map.set(code, []);
    }
    return map;
  }, [filtered, extraAirports]);

  return (
    <div className="space-y-4">
      {/* Search + aircraft toggle */}
      <div className="flex flex-wrap items-center gap-4">
        <div className="relative flex-1 max-w-md">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search airport code, city, or FBO name..."
            className="w-full rounded-lg border border-gray-300 bg-white px-4 py-2.5 text-sm shadow-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 focus:outline-none"
            list="airport-suggestions"
          />
          <datalist id="airport-suggestions">
            {airportCodes.slice(0, 50).map((c) => <option key={c} value={c} />)}
          </datalist>
        </div>
        <div className="flex rounded-lg border bg-gray-100 p-0.5">
          {(["Citation X", "Challenger 300"] as const).map((ac) => (
            <button
              key={ac} type="button" onClick={() => setAircraft(ac)}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                aircraft === ac ? "bg-white text-gray-900 shadow-sm" : "text-gray-500 hover:text-gray-700"
              }`}
            >{ac}</button>
          ))}
        </div>
        <span className="text-xs text-gray-400">
          {airportCodes.length} airports &middot; {fboData.length / 2} FBOs
          {loading && " · Loading..."}
        </span>
      </div>

      {search.trim().length > 0 && grouped.size === 0 && (
        <div className="rounded-lg border border-gray-200 bg-white p-8 text-center text-gray-500">
          No FBOs found for &ldquo;{search}&rdquo;
        </div>
      )}

      {Array.from(grouped.entries()).map(([airportCode, records]) => {
        const airportFees = invoiceFeesByAirport.get(airportCode) ?? [];
        const airportFuel = fuelByAirport.get(airportCode) ?? [];

        return (
          <div key={airportCode} className="rounded-lg border border-gray-200 bg-white shadow-sm overflow-hidden">
            <div className="bg-slate-800 text-white px-5 py-3 flex items-center gap-3">
              <span className="text-lg font-bold tracking-wide">{airportCode}</span>
              {records[0]?.city && (
                <span className="text-slate-300 text-sm">
                  {records[0].city}{records[0].state ? `, ${records[0].state}` : ""}
                </span>
              )}
              <span className="ml-auto text-xs text-slate-400">
                {records.length > 0 && `${records.length} FBO${records.length !== 1 ? "s" : ""}`}
              </span>
            </div>

            <div className="divide-y divide-gray-200">
              {/* Each FBO gets its own section */}
              {records
                .sort((a, b) => {
                  const ap = (a.facility_fee || a.handling_fee || a.jet_a_price) ? 0 : 1;
                  const bp = (b.facility_fee || b.handling_fee || b.jet_a_price) ? 0 : 1;
                  return ap - bp || a.chain.localeCompare(b.chain);
                })
                .map((r, i) => {
                  // Find invoice fees that match this FBO
                  const matchedFees = airportFees.filter((f) =>
                    vendorMatchesChain(f.vendor_name, r.chain, r.fbo_name)
                  );
                  // Find fuel prices that match this FBO
                  const matchedFuel = airportFuel.filter((f) =>
                    fuelVendorMatchesFbo(f.vendor, r.chain, r.fbo_name)
                  );

                  // Merge scraped + invoice fees
                  const mergedFees: Record<string, { value: number; source: "scraped" | "invoice" }> = {};
                  // Scraped fees first (primary)
                  if (r.facility_fee) mergedFees.facility_fee = { value: r.facility_fee, source: "scraped" };
                  if (r.handling_fee) mergedFees.handling_fee = { value: r.handling_fee, source: "scraped" };
                  if (r.security_fee) mergedFees.security_fee = { value: r.security_fee, source: "scraped" };
                  if (r.infrastructure_fee) mergedFees.infrastructure_fee = { value: r.infrastructure_fee, source: "scraped" };
                  if (r.gpu_fee) mergedFees.gpu_fee = { value: r.gpu_fee, source: "scraped" };
                  if (r.hangar_fee) mergedFees.hangar_fee = { value: r.hangar_fee, source: "scraped" };
                  if (r.lavatory_fee) mergedFees.lavatory_fee = { value: r.lavatory_fee, source: "scraped" };
                  if (r.water_fee) mergedFees.water_fee = { value: r.water_fee, source: "scraped" };
                  // Invoice fees fill gaps
                  for (const invFee of matchedFees) {
                    for (const key of FEE_KEYS) {
                      const val = invFee[key];
                      if (val != null && val > 0 && !mergedFees[key]) {
                        mergedFees[key] = { value: val, source: "invoice" };
                      }
                    }
                  }

                  // Build fuel display: scraped retail + matched contract + all airport contract prices
                  type FuelItem = { label: string; price: number; source: "scraped" | "contract"; vendor?: string; tier?: string };
                  const allFuel: FuelItem[] = [];
                  if (r.jet_a_price) allFuel.push({ label: "Jet-A", price: r.jet_a_price, source: "scraped", vendor: r.chain });
                  if (r.jet_a_additive_price) allFuel.push({ label: "Jet-A + Additive", price: r.jet_a_additive_price, source: "scraped", vendor: r.chain });
                  if (r.saf_price) allFuel.push({ label: "SAF", price: r.saf_price, source: "scraped", vendor: r.chain });
                  if (r.avgas_price) allFuel.push({ label: "Avgas 100LL", price: r.avgas_price, source: "scraped", vendor: r.chain });
                  // Include ALL contract fuel at this airport (matched + unmatched vendors)
                  for (const fp of airportFuel) {
                    allFuel.push({
                      label: fp.product,
                      price: fp.price,
                      source: "contract",
                      vendor: fp.vendor,
                      tier: fp.volume_tier !== "default" ? fp.volume_tier : undefined,
                    });
                  }

                  const hasFees = Object.keys(mergedFees).length > 0;
                  const hasFuel = allFuel.length > 0;
                  const hasAnything = hasFees || hasFuel || r.gallons_to_waive || r.hangar_info || r.parking_info;

                  // Best fuel price (lowest Jet-A variant)
                  const jetAFuels = allFuel.filter((f) => /jet.?a/i.test(f.label) && !/saf/i.test(f.label));
                  const bestFuel = jetAFuels.length > 0
                    ? jetAFuels.reduce((best, f) => f.price < best.price ? f : best)
                    : null;
                  const otherFuels = allFuel.filter((f) => f !== bestFuel);

                  return (
                    <div key={i} className="px-5 py-4">
                      {/* FBO header */}
                      <div className="flex items-center gap-2 mb-3">
                        <span className="font-semibold text-sm">{r.fbo_name || r.chain}</span>
                        <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${CHAIN_COLORS[r.chain] || "bg-gray-100 text-gray-700"}`}>
                          {r.chain}
                        </span>
                        {r.phone && <span className="text-xs text-gray-400 ml-auto">{r.phone}</span>}
                      </div>

                      {hasAnything ? (
                        <div className="flex gap-4">
                          {/* Left: fees */}
                          <div className="flex-1">
                            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2.5">
                              {Object.entries(mergedFees).map(([key, { value, source }]) => (
                                <FeeCard
                                  key={key}
                                  label={FEE_LABELS[key] || key}
                                  value={fmt$(value)}
                                  yours={source === "invoice"}
                                />
                              ))}
                              {r.gallons_to_waive != null && (
                                <FeeCard label="Gallons to Waive" value={fmtGal(r.gallons_to_waive)} highlight />
                              )}
                              {r.hangar_info && <FeeCard label="Hangar Rate" value={r.hangar_info} />}
                              {r.parking_info && <FeeCard label="Parking" value={r.parking_info} />}
                            </div>
                          </div>

                          {/* Right: fuel price box */}
                          {hasFuel && (
                            <div className="w-48 flex-shrink-0">
                              {bestFuel && (
                                <div className="rounded-lg border-2 border-amber-300 bg-amber-50 px-3 py-2.5 mb-2">
                                  <div className="text-[10px] font-medium text-amber-600 uppercase tracking-wide">
                                    Best Jet-A
                                    {bestFuel.tier && ` · ${bestFuel.tier}`}
                                  </div>
                                  <div className="text-xl font-bold text-amber-800 mt-0.5">
                                    ${bestFuel.price.toFixed(2)}
                                    <span className="text-xs font-normal">/gal</span>
                                  </div>
                                  {bestFuel.vendor && (
                                    <div className="text-[10px] text-amber-700 mt-1 font-medium">
                                      via {bestFuel.vendor}
                                    </div>
                                  )}
                                </div>
                              )}
                              {otherFuels.length > 0 && (
                                <div className="space-y-1">
                                  {otherFuels.map((f, j) => (
                                    <div key={j} className="text-xs px-1.5 py-0.5">
                                      <div className="flex items-center justify-between">
                                        <span className="text-gray-500 truncate mr-2">
                                          {f.label}{f.tier ? ` (${f.tier})` : ""}
                                        </span>
                                        <span className={`font-medium whitespace-nowrap ${
                                          f.source === "contract" ? "text-blue-700" : "text-gray-700"
                                        }`}>
                                          ${f.price.toFixed(2)}
                                        </span>
                                      </div>
                                      {f.vendor && f.vendor !== bestFuel?.vendor && (
                                        <div className="text-[9px] text-gray-400 text-right">{f.vendor}</div>
                                      )}
                                    </div>
                                  ))}
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      ) : (
                        <div className="text-xs text-gray-400 italic">
                          No pricing available — contact FBO directly
                          {r.email && <> &middot; <a href={`mailto:${r.email}`} className="text-blue-500 hover:underline">{r.email}</a></>}
                        </div>
                      )}
                    </div>
                  );
                })}

              {/* Invoice fees not matched to any scraped FBO */}
              {airportFees.filter((f) =>
                !records.some((r) => vendorMatchesChain(f.vendor_name, r.chain, r.fbo_name))
              ).length > 0 && (
                <div className="px-5 py-4 bg-blue-50/30">
                  <div className="flex items-center gap-2 mb-3">
                    <span className="font-semibold text-sm text-blue-900">Other Fees</span>
                    <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-blue-100 text-blue-800">
                      From Invoices
                    </span>
                  </div>
                  {airportFees
                    .filter((f) => !records.some((r) => vendorMatchesChain(f.vendor_name, r.chain, r.fbo_name)))
                    .map((f, i) => (
                      <div key={i} className="mb-2">
                        <div className="text-xs font-medium text-gray-600 mb-1.5">
                          {f.vendor_name}
                          {f.latest_fee_date && <span className="text-gray-400 ml-2">{fmtDate(f.latest_fee_date)}</span>}
                        </div>
                        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-2">
                          {FEE_KEYS.map((key) => {
                            const val = f[key];
                            if (val == null || val <= 0) return null;
                            return <FeeCard key={key} label={FEE_LABELS[key] || key} value={fmt$(val)} yours />;
                          })}
                        </div>
                      </div>
                    ))}
                </div>
              )}
            </div>
          </div>
        );
      })}

      {search.trim().length === 0 && (
        <div className="rounded-lg border border-dashed border-gray-300 bg-gray-50 p-12 text-center">
          <p className="text-gray-500 text-sm">
            Type an airport code (e.g.{" "}
            <button type="button" onClick={() => setSearch("TEB")} className="text-blue-600 hover:underline font-medium">TEB</button>,{" "}
            <button type="button" onClick={() => setSearch("VNY")} className="text-blue-600 hover:underline font-medium">VNY</button>,{" "}
            <button type="button" onClick={() => setSearch("MKC")} className="text-blue-600 hover:underline font-medium">MKC</button>) to see FBO fees and fuel prices
          </p>
          <p className="text-gray-400 text-xs mt-2">
            Retail fees + your invoice fees + contract fuel from price sheets
          </p>
        </div>
      )}
    </div>
  );
}

function FeeCard({ label, value, highlight, yours }: {
  label: string; value: string; highlight?: boolean; yours?: boolean;
}) {
  return (
    <div className={`rounded-md border px-3 py-2 ${
      yours ? "border-blue-200 bg-blue-50"
        : highlight ? "border-green-200 bg-green-50"
        : "border-gray-200 bg-gray-50"
    }`}>
      <div className="text-[10px] font-medium text-gray-500 uppercase tracking-wide">{label}</div>
      <div className={`text-sm font-semibold mt-0.5 whitespace-pre-line ${
        yours ? "text-blue-800" : highlight ? "text-green-700" : "text-gray-900"
      }`}>{value}</div>
    </div>
  );
}
