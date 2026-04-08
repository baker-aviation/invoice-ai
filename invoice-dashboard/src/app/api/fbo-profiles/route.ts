import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";

/**
 * GET /api/fbo-profiles
 *
 * Returns FBO profiles from fbo_handling_fees (JetInsight) merged with
 * fbo_website_fees (scraped from FBO chain sites) and fbo_direct_fees
 * (future email responses). Three-source comparison.
 *
 * Query params:
 *   search    - matches airport_code, fbo_name, chain (ilike)
 *   aircraft  - "Citation X" or "Challenger 300"
 *   chain     - filter by chain name
 *   hasEmail  - "true" to filter FBOs with email (from any source)
 *   is24hr    - "true" to filter 24hr FBOs
 *   page      - page number (1-based, default 1)
 *   limit     - results per page (default 50, max 200)
 */
export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const search = params.get("search")?.trim() || "";
  const aircraft = params.get("aircraft") || "";
  const chain = params.get("chain") || "";
  const hasEmail = params.get("hasEmail") === "true";
  const is24hr = params.get("is24hr") === "true";
  const page = Math.max(1, parseInt(params.get("page") || "1", 10));
  const limit = Math.min(200, Math.max(1, parseInt(params.get("limit") || "50", 10)));
  const offset = (page - 1) * limit;

  const sb = createServiceClient();

  // Build query for JetInsight data (primary source)
  let query = sb
    .from("fbo_handling_fees")
    .select("*", { count: "exact" });

  if (search) {
    const q = `%${search}%`;
    query = query.or(`airport_code.ilike.${q},fbo_name.ilike.${q},chain.ilike.${q}`);
  }
  if (aircraft) {
    query = query.eq("aircraft_type", aircraft);
  }
  if (chain) {
    query = query.ilike("chain", `%${chain}%`);
  }
  if (hasEmail) {
    query = query.neq("email", "");
  }
  if (is24hr) {
    query = query.eq("is_24hr", true);
  }

  query = query
    .order("airport_code", { ascending: true })
    .order("fbo_name", { ascending: true })
    .order("aircraft_type", { ascending: true })
    .range(offset, offset + limit - 1);

  const { data: profiles, error, count } = await query;

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Fetch matching website fees and direct fees for comparison
  const websiteFees: Record<string, Record<string, unknown>> = {};
  const directFees: Record<string, Record<string, unknown>> = {};

  if (profiles && profiles.length > 0) {
    const airports = [...new Set(profiles.map((p) => p.airport_code))];

    const [websiteRes, directRes] = await Promise.all([
      sb.from("fbo_website_fees").select("*").in("airport_code", airports),
      sb.from("fbo_direct_fees").select("*").in("airport_code", airports),
    ]);

    if (websiteRes.data) {
      for (const w of websiteRes.data) {
        websiteFees[`${w.airport_code}|${w.fbo_name}|${w.aircraft_type}`] = w;
      }
    }
    if (directRes.data) {
      for (const d of directRes.data) {
        directFees[`${d.airport_code}|${d.fbo_name}|${d.aircraft_type}`] = d;
      }
    }
  }

  // Merge all three sources
  const FEE_FIELDS = [
    "facility_fee", "gallons_to_waive", "security_fee", "landing_fee",
    "overnight_fee", "hangar_fee", "gpu_fee", "lavatory_fee", "jet_a_price",
  ] as const;

  const WEBSITE_EXTRA_FIELDS = [
    "handling_fee", "infrastructure_fee", "water_fee",
    "jet_a_additive_price", "saf_price", "hangar_info",
  ] as const;

  const merged = (profiles || []).map((p) => {
    const key = `${p.airport_code}|${p.fbo_name}|${p.aircraft_type}`;
    const website = websiteFees[key] || null;
    const direct = directFees[key] || null;

    // Use website email/city/state as fallback if JI doesn't have it
    const email = p.email || (website as Record<string, string> | null)?.email || "";
    const city = (website as Record<string, string> | null)?.city || "";
    const state = (website as Record<string, string> | null)?.state || "";

    return {
      ...p,
      email, // merged email (prefer JI, fallback to website)
      city,
      state,
      website_fees: website,
      direct_fees: direct,
    };
  });

  // Stats
  const [
    { count: totalFbos },
    { count: totalWithEmail },
    { count: totalWebsiteFees },
  ] = await Promise.all([
    sb.from("fbo_handling_fees").select("*", { count: "exact", head: true }),
    sb.from("fbo_handling_fees").select("*", { count: "exact", head: true }).neq("email", ""),
    sb.from("fbo_website_fees").select("*", { count: "exact", head: true }),
  ]);

  return NextResponse.json({
    profiles: merged,
    total: count || 0,
    page,
    limit,
    stats: {
      totalFbos: totalFbos || 0,
      totalWithEmail: totalWithEmail || 0,
      totalWebsiteFees: totalWebsiteFees || 0,
    },
  });
}
