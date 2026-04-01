import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";

const envContent = readFileSync(".env.local", "utf8");
function env(key) {
  const m = envContent.match(new RegExp(`^${key}=(.*)$`, "m"));
  return m ? m[1].replace(/^["']|["']$/g, "") : null;
}

const supa = createClient(env("NEXT_PUBLIC_SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"));

// Airport coordinates (subset for swap-relevant airports)
const COORDS = {
  KATL: [33.6407, -84.4277], KBOS: [42.3656, -71.0096], KDEN: [39.8561, -104.6737],
  KDFW: [32.8998, -97.0403], KDTW: [42.2124, -83.3534], KEWR: [40.6895, -74.1745],
  KIAH: [29.9844, -95.3414], KLGA: [40.7772, -73.8726], KJFK: [40.6413, -73.7781],
  KORD: [41.9742, -87.9073], KPHX: [33.4373, -112.0078], KSFO: [37.6213, -122.3790],
  KTPA: [27.9756, -82.5333], KPBI: [26.6832, -80.0956], KCHS: [32.8986, -80.0405],
  KTEB: [40.8501, -74.0608], KFRG: [40.7288, -73.4134], KPTK: [42.6655, -83.4200],
  KAVP: [41.3385, -75.7234], KSBA: [34.4262, -119.8404], KCRQ: [33.1283, -117.2803],
  KSAN: [32.7336, -117.1897], KMIA: [25.7959, -80.2870], KFLL: [26.0726, -80.1527],
  KOPF: [25.9070, -80.2784], KBUR: [34.2007, -118.3585], KAPC: [38.2132, -122.2806],
  KOAK: [37.7213, -122.2208], KCLT: [35.2140, -80.9431], KICT: [37.6499, -97.4331],
  KMCO: [28.4312, -81.3081], KSAT: [29.5337, -98.4698], KBNA: [36.1263, -86.6774],
  KMDW: [41.7868, -87.7522], KPHL: [39.8721, -75.2411], KDCA: [38.8512, -77.0402],
  KIAD: [38.9531, -77.4565], KMSP: [44.8848, -93.2223], KSTL: [38.7487, -90.3700],
  KGPI: [48.3105, -114.2560], KTEX: [37.9538, -107.9085], KLIR: [10.5933, -85.5444],
  KSUA: [27.1817, -80.2210], KBFI: [47.5300, -122.3019], KAUS: [30.1975, -97.6664],
  KRSW: [26.5362, -81.7552], KGNV: [29.6901, -82.2718], KCOS: [38.8058, -104.7007],
  KMKE: [42.9472, -87.8966], KSAV: [32.1276, -81.2021], KORF: [36.8946, -76.2012],
  KLAS: [36.0840, -115.1537], KHPN: [41.0670, -73.7076], KBHM: [33.5629, -86.7535],
  KPIT: [40.4915, -80.2329], KRDU: [35.8776, -78.7875], KPDX: [45.5887, -122.5975],
  KSEA: [47.4502, -122.3088], KCLE: [41.4058, -81.8539], KIND: [39.7173, -86.2944],
  KMCI: [39.2976, -94.7139], KONT: [34.0560, -117.6012], KMDH: [37.7810, -89.2520],
  KBMI: [40.4771, -88.9159],
};

// Get all unique airport pairs from today's swap
const swapDate = "2026-04-01";
const sd = new Date(swapDate + "T12:00:00Z");
const start = new Date(sd.getTime() - 86400000).toISOString();
const end = new Date(sd.getTime() + 2 * 86400000).toISOString();

const { data: flights } = await supa.from("flights")
  .select("departure_icao, arrival_icao")
  .gte("scheduled_departure", start).lte("scheduled_departure", end);

const { data: crew } = await supa.from("crew_members")
  .select("home_airports").eq("active", true);

// Build swap airport set
const swapAirports = new Set();
for (const f of flights ?? []) {
  if (f.departure_icao) swapAirports.add(f.departure_icao);
  if (f.arrival_icao) swapAirports.add(f.arrival_icao);
}

// Build home airport set
const homeAirports = new Set();
for (const c of crew ?? []) {
  for (const h of c.home_airports ?? []) {
    const icao = h.length === 3 ? `K${h}` : h;
    homeAirports.add(icao);
  }
}

// Generate pairs: home → swap, swap → home
const pairs = [];
for (const home of homeAirports) {
  for (const swap of swapAirports) {
    if (home === swap) continue;
    if (COORDS[home] && COORDS[swap]) {
      pairs.push([home, swap]);
    }
  }
}

// Check what's already cached
const { data: cached } = await supa.from("drive_time_cache").select("origin_icao, destination_icao");
const cachedSet = new Set((cached ?? []).map(r => `${r.origin_icao}|${r.destination_icao}`));
const uncached = pairs.filter(([o, d]) => !cachedSet.has(`${o}|${d}`));

console.log(`Total pairs: ${pairs.length}, Already cached: ${pairs.length - uncached.length}, Need OSRM: ${uncached.length}`);

// Fetch from OSRM with rate limiting
let fetched = 0, errors = 0;
for (const [origin, dest] of uncached.slice(0, 200)) { // Cap at 200 for first run
  const [olat, olon] = COORDS[origin];
  const [dlat, dlon] = COORDS[dest];
  try {
    const url = `https://router.project-osrm.org/route/v1/driving/${olon},${olat};${dlon},${dlat}?overview=false`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    const data = await res.json();
    if (data.code === "Ok" && data.routes?.[0]) {
      const mins = Math.round(data.routes[0].duration / 60);
      const miles = Math.round(data.routes[0].distance / 1609.34);
      await supa.from("drive_time_cache").upsert({
        origin_icao: origin, destination_icao: dest,
        duration_seconds: Math.round(data.routes[0].duration),
        distance_meters: Math.round(data.routes[0].distance),
      }, { onConflict: "origin_icao,destination_icao" });
      fetched++;
      if (fetched % 20 === 0) console.log(`  ${fetched}/${Math.min(uncached.length, 200)} fetched...`);
    } else {
      errors++;
    }
  } catch (e) {
    errors++;
  }
  await new Promise(r => setTimeout(r, 250)); // Rate limit
}

console.log(`Done! Fetched ${fetched}, Errors ${errors}`);
