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
  // Use fuzzy matching: chain keywords + airport_code + aircraft_type
  const websiteFees: Record<string, Record<string, unknown>> = {};
  const directFees: Record<string, Record<string, unknown>> = {};

  // Normalize FBO name to a chain key for fuzzy matching across sources.
  // For chains with multiple terminals (e.g. Signature East/West/South),
  // include a terminal suffix to avoid collapsing distinct locations.
  function chainKey(name: string): string {
    const n = name.toLowerCase();

    // Extract direction suffix (east/west/south/north) to distinguish terminals.
    // Normalize "TERMINAL EAST" and just "East" to the same suffix.
    const dirMatch = n.match(/\b(east|west|south|north|central)\b/);
    const suffix = dirMatch ? "_" + dirMatch[1] : "";

    if (n.includes("signature")) return "signature" + suffix;
    if (n.includes("atlantic")) return "atlantic" + suffix;
    if (n.includes("jet aviation")) return "jet_aviation" + suffix;
    if (n.includes("million air")) return "million_air" + suffix;
    if (n.includes("sheltair")) return "sheltair" + suffix;
    if (n.includes("modern aviation")) return "modern" + suffix;
    if (n.includes("cutter")) return "cutter" + suffix;
    if (n.includes("pentastar")) return "pentastar" + suffix;
    // For independents, use normalized name (lowercase, no special chars)
    return n.replace(/[^a-z0-9]/g, "");
  }

  if (profiles && profiles.length > 0) {
    const airports = [...new Set(profiles.map((p) => p.airport_code))];

    const [websiteRes, directRes] = await Promise.all([
      sb.from("fbo_website_fees").select("*").in("airport_code", airports),
      sb.from("fbo_direct_fees").select("*").in("airport_code", airports),
    ]);

    if (websiteRes.data) {
      for (const w of websiteRes.data) {
        // Store by exact key AND chain key for fuzzy matching
        websiteFees[`${w.airport_code}|${w.fbo_name}|${w.aircraft_type}`] = w;
        websiteFees[`${w.airport_code}|${chainKey(w.fbo_name)}|${w.aircraft_type}`] = w;
      }
    }
    if (directRes.data) {
      for (const d of directRes.data) {
        directFees[`${d.airport_code}|${d.fbo_name}|${d.aircraft_type}`] = d;
        directFees[`${d.airport_code}|${chainKey(d.fbo_name)}|${d.aircraft_type}`] = d;
      }
    }
  }

  // Merge all three sources — deduplicate by chain+airport+aircraft.
  // When two rows have the same chain key (e.g. "Atlantic Aviation" and
  // "Atlantic Aviation TEB"), keep the one from jetinsight-scrape (richer).
  const merged: Array<Record<string, unknown>> = [];
  const seenMap = new Map<string, { idx: number; source: string; email: string }>();

  for (const p of profiles || []) {
    const ck = chainKey(p.fbo_name);
    const dedup = `${p.airport_code}|${ck}|${p.aircraft_type}`;

    const existing = seenMap.get(dedup);
    if (existing) {
      // Prefer jetinsight-scrape over jetinsight seed, or prefer the one with email
      const pIsBetter =
        (p.source === "jetinsight-scrape" && existing.source !== "jetinsight-scrape") ||
        (p.email && !existing.email);
      if (pIsBetter) {
        // Replace the existing entry
        merged[existing.idx] = null as unknown as Record<string, unknown>; // mark for removal
      } else {
        continue; // skip this duplicate
      }
    }

    const idx = merged.length;
    seenMap.set(dedup, { idx, source: p.source || "", email: p.email || "" });

    // Find website/direct fees by exact key first, then chain key
    const exactKey = `${p.airport_code}|${p.fbo_name}|${p.aircraft_type}`;
    const fuzzyKey = `${p.airport_code}|${ck}|${p.aircraft_type}`;
    const website = websiteFees[exactKey] || websiteFees[fuzzyKey] || null;
    const direct = directFees[exactKey] || directFees[fuzzyKey] || null;

    // Use website email/city/state as fallback if JI doesn't have it
    const email = p.email || (website as Record<string, string> | null)?.email || "";
    const city = (website as Record<string, string> | null)?.city || "";
    const state = (website as Record<string, string> | null)?.state || "";

    merged.push({
      ...p,
      email,
      city,
      state,
      website_fees: website,
      direct_fees: direct,
    });
  }

  // Remove nulled-out entries from dedup replacement
  const deduped = merged.filter(Boolean);

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
    profiles: deduped,
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
