import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";

export const dynamic = "force-dynamic";

/**
 * POST /api/fuel-planning/fbo-fees-lookup
 *
 * Look up merged FBO fees across the three sources
 * (fbo_direct_fees → fbo_website_fees → fbo_handling_fees)
 * for a batch of (airport, fbo_name, aircraft_type) triples.
 *
 * Precedence: direct (email) > website > JetInsight. The first non-null
 * value for each field wins.
 *
 * Body: { items: Array<{ airport: string; fbo_name: string; aircraft_type: string }> }
 * Returns: { results: Array<LookupResult> } — ordered to match the input.
 */
type LookupItem = { airport: string; fbo_name: string; aircraft_type: string };

type Fees = {
  handling_fee: number | null;
  gallons_to_waive: number | null;
  landing_fee: number | null;
  security_fee: number | null;
  overnight_fee: number | null;
};

type LookupResult = LookupItem & Fees & { source: "direct" | "website" | "jetinsight" | "mixed" | null };

function chainKey(name: string): string {
  const n = (name ?? "").toLowerCase();
  const dir = n.match(/\b(east|west|south|north|central)\b/);
  const suffix = dir ? "_" + dir[1] : "";
  if (n.includes("signature")) return "signature" + suffix;
  if (n.includes("atlantic")) return "atlantic" + suffix;
  if (n.includes("jet aviation")) return "jet_aviation" + suffix;
  if (n.includes("million air")) return "million_air" + suffix;
  if (n.includes("sheltair")) return "sheltair" + suffix;
  if (n.includes("modern aviation")) return "modern" + suffix;
  if (n.includes("cutter")) return "cutter" + suffix;
  if (n.includes("pentastar")) return "pentastar" + suffix;
  return n.replace(/[^a-z0-9]/g, "");
}

function normAirport(code: string): string {
  if (!code) return "";
  return code.length === 4 && code.startsWith("K") ? code.slice(1) : code;
}

export async function POST(req: NextRequest) {
  // Public endpoint — no auth required. Fee data is non-sensitive and
  // the crew-facing /tanker/plan/[token] page needs it without login.
  const body = await req.json().catch(() => ({}));
  const items: LookupItem[] = Array.isArray(body.items) ? body.items : [];
  if (!items.length) return NextResponse.json({ results: [] }, {
    headers: { "Cache-Control": "no-store, max-age=0" },
  });

  const airports = [...new Set(items.map((i) => normAirport(i.airport)).filter(Boolean))];
  const aircraftTypes = [...new Set(items.map((i) => i.aircraft_type).filter(Boolean))];

  const sb = createServiceClient();

  const [directRes, websiteRes, jiRes] = await Promise.all([
    sb
      .from("fbo_direct_fees")
      .select("airport_code, fbo_name, aircraft_type, facility_fee, gallons_to_waive, security_fee, landing_fee, overnight_fee")
      .in("airport_code", airports)
      .in("aircraft_type", aircraftTypes),
    sb
      .from("fbo_website_fees")
      .select("airport_code, fbo_name, aircraft_type, facility_fee, gallons_to_waive, security_fee, landing_fee, overnight_fee")
      .in("airport_code", airports)
      .in("aircraft_type", aircraftTypes),
    sb
      .from("fbo_handling_fees")
      .select("airport_code, fbo_name, aircraft_type, facility_fee, gallons_to_waive, security_fee, landing_fee, overnight_fee")
      .in("airport_code", airports)
      .in("aircraft_type", aircraftTypes),
  ]);

  type Row = {
    airport_code: string;
    fbo_name: string;
    aircraft_type: string;
    facility_fee: number | null;
    gallons_to_waive: number | null;
    security_fee: number | null;
    landing_fee: number | null;
    overnight_fee: number | null;
  };

  function buildIndex(rows: Row[] | null): Map<string, Row> {
    const idx = new Map<string, Row>();
    for (const r of rows ?? []) {
      const exact = `${r.airport_code}|${r.fbo_name}|${r.aircraft_type}`;
      const fuzzy = `${r.airport_code}|${chainKey(r.fbo_name)}|${r.aircraft_type}`;
      idx.set(exact, r);
      if (!idx.has(fuzzy)) idx.set(fuzzy, r);
    }
    return idx;
  }

  const directIdx = buildIndex(directRes.data as Row[] | null);
  const websiteIdx = buildIndex(websiteRes.data as Row[] | null);
  const jiIdx = buildIndex(jiRes.data as Row[] | null);

  const results: LookupResult[] = items.map((item) => {
    const apt = normAirport(item.airport);
    const exact = `${apt}|${item.fbo_name}|${item.aircraft_type}`;
    const fuzzy = `${apt}|${chainKey(item.fbo_name)}|${item.aircraft_type}`;
    const direct = directIdx.get(exact) ?? directIdx.get(fuzzy) ?? null;
    const website = websiteIdx.get(exact) ?? websiteIdx.get(fuzzy) ?? null;
    const ji = jiIdx.get(exact) ?? jiIdx.get(fuzzy) ?? null;

    function pick<K extends keyof Row>(field: K): { val: number | null; src: "direct" | "website" | "jetinsight" | null } {
      if (direct && direct[field] != null) return { val: direct[field] as number, src: "direct" };
      if (website && website[field] != null) return { val: website[field] as number, src: "website" };
      if (ji && ji[field] != null) return { val: ji[field] as number, src: "jetinsight" };
      return { val: null, src: null };
    }

    const handling = pick("facility_fee");
    const gallons = pick("gallons_to_waive");
    const landing = pick("landing_fee");
    const security = pick("security_fee");
    const overnight = pick("overnight_fee");

    const sources = [handling.src, gallons.src, landing.src, security.src, overnight.src].filter(Boolean) as string[];
    const unique = [...new Set(sources)];
    const source: LookupResult["source"] =
      unique.length === 0 ? null : unique.length === 1 ? (unique[0] as "direct" | "website" | "jetinsight") : "mixed";

    return {
      airport: apt,
      fbo_name: item.fbo_name,
      aircraft_type: item.aircraft_type,
      handling_fee: handling.val,
      gallons_to_waive: gallons.val,
      landing_fee: landing.val,
      security_fee: security.val,
      overnight_fee: overnight.val,
      source,
    };
  });

  return NextResponse.json({ results }, {
    headers: { "Cache-Control": "no-store, max-age=0" },
  });
}
