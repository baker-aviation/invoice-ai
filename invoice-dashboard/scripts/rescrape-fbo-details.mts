/**
 * Re-scrape FBO detail modals (email/URL/services) for all records missing ji_fbo_uuid.
 * Runs directly — no HTTP timeout.
 *
 * Usage: node --experimental-strip-types scripts/rescrape-fbo-details.mts
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import * as cheerio from "cheerio";
import { createClient } from "@supabase/supabase-js";

const BASE_URL = "https://portal.jetinsight.com";
const DELAY_MS = 1500;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const AIRCRAFT_TAILS = [
  { tail: "N371DB", type: "Challenger 300" },
  { tail: "N51GB", type: "Citation X" },
];

const supa = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

// Get session cookie
async function getCookie(): Promise<string> {
  const { data } = await supa
    .from("jetinsight_config")
    .select("config_value")
    .eq("config_key", "session_cookie")
    .single();
  if (!data?.config_value) throw new Error("No JetInsight session cookie");
  return data.config_value;
}

async function fetchPage(url: string, cookie: string): Promise<string> {
  const res = await fetch(url, {
    headers: {
      Cookie: cookie,
      "User-Agent": "Mozilla/5.0 Baker-Aviation-Sync/1.0",
      Accept: "text/html,application/xhtml+xml",
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`${res.status} for ${url}`);
  const html = await res.text();
  if (html.includes("sign_in") && html.includes("Forgot your password"))
    throw new Error("SESSION_EXPIRED");
  return html;
}

async function fetchFboDetail(uuid: string, cookie: string): Promise<string> {
  const res = await fetch(`${BASE_URL}/airport_fbos/${uuid}/edit?info_only=true`, {
    headers: {
      Cookie: cookie,
      "User-Agent": "Mozilla/5.0 Baker-Aviation-Sync/1.0",
      Accept: "text/javascript, application/javascript",
      "X-Requested-With": "XMLHttpRequest",
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Detail fetch ${res.status} for ${uuid}`);
  return res.text();
}

function parseFboDetail(js: string): { email: string; url: string; services: string[] } {
  let email = "";
  let url = "";
  const services: string[] = [];

  const emailMatch = js.match(/Email<\\\/label><\\\/div>\\n\s*<div class=\\"col-sm-8\\">([^<\\]+)/);
  if (emailMatch) email = emailMatch[1].trim();

  const urlMatch = js.match(/URL<\\\/label><\\\/div>\\n\s*<div class=\\"col-sm-8\\">([^<\\]+)/);
  if (urlMatch) url = urlMatch[1].trim();

  const servicesMatch = js.match(/Services<\\\/label><\\\/div>\\n\s*<div class=\\"col-sm-8\\">([^"]*?)\\n\s*<\\\/div>/);
  if (servicesMatch) {
    const parts = servicesMatch[1].split(/<\\\/br>/);
    for (const part of parts) {
      const clean = part.replace(/<[^>]*>/g, "").replace(/\\"/g, '"').replace(/\\\//g, "/").replace(/\\n/g, "").trim();
      if (clean && clean.length > 2) services.push(clean);
    }
  }
  return { email, url, services };
}

async function main() {
  const cookie = await getCookie();
  console.log("Got session cookie");

  // Get airports missing detail data
  const { data: missing } = await supa
    .from("fbo_handling_fees")
    .select("airport_code")
    .or("ji_fbo_uuid.is.null,ji_fbo_uuid.eq.");

  const airports = [...new Set(missing?.map((r) => r.airport_code))].sort();
  console.log(`${airports.length} airports need detail re-scrape`);

  let totalUpdated = 0;
  let totalErrors = 0;
  let sessionDead = false;

  for (let i = 0; i < airports.length; i++) {
    if (sessionDead) break;
    const faa = airports[i];
    const icao = faa.length === 3 ? `K${faa}` : faa;

    for (const { tail, type: aircraftType } of AIRCRAFT_TAILS) {
      if (sessionDead) break;

      try {
        const html = await fetchPage(`${BASE_URL}/airports/${icao}?aircraft=${tail}`, cookie);
        const $ = cheerio.load(html);

        // Extract UUIDs from the first table
        const tables = $("table");
        if (tables.length === 0) continue;

        const rows = $(tables[0]).find("tbody tr, tr").not("thead tr");
        const fboUuids: { name: string; uuid: string }[] = [];

        rows.each((_, row) => {
          const cells = $(row).find("td");
          if (cells.length < 2) return;
          const name = $(cells[0]).text().trim().replace(/\s*✏️?\s*$/, "").trim();
          if (!name || name === "Name") return;
          const rowHtml = $(row).html() || "";
          const uuidMatch = rowHtml.match(/airport_fbos\/([a-f0-9-]{36})/);
          if (uuidMatch) fboUuids.push({ name, uuid: uuidMatch[1] });
        });

        // Fetch detail for each FBO with a UUID
        for (const { name, uuid } of fboUuids) {
          try {
            await sleep(DELAY_MS);
            const js = await fetchFboDetail(uuid, cookie);
            const detail = parseFboDetail(js);

            // Update the DB record
            const { error } = await supa
              .from("fbo_handling_fees")
              .update({
                ji_fbo_uuid: uuid,
                email: detail.email || "",
                url: detail.url || "",
                services: detail.services || [],
                ji_source_updated_at: new Date().toISOString(),
              })
              .eq("airport_code", faa)
              .eq("fbo_name", name)
              .eq("aircraft_type", aircraftType);

            if (!error) {
              totalUpdated++;
              if (detail.email) process.stdout.write(`✓`);
              else process.stdout.write(`.`);
            } else {
              process.stdout.write(`x`);
              totalErrors++;
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (msg === "SESSION_EXPIRED") { sessionDead = true; break; }
            process.stdout.write(`!`);
            totalErrors++;
          }
        }

        await sleep(DELAY_MS);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg === "SESSION_EXPIRED") { sessionDead = true; break; }
        // 404 = airport not in JI, skip silently
        if (!msg.includes("404")) {
          console.error(`\n  Error ${faa}/${aircraftType}: ${msg}`);
          totalErrors++;
        }
      }
    }

    if ((i + 1) % 20 === 0) {
      console.log(`\n  [${i + 1}/${airports.length}] Updated: ${totalUpdated}, Errors: ${totalErrors}`);
    }
  }

  if (sessionDead) console.error("\n!! SESSION EXPIRED — re-paste cookie and re-run");

  console.log(`\n\nDone! Updated ${totalUpdated} FBO records. Errors: ${totalErrors}`);

  // Final stats
  const { count: withEmail } = await supa.from("fbo_handling_fees").select("*", { count: "exact", head: true }).neq("email", "").not("email", "is", null);
  const { count: total } = await supa.from("fbo_handling_fees").select("*", { count: "exact", head: true });
  const { count: hasUuid } = await supa.from("fbo_handling_fees").select("*", { count: "exact", head: true }).not("ji_fbo_uuid", "is", null).neq("ji_fbo_uuid", "");
  console.log(`\nFinal: ${total} total, ${withEmail} with email (${((withEmail!/total!)*100).toFixed(1)}%), ${hasUuid} with UUID`);
}

main().catch((e) => { console.error(e); process.exit(1); });
