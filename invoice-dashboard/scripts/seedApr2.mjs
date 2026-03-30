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
const SWAP_DATE = process.argv[2] ?? "2026-04-02";
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

  // Get swap points from flights around swap date
  const sd = new Date(SWAP_DATE + "T12:00:00Z");
  const start = new Date(sd.getTime() - 86400000).toISOString();
  const end = new Date(sd.getTime() + 2 * 86400000).toISOString();
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

  // FBO → Commercial airport aliases (hardcoded — DB table is empty, aliases are in airportAliases.ts)
  const { data: dbAliases } = await supa.from("airport_aliases").select("fbo_icao, commercial_icao, preferred");
  const aliasMap = new Map();
  // DB aliases first
  for (const a of dbAliases ?? []) {
    const fbo = a.fbo_icao.length === 4 && a.fbo_icao.startsWith("K") ? a.fbo_icao.slice(1) : a.fbo_icao;
    const comm = a.commercial_icao.length === 4 && a.commercial_icao.startsWith("K") ? a.commercial_icao.slice(1) : a.commercial_icao;
    if (!aliasMap.has(fbo) || a.preferred) aliasMap.set(fbo, comm);
  }
  // Hardcoded defaults (mirrors airportAliases.ts)
  const DEFAULTS = {
    TEB: "EWR", MMU: "EWR", HPN: "JFK", OPF: "MIA", FXE: "FLL", BCT: "FLL",
    DWH: "IAH", SGR: "HOU", CXO: "IAH", ADS: "DFW", FTW: "DFW",
    VNY: "BUR", CRQ: "SAN", SMO: "LAX", HWD: "OAK", PAO: "SJC", CCR: "OAK",
    ASH: "BOS", BED: "BOS", OXC: "BDL", GAI: "IAD", JYO: "IAD", HEF: "IAD",
    PDK: "ATL", RYY: "ATL", SGJ: "JAX", ORL: "MCO", SFB: "MCO", ISM: "MCO",
    TRM: "PSP", IWA: "PHX", SDL: "PHX", FFZ: "PHX", DVT: "PHX",
    EGE: "DEN", APA: "DEN", BJC: "DEN", TWF: "BOI",
    HKY: "CLT", INT: "GSO", LFT: "MSY", BTR: "MSY", DHN: "MGM",
    PWK: "ORD", DPA: "ORD", FCM: "MSP", GRK: "AUS",
    PIE: "TPA", SPG: "TPA", VDF: "TPA", FRG: "JFK", ISP: "JFK", HVN: "BDL",
    SWF: "EWR", AGS: "ATL", JQF: "CLT", UDD: "PSP", OSU: "CMH", NUQ: "SJC",
    SUA: "PBI", BUY: "GSO", TTN: "PHL", RUE: "XNA",
    APF: "RSW", TMB: "MIA", SEF: "MCO", BZN: "BZN", JAC: "JAC", HDN: "DEN",
    SBA: "SBA", STS: "SFO", CLL: "IAH", MDD: "MAF", ACT: "DFW",
    ILG: "PHL", BAF: "BDL", BVY: "BOS", LWM: "BOS", ABE: "PHL",
    CAK: "CLE", MQS: "PHL", AAO: "CMH", CGF: "CLE",
    AIK: "CAE", SSI: "JAX", MYR: "MYR", PGA: "SLC",
    AFO: "DEN", EKS: "BZN", SUN: "BOI", TEX: "DEN",
    KPC: "OAK", APC: "OAK", GYY: "MDW", MKC: "MCI", YIP: "DTW",
    MTN: "BWI", VRB: "PBI", BFI: "SEA", JWN: "BNA", JZI: "CHS",
    TIX: "MCO", UGN: "ORD", LGB: "LGB", CMA: "BUR", MHR: "SMF",
    EDC: "AUS", FMY: "RSW", MKY: "RSW", PGD: "RSW", VNC: "SRQ",
    PTK: "DTW", SUS: "STL", OGD: "SLC", MLI: "MLI", BLM: "EWR",
    PSM: "BOS", SIG: "ORF",
  };
  for (const [fbo, comm] of Object.entries(DEFAULTS)) {
    if (!aliasMap.has(fbo)) aliasMap.set(fbo, comm);
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
  const raw = [...(data.bestFlights ?? []), ...(data.otherFlights ?? [])];

  // Transform to FlightOffer format (same as hasdata.ts searchFlights)
  const offers = raw.map((r, i) => ({
    id: String(i),
    price: { total: String(r.price), currency: "USD" },
    itineraries: [{
      duration: `PT${Math.floor(r.totalDuration / 60)}H${r.totalDuration % 60}M`,
      segments: (r.flights ?? []).map(f => ({
        departure: { iataCode: f.departureAirport?.id ?? "", at: f.departureAirport?.time ?? "" },
        arrival: { iataCode: f.arrivalAirport?.id ?? "", at: f.arrivalAirport?.time ?? "" },
        carrierCode: (f.flightNumber ?? "").split(" ")[0] ?? "",
        number: (f.flightNumber ?? "").split(" ")[1] ?? "",
        duration: `PT${Math.floor((f.duration ?? 0) / 60)}H${(f.duration ?? 0) % 60}M`,
        numberOfStops: 0,
      })),
    }],
    numberOfBookableSeats: 9,
  }));

  return { offers, error: null };
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
