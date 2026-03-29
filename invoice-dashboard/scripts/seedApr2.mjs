/**
 * Seed HasData flight cache for Apr 2, 2026 (next swap Wednesday).
 * Run: node scripts/seedApr2.mjs
 */

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";

// Load env
const envContent = readFileSync(".env.local", "utf8");
function env(key) {
  const m = envContent.match(new RegExp(`^${key}=(.*)$`, "m"));
  return m ? m[1].replace(/^["']|["']$/g, "") : null;
}

const SUPABASE_URL = env("NEXT_PUBLIC_SUPABASE_URL");
const SUPABASE_KEY = env("SUPABASE_SERVICE_ROLE_KEY");
const HASDATA_KEY = env("HASDATA_API_KEY");

if (!SUPABASE_URL || !SUPABASE_KEY || !HASDATA_KEY) {
  console.error("Missing env vars");
  process.exit(1);
}

const supa = createClient(SUPABASE_URL, SUPABASE_KEY);
const SWAP_DATE = "2026-04-02";
const HASDATA_URL = "https://api.hasdata.com/scrape/google/flights";

// ─── Step 1: Compute city pairs ──────────────────────────────────────────────

async function computePairs() {
  // Get crew home airports
  const { data: crew } = await supa.from("crew_members").select("home_airports").eq("active", true);
  const homeAirports = new Set();
  for (const c of crew ?? []) {
    for (const a of c.home_airports ?? []) {
      const iata = a.length === 4 && a.startsWith("K") ? a.slice(1) : a;
      if (iata.length >= 3) homeAirports.add(iata.toUpperCase());
    }
  }

  // Get swap points from flights around Apr 2
  const start = "2026-04-01T00:00:00Z";
  const end = "2026-04-03T23:59:59Z";
  const { data: flights } = await supa
    .from("flights")
    .select("departure_icao, arrival_icao, flight_type")
    .gte("scheduled_departure", start)
    .lte("scheduled_departure", end);

  const swapAirports = new Set();
  for (const f of flights ?? []) {
    const dep = f.departure_icao?.length === 4 && f.departure_icao.startsWith("K") ? f.departure_icao.slice(1) : f.departure_icao;
    const arr = f.arrival_icao?.length === 4 && f.arrival_icao.startsWith("K") ? f.arrival_icao.slice(1) : f.arrival_icao;
    if (dep) swapAirports.add(dep.toUpperCase());
    if (arr) swapAirports.add(arr.toUpperCase());
  }

  // FBO → Commercial airport aliases
  const { data: aliases } = await supa.from("airport_aliases").select("fbo_icao, commercial_icao, preferred");
  const aliasMap = new Map();
  for (const a of aliases ?? []) {
    const fbo = a.fbo_icao.length === 4 && a.fbo_icao.startsWith("K") ? a.fbo_icao.slice(1) : a.fbo_icao;
    const comm = a.commercial_icao.length === 4 && a.commercial_icao.startsWith("K") ? a.commercial_icao.slice(1) : a.commercial_icao;
    if (!aliasMap.has(fbo) || a.preferred) aliasMap.set(fbo, comm);
  }

  // Build pairs: home ↔ swap (resolving FBOs to commercial)
  const pairs = new Set();
  for (const home of homeAirports) {
    for (const swap of swapAirports) {
      const commSwap = aliasMap.get(swap) ?? swap;
      if (home === commSwap) continue;
      pairs.add(`${home}|${commSwap}`);  // oncoming: home → swap
      pairs.add(`${commSwap}|${home}`);  // offgoing: swap → home
    }
  }

  const result = [...pairs].map(p => {
    const [origin, destination] = p.split("|");
    return { origin, destination };
  });

  console.log(`Computed ${result.length} pairs from ${homeAirports.size} homes × ${swapAirports.size} swap airports`);
  return result;
}

// ─── Step 2: Check what's already cached ─────────────────────────────────────

async function getExistingPairs() {
  const { data } = await supa
    .from("hasdata_flight_cache")
    .select("origin_iata, destination_iata")
    .eq("cache_date", SWAP_DATE);
  const existing = new Set();
  for (const r of data ?? []) {
    existing.add(`${r.origin_iata}|${r.destination_iata}`);
  }
  return existing;
}

// ─── Step 3: Call HasData API ────────────────────────────────────────────────

async function searchFlights(origin, destination) {
  const params = new URLSearchParams({
    departureId: origin,
    arrivalId: destination,
    outboundDate: SWAP_DATE,
    type: "oneWay",
    adults: "1",
    travelClass: "economy",
    currency: "USD",
    sortBy: "price",
  });

  const res = await fetch(`${HASDATA_URL}?${params}`, {
    headers: { "x-api-key": HASDATA_KEY, "Content-Type": "application/json" },
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) {
    if (res.status === 429) return { offers: [], error: "rate_limited" };
    return { offers: [], error: `${res.status}` };
  }

  const data = await res.json();
  const best = data.bestFlights ?? [];
  const other = data.otherFlights ?? [];
  return { offers: [...best, ...other], error: null };
}

// ─── Step 4: Seed ────────────────────────────────────────────────────────────

async function seed() {
  const allPairs = await computePairs();
  const existing = await getExistingPairs();

  const missing = allPairs.filter(p => !existing.has(`${p.origin}|${p.destination}`));
  console.log(`${missing.length} pairs to fetch (${existing.size} already cached)`);

  if (missing.length === 0) {
    console.log("All pairs cached!");
    return;
  }

  let fetched = 0;
  let errors = 0;
  let totalOffers = 0;
  const BATCH = 50;

  for (let i = 0; i < missing.length; i += BATCH) {
    const batch = missing.slice(i, i + BATCH);
    const results = await Promise.all(batch.map(async ({ origin, destination }) => {
      try {
        const { offers, error } = await searchFlights(origin, destination);
        if (error === "rate_limited") {
          console.log(`  Rate limited at ${origin}→${destination}, waiting 5s...`);
          await new Promise(r => setTimeout(r, 5000));
          const retry = await searchFlights(origin, destination);
          return { origin, destination, offers: retry.offers, error: retry.error };
        }
        return { origin, destination, offers, error };
      } catch (e) {
        return { origin, destination, offers: [], error: e.message };
      }
    }));

    // Upsert batch
    const rows = results.map(r => ({
      cache_date: SWAP_DATE,
      origin_iata: r.origin,
      destination_iata: r.destination,
      flight_offers: JSON.stringify(r.offers),
      offer_count: r.offers.length,
      min_price: r.offers.length > 0 ? Math.min(...r.offers.map(o => o.price ?? 9999)) : null,
      has_direct: r.offers.some(o => (o.flights?.length ?? o.totalDuration ? 1 : 0) <= 1),
      fetched_at: new Date().toISOString(),
    }));

    const { error: upsertErr } = await supa.from("hasdata_flight_cache").upsert(rows, {
      onConflict: "cache_date,origin_iata,destination_iata",
    });
    if (upsertErr) console.error("  Upsert error:", upsertErr.message);

    fetched += batch.length;
    errors += results.filter(r => r.error).length;
    totalOffers += results.reduce((s, r) => s + r.offers.length, 0);

    const pct = ((fetched / missing.length) * 100).toFixed(1);
    console.log(`[${pct}%] ${fetched}/${missing.length} pairs | ${totalOffers} offers | ${errors} errors`);

    // Small delay between batches
    if (i + BATCH < missing.length) await new Promise(r => setTimeout(r, 300));
  }

  console.log(`\nDone: ${fetched} pairs fetched, ${totalOffers} offers cached, ${errors} errors`);
}

seed().catch(e => console.error("Fatal:", e));
