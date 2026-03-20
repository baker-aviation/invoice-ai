"use client";

import { useMemo, useState } from "react";
import fboDataRaw from "@/data/fbo-fees.json";

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

const fboData = fboDataRaw as FboRecord[];

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

type AircraftFilter = "Citation X" | "Challenger 300";

export default function FBOsPage() {
  const [search, setSearch] = useState("");
  const [aircraft, setAircraft] = useState<AircraftFilter>("Citation X");

  // Get unique airports for suggestions
  const airportCodes = useMemo(() => {
    const codes = new Set<string>();
    fboData.forEach((r) => {
      if (r.airport_code) codes.add(r.airport_code.toUpperCase());
    });
    return Array.from(codes).sort();
  }, []);

  // Filter data by search + aircraft
  const filtered = useMemo(() => {
    const q = search.trim().toUpperCase();
    if (!q) return [];
    return fboData.filter((r) => {
      const matchesAircraft = r.aircraft_type === aircraft;
      const matchesSearch =
        r.airport_code.toUpperCase() === q ||
        r.icao.toUpperCase() === q ||
        (q.length >= 2 && r.airport_code.toUpperCase().includes(q)) ||
        (q.length >= 2 && r.city.toUpperCase().includes(q)) ||
        (q.length >= 2 && r.fbo_name.toUpperCase().includes(q));
      return matchesAircraft && matchesSearch;
    });
  }, [search, aircraft]);

  // Group by airport
  const grouped = useMemo(() => {
    const map = new Map<string, FboRecord[]>();
    filtered.forEach((r) => {
      const key = r.airport_code.toUpperCase();
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(r);
    });
    return map;
  }, [filtered]);

  const hasPricing = (r: FboRecord) =>
    r.facility_fee != null || r.handling_fee != null || r.jet_a_price != null;

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
            {airportCodes.slice(0, 50).map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
        </div>

        <div className="flex rounded-lg border bg-gray-100 p-0.5">
          {(["Citation X", "Challenger 300"] as const).map((ac) => (
            <button
              key={ac}
              type="button"
              onClick={() => setAircraft(ac)}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                aircraft === ac
                  ? "bg-white text-gray-900 shadow-sm"
                  : "text-gray-500 hover:text-gray-700"
              }`}
            >
              {ac}
            </button>
          ))}
        </div>

        <span className="text-xs text-gray-400">
          {airportCodes.length} airports &middot; {fboData.length / 2} FBOs &middot; Retail prices (scraped 03/20/2026)
        </span>
      </div>

      {/* Results */}
      {search.trim().length > 0 && filtered.length === 0 && (
        <div className="rounded-lg border border-gray-200 bg-white p-8 text-center text-gray-500">
          No FBOs found for &ldquo;{search}&rdquo;
        </div>
      )}

      {Array.from(grouped.entries()).map(([airportCode, records]) => (
        <div key={airportCode} className="rounded-lg border border-gray-200 bg-white shadow-sm overflow-hidden">
          {/* Airport header */}
          <div className="bg-slate-800 text-white px-5 py-3 flex items-center gap-3">
            <span className="text-lg font-bold tracking-wide">{airportCode}</span>
            {records[0]?.city && (
              <span className="text-slate-300 text-sm">
                {records[0].city}{records[0].state ? `, ${records[0].state}` : ""}
              </span>
            )}
            <span className="ml-auto text-xs text-slate-400">{records.length} FBO{records.length !== 1 ? "s" : ""}</span>
          </div>

          {/* FBO cards */}
          <div className="divide-y divide-gray-100">
            {records
              .sort((a, b) => {
                // Sort: FBOs with pricing first
                const aP = hasPricing(a) ? 0 : 1;
                const bP = hasPricing(b) ? 0 : 1;
                return aP - bP || a.chain.localeCompare(b.chain);
              })
              .map((r, i) => (
                <div key={i} className="px-5 py-4">
                  {/* FBO name + chain badge */}
                  <div className="flex items-center gap-2 mb-3">
                    <span className="font-semibold text-sm">{r.fbo_name || r.chain}</span>
                    <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${CHAIN_COLORS[r.chain] || "bg-gray-100 text-gray-700"}`}>
                      {r.chain}
                    </span>
                    {r.phone && (
                      <span className="text-xs text-gray-400 ml-auto">{r.phone}</span>
                    )}
                  </div>

                  {hasPricing(r) ? (
                    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3">
                      {/* Fees */}
                      {r.facility_fee != null && (
                        <FeeCard label="Facility Fee" value={fmt$(r.facility_fee)} />
                      )}
                      {r.handling_fee != null && (
                        <FeeCard label="Handling Fee" value={fmt$(r.handling_fee)} />
                      )}
                      {r.gallons_to_waive != null && (
                        <FeeCard label="Gallons to Waive" value={fmtGal(r.gallons_to_waive)} highlight />
                      )}
                      {r.security_fee != null && (
                        <FeeCard label="Security Fee" value={fmt$(r.security_fee)} />
                      )}
                      {r.infrastructure_fee != null && (
                        <FeeCard label="Infrastructure Fee" value={fmt$(r.infrastructure_fee)} />
                      )}
                      {r.gpu_fee != null && (
                        <FeeCard label="GPU" value={fmt$(r.gpu_fee)} />
                      )}
                      {r.hangar_fee != null && (
                        <FeeCard label="Hangar" value={fmt$(r.hangar_fee)} />
                      )}
                      {r.lavatory_fee != null && (
                        <FeeCard label="Lavatory" value={fmt$(r.lavatory_fee)} />
                      )}
                      {r.water_fee != null && (
                        <FeeCard label="Water Service" value={fmt$(r.water_fee)} />
                      )}

                      {/* Fuel prices */}
                      {r.jet_a_price != null && (
                        <FeeCard label="Jet-A (retail)" value={`$${r.jet_a_price.toFixed(2)}/gal`} fuel />
                      )}
                      {r.jet_a_additive_price != null && (
                        <FeeCard label="Jet-A + Additive" value={`$${r.jet_a_additive_price.toFixed(2)}/gal`} fuel />
                      )}
                      {r.saf_price != null && (
                        <FeeCard label="SAF" value={`$${r.saf_price.toFixed(2)}/gal`} fuel />
                      )}
                      {r.avgas_price != null && (
                        <FeeCard label="Avgas 100LL" value={`$${r.avgas_price.toFixed(2)}/gal`} fuel />
                      )}

                      {/* Text info */}
                      {r.hangar_info && (
                        <div className="col-span-2">
                          <FeeCard label="Hangar Rate" value={r.hangar_info} />
                        </div>
                      )}
                      {r.parking_info && (
                        <div className="col-span-2">
                          <FeeCard label="Parking" value={r.parking_info} />
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="text-xs text-gray-400 italic">
                      No retail pricing available — contact FBO directly
                      {r.email && <> &middot; <a href={`mailto:${r.email}`} className="text-blue-500 hover:underline">{r.email}</a></>}
                    </div>
                  )}
                </div>
              ))}
          </div>
        </div>
      ))}

      {/* Empty state */}
      {search.trim().length === 0 && (
        <div className="rounded-lg border border-dashed border-gray-300 bg-gray-50 p-12 text-center">
          <p className="text-gray-500 text-sm">
            Type an airport code (e.g. <button onClick={() => setSearch("TEB")} className="text-blue-600 hover:underline font-medium">TEB</button>,{" "}
            <button onClick={() => setSearch("VNY")} className="text-blue-600 hover:underline font-medium">VNY</button>,{" "}
            <button onClick={() => setSearch("MKC")} className="text-blue-600 hover:underline font-medium">MKC</button>) to see FBO fees and fuel prices
          </p>
          <p className="text-gray-400 text-xs mt-2">
            Data from Atlantic Aviation, Signature Flight Support, Jet Aviation, Million Air, Sheltair, Modern Aviation, Cutter Aviation, and Pentastar Aviation
          </p>
        </div>
      )}
    </div>
  );
}

function FeeCard({ label, value, highlight, fuel }: { label: string; value: string; highlight?: boolean; fuel?: boolean }) {
  return (
    <div className={`rounded-md border px-3 py-2 ${
      highlight
        ? "border-green-200 bg-green-50"
        : fuel
        ? "border-amber-200 bg-amber-50"
        : "border-gray-200 bg-gray-50"
    }`}>
      <div className="text-[10px] font-medium text-gray-500 uppercase tracking-wide">{label}</div>
      <div className={`text-sm font-semibold mt-0.5 whitespace-pre-line ${
        highlight ? "text-green-700" : fuel ? "text-amber-700" : "text-gray-900"
      }`}>
        {value}
      </div>
    </div>
  );
}
