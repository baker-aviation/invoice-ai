const { createClient } = require("@supabase/supabase-js");
const fs = require("fs");

const envContent = fs.readFileSync(".env.local", "utf8");
function env(key) {
  const m = envContent.match(new RegExp(`^${key}=(.*)$`, "m"));
  return m ? m[1].replace(/^["']|["']$/g, "") : null;
}

const supa = createClient(env("NEXT_PUBLIC_SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"));

const COORDS = {
  KATL:[33.64,-84.43],KBOS:[42.37,-71.01],KDEN:[39.86,-104.67],KDFW:[32.90,-97.04],
  KDTW:[42.21,-83.35],KEWR:[40.69,-74.17],KIAH:[29.98,-95.34],KJFK:[40.64,-73.78],
  KORD:[41.97,-87.91],KPHX:[33.44,-112.01],KSFO:[37.62,-122.38],KTPA:[27.98,-82.53],
  KPBI:[26.68,-80.10],KCHS:[32.90,-80.04],KTEB:[40.85,-74.06],KFRG:[40.73,-73.41],
  KPTK:[42.67,-83.42],KAVP:[41.34,-75.72],KSBA:[34.43,-119.84],KCRQ:[33.13,-117.28],
  KSAN:[32.73,-117.19],KMIA:[25.80,-80.29],KFLL:[26.07,-80.15],KOPF:[25.91,-80.28],
  KBUR:[34.20,-118.36],KAPC:[38.21,-122.28],KOAK:[37.72,-122.22],KCLT:[35.21,-80.94],
  KICT:[37.65,-97.43],KMCO:[28.43,-81.31],KSAT:[29.53,-98.47],KBNA:[36.13,-86.68],
  KPHL:[39.87,-75.24],KDCA:[38.85,-77.04],KIAD:[38.95,-77.46],KMSP:[44.88,-93.22],
  KGPI:[48.31,-114.26],KSUA:[27.18,-80.22],KBFI:[47.53,-122.30],KAUS:[30.20,-97.67],
  KRSW:[26.54,-81.76],KGNV:[29.69,-82.27],KCOS:[38.81,-104.70],KSAV:[32.13,-81.20],
  KORF:[36.89,-76.20],KLAS:[36.08,-115.15],KHPN:[41.07,-73.71],KPIT:[40.49,-80.23],
  KRDU:[35.88,-78.79],KSEA:[47.45,-122.31],KCLE:[41.41,-81.85],KIND:[39.72,-86.29],
  KMCI:[39.30,-94.71],KONT:[34.06,-117.60],KBMI:[40.48,-88.92],KLGA:[40.78,-73.87],
  KMDW:[41.79,-87.75],KMKE:[42.95,-87.90],KSTL:[38.75,-90.37],KPDX:[45.59,-122.60],
  KTEX:[37.95,-107.91],KFAT:[36.78,-119.72],KSLC:[40.79,-111.98],KSMF:[38.70,-121.59],
};

async function main() {
  const sd = new Date("2026-04-01T12:00:00Z");
  const start = new Date(sd.getTime() - 86400000).toISOString();
  const end = new Date(sd.getTime() + 2*86400000).toISOString();

  const [{ data: flights }, { data: crew }] = await Promise.all([
    supa.from("flights").select("departure_icao,arrival_icao").gte("scheduled_departure",start).lte("scheduled_departure",end),
    supa.from("crew_members").select("home_airports").eq("active",true),
  ]);

  const swapAirports = new Set();
  for (const f of flights ?? []) {
    if (f.departure_icao) swapAirports.add(f.departure_icao);
    if (f.arrival_icao) swapAirports.add(f.arrival_icao);
  }
  const homeAirports = new Set();
  for (const c of crew ?? []) {
    for (const h of c.home_airports ?? []) homeAirports.add(h.length===3?`K${h}`:h);
  }

  const pairs = [];
  for (const home of homeAirports) {
    for (const swap of swapAirports) {
      if (home === swap) continue;
      if (COORDS[home] && COORDS[swap]) pairs.push([home, swap]);
    }
  }

  const { data: cached } = await supa.from("drive_time_cache").select("origin_icao,destination_icao");
  const cachedSet = new Set((cached??[]).map(r=>`${r.origin_icao}|${r.destination_icao}`));
  const uncached = pairs.filter(([o,d])=>!cachedSet.has(`${o}|${d}`));

  console.log(`Pairs: ${pairs.length}, Cached: ${pairs.length-uncached.length}, Need: ${uncached.length}`);

  let fetched=0, errs=0;
  for (const [origin,dest] of uncached.slice(0,300)) {
    const [olat,olon]=COORDS[origin], [dlat,dlon]=COORDS[dest];
    try {
      const res = await fetch(`https://router.project-osrm.org/route/v1/driving/${olon},${olat};${dlon},${dlat}?overview=false`,{signal:AbortSignal.timeout(10000)});
      const data = await res.json();
      if (data.code==="Ok"&&data.routes?.[0]) {
        await supa.from("drive_time_cache").upsert({
          origin_icao:origin,destination_icao:dest,
          duration_seconds:Math.round(data.routes[0].duration),
          distance_meters:Math.round(data.routes[0].distance),
        },{onConflict:"origin_icao,destination_icao"});
        fetched++;
        if(fetched%25===0) console.log(`  ${fetched}/${Math.min(uncached.length,300)}...`);
      } else errs++;
    } catch(e) { errs++; }
    await new Promise(r=>setTimeout(r,220));
  }
  console.log(`Done! ${fetched} fetched, ${errs} errors`);
}
main();
