import "server-only";
import * as cheerio from "cheerio";
import { createServiceClient } from "@/lib/supabase/service";

const BASE_URL = "https://portal.jetinsight.com";
const DELAY_MS = 1500; // Slightly slower than normal scraping — one-time job
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// One tail per aircraft type — fees are per-type, not per-tail
const AIRCRAFT_TAILS: { tail: string; type: string }[] = [
  { tail: "N371DB", type: "Challenger 300" },  // CL30
  { tail: "N51GB", type: "Citation X" },        // C750
];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ScrapedFbo {
  airport_icao: string;
  airport_faa: string;
  aircraft_tail: string;
  aircraft_type: string;
  fbo_name: string;
  phone: string;
  hours: string;
  avgas_price: number | null;
  jet_a_price: number | null;
  preferred: boolean;
  landing_fee: number | null;
  facility_fee: number | null;
  gallons_to_waive: number | null;
  security_fee: number | null;
  overnight_fee: number | null;
  parking_info: string;
  ji_uuid: string | null;
  email: string;
  url: string;
  services: string[];
}

export interface AirportScrapeResult {
  icao: string;
  faa: string;
  aircraft_type: string;
  aircraft_tail: string;
  landing_fee: number | null;
  fbos: ScrapedFbo[];
  error?: string;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Parse "$1,224 / 404 gals" → { fee: 1224, gallons: 404 }
 */
function parseHandlingFee(text: string): { fee: number | null; gallons: number | null } {
  if (!text.trim()) return { fee: null, gallons: null };

  const match = text.match(/\$([0-9,]+(?:\.\d+)?)\s*\/\s*([0-9,]+(?:\.\d+)?)\s*gal/i);
  if (match) {
    return {
      fee: parseFloat(match[1].replace(/,/g, "")),
      gallons: parseFloat(match[2].replace(/,/g, "")),
    };
  }

  const feeOnly = text.match(/\$([0-9,]+(?:\.\d+)?)/);
  if (feeOnly) {
    return { fee: parseFloat(feeOnly[1].replace(/,/g, "")), gallons: null };
  }

  return { fee: null, gallons: null };
}

/**
 * Parse "$235" → 235
 */
function parseDollarAmount(text: string): number | null {
  const match = text.match(/\$([0-9,]+(?:\.\d+)?)/);
  return match ? parseFloat(match[1].replace(/,/g, "")) : null;
}

/**
 * Parse "$1,237, 0 night / 0% waived with 0 gals" → { fee: 1237, info: "..." }
 */
function parseOvernightFee(text: string): { fee: number | null; info: string } {
  if (!text.trim()) return { fee: null, info: "" };

  const dollarMatch = text.match(/\$([0-9,]+(?:\.\d+)?)/);
  const fee = dollarMatch ? parseFloat(dollarMatch[1].replace(/,/g, "")) : null;

  const info = text.replace(/^\$[0-9,]+(?:\.\d+)?,?\s*/, "").trim();
  return { fee, info };
}

/**
 * Parse the HTML from /airports/{ICAO}?aircraft={tail}.
 * Extracts landing fee + FBO data from both tables.
 */
export function parseAirportPage(
  html: string,
  icao: string,
  aircraftTail: string,
  aircraftType: string,
): { landingFee: number | null; fbos: ScrapedFbo[] } {
  const $ = cheerio.load(html);
  const faa = icao.length === 4 && icao.startsWith("K") ? icao.slice(1) : icao;

  // Parse "Landing fee: $178" text
  let landingFee: number | null = null;
  const bodyText = $("body").text();
  const landingMatch = bodyText.match(/Landing fee:\s*\$([0-9,]+(?:\.\d+)?)/i);
  if (landingMatch) {
    landingFee = parseFloat(landingMatch[1].replace(/,/g, ""));
  }

  // Two tables:
  // Table 1: Name, Phone, Hours, Avgas price, Jet A price, Preferred
  // Table 2: Name, Ground handling fee, Security/Infrastructure/Ramp fee, Overnight/Parking fee
  const tables = $("table");
  if (tables.length === 0) return { landingFee, fbos: [] };

  const fboMap = new Map<string, Partial<ScrapedFbo>>();

  // Parse first table (contact info + fuel prices)
  if (tables.length >= 1) {
    const rows = $(tables[0]).find("tbody tr, tr").not("thead tr");
    rows.each((_, row) => {
      const cells = $(row).find("td");
      if (cells.length < 2) return;

      const nameCell = $(cells[0]);
      const name = nameCell.text().trim().replace(/\s*✏️?\s*$/, "").trim();
      if (!name || name === "Name") return;

      // Extract JetInsight FBO UUID from links in the row
      const rowHtml = $(row).html() || "";
      const uuidMatch = rowHtml.match(/airport_fbos\/([a-f0-9-]{36})/);
      const ji_uuid = uuidMatch ? uuidMatch[1] : null;

      const phone = cells.length > 1 ? $(cells[1]).text().trim() : "";
      const hours = cells.length > 2 ? $(cells[2]).text().trim() : "";
      const avgasText = cells.length > 3 ? $(cells[3]).text().trim() : "";
      const jetAText = cells.length > 4 ? $(cells[4]).text().trim() : "";
      const preferred = cells.length > 5
        ? $(cells[5]).text().trim().toLowerCase() === "yes" || $(cells[5]).find("input:checked").length > 0
        : false;

      fboMap.set(name.toLowerCase(), {
        fbo_name: name,
        phone,
        hours,
        avgas_price: parseDollarAmount(avgasText),
        jet_a_price: parseDollarAmount(jetAText),
        preferred,
        ji_uuid,
      });
    });
  }

  // Parse second table (fees)
  if (tables.length >= 2) {
    const rows = $(tables[1]).find("tbody tr, tr").not("thead tr");
    rows.each((_, row) => {
      const cells = $(row).find("td");
      if (cells.length < 2) return;

      const nameCell = $(cells[0]);
      const name = nameCell.text().trim().replace(/\s*✏️?\s*$/, "").trim();
      if (!name || name === "Name") return;

      const handlingText = cells.length > 1 ? $(cells[1]).text().trim() : "";
      const securityText = cells.length > 2 ? $(cells[2]).text().trim() : "";
      const overnightText = cells.length > 3 ? $(cells[3]).text().trim() : "";

      const { fee, gallons } = parseHandlingFee(handlingText);
      const securityFee = parseDollarAmount(securityText);
      const { fee: overnightFee, info: parkingInfo } = parseOvernightFee(overnightText);

      const key = name.toLowerCase();
      const existing = fboMap.get(key) || { fbo_name: name };
      fboMap.set(key, {
        ...existing,
        facility_fee: fee,
        gallons_to_waive: gallons,
        security_fee: securityFee,
        overnight_fee: overnightFee,
        parking_info: parkingInfo,
      });
    });
  }

  const fbos: ScrapedFbo[] = [];
  for (const entry of fboMap.values()) {
    fbos.push({
      airport_icao: icao,
      airport_faa: faa,
      aircraft_tail: aircraftTail,
      aircraft_type: aircraftType,
      fbo_name: entry.fbo_name || "",
      phone: entry.phone || "",
      hours: entry.hours || "",
      avgas_price: entry.avgas_price ?? null,
      jet_a_price: entry.jet_a_price ?? null,
      preferred: entry.preferred || false,
      landing_fee: landingFee,
      facility_fee: entry.facility_fee ?? null,
      gallons_to_waive: entry.gallons_to_waive ?? null,
      security_fee: entry.security_fee ?? null,
      overnight_fee: entry.overnight_fee ?? null,
      parking_info: entry.parking_info || "",
      ji_uuid: entry.ji_uuid ?? null,
      email: entry.email || "",
      url: entry.url || "",
      services: entry.services || [],
    });
  }

  return { landingFee, fbos };
}

// ---------------------------------------------------------------------------
// FBO Detail Modal (email, URL, services)
// ---------------------------------------------------------------------------

/**
 * Fetch the FBO detail modal via Rails UJS AJAX endpoint.
 * Returns a JS snippet containing escaped HTML with contact info and services.
 */
async function fetchFboDetail(uuid: string, cookie: string): Promise<string> {
  const url = `${BASE_URL}/airport_fbos/${uuid}/edit?info_only=true`;
  const res = await fetch(url, {
    method: "GET",
    headers: {
      Cookie: cookie,
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Baker-Aviation-Sync/1.0",
      Accept: "text/javascript, application/javascript",
      "X-Requested-With": "XMLHttpRequest",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    throw new Error(`FBO detail fetch failed: ${res.status} for ${uuid}`);
  }

  return res.text();
}

/**
 * Parse the JS response from the FBO detail modal to extract
 * email, URL, and services list.
 */
export function parseFboDetail(js: string): { email: string; url: string; services: string[] } {
  let email = "";
  let url = "";
  const services: string[] = [];

  // Email: look for "Email</label></div>\n  <div class="col-sm-8">value</div>"
  const emailMatch = js.match(/Email<\\\/label><\\\/div>\\n\s*<div class=\\"col-sm-8\\">([^<\\]+)/);
  if (emailMatch) email = emailMatch[1].trim();

  // URL
  const urlMatch = js.match(/URL<\\\/label><\\\/div>\\n\s*<div class=\\"col-sm-8\\">([^<\\]+)/);
  if (urlMatch) url = urlMatch[1].trim();

  // Services: split on <\/br> to get "Category: item1, item2" lines
  const servicesMatch = js.match(/Services<\\\/label><\\\/div>\\n\s*<div class=\\"col-sm-8\\">([^"]*?)\\n\s*<\\\/div>/);
  if (servicesMatch) {
    const raw = servicesMatch[1];
    const parts = raw.split(/<\\\/br>/);
    for (const part of parts) {
      // Strip HTML tags and clean up
      const clean = part
        .replace(/<[^>]*>/g, "")
        .replace(/\\"/g, '"')
        .replace(/\\\//g, "/")
        .replace(/\\n/g, "")
        .trim();
      if (clean && clean.length > 2) {
        services.push(clean);
      }
    }
  }

  return { email, url, services };
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

async function fetchAirportPage(icao: string, tail: string, cookie: string): Promise<string> {
  const url = `${BASE_URL}/airports/${icao}?aircraft=${tail}`;
  const res = await fetch(url, {
    method: "GET",
    headers: {
      Cookie: cookie,
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Baker-Aviation-Sync/1.0",
      Accept: "text/html,application/xhtml+xml",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    throw new Error(`Fetch failed: ${res.status} ${res.statusText} for ${url}`);
  }

  const html = await res.text();

  if (html.includes("sign_in") && (html.includes("Forgot your password") || html.includes("recaptcha"))) {
    throw new Error("SESSION_EXPIRED");
  }

  return html;
}

// ---------------------------------------------------------------------------
// FAA → ICAO conversion
// ---------------------------------------------------------------------------

function faaToIcao(faa: string): string {
  const code = faa.toUpperCase().trim();
  if (code.length === 4) return code;
  if (code.length === 3) return `K${code}`;
  return code;
}

// ---------------------------------------------------------------------------
// Main scrape function
// ---------------------------------------------------------------------------

/**
 * Scrape FBO data from JetInsight airport pages.
 * Hits each airport twice: once per aircraft type (CL30, C750).
 */
export async function scrapeFboAirports(
  options: {
    airports?: string[];
    cookie?: string;
    dryRun?: boolean;
    limit?: number;
    offset?: number;
    includeDetails?: boolean;
  } = {},
): Promise<{ results: AirportScrapeResult[]; totalFbos: number; totalAirports: number; errors: string[] }> {
  const supa = createServiceClient();

  let cookie = options.cookie;
  if (!cookie) {
    const { data } = await supa
      .from("jetinsight_config")
      .select("config_value")
      .eq("config_key", "session_cookie")
      .single();
    cookie = data?.config_value;
  }
  if (!cookie) throw new Error("No JetInsight session cookie configured");

  // Build airport list
  let airportCodes: string[];
  if (options.airports?.length) {
    airportCodes = options.airports.map(c => faaToIcao(c));
  } else {
    const { data: flights } = await supa
      .from("flights")
      .select("departure_icao, arrival_icao")
      .not("departure_icao", "is", null);

    const codes = new Set<string>();
    for (const f of flights || []) {
      if (f.departure_icao) codes.add(f.departure_icao.toUpperCase());
      if (f.arrival_icao) codes.add(f.arrival_icao.toUpperCase());
    }
    airportCodes = [...codes].sort();
  }

  const totalAirports = airportCodes.length;
  if (options.offset) {
    airportCodes = airportCodes.slice(options.offset);
  }
  if (options.limit) {
    airportCodes = airportCodes.slice(0, options.limit);
  }

  const results: AirportScrapeResult[] = [];
  const errors: string[] = [];
  let totalFbos = 0;
  let aborted = false;

  for (const icao of airportCodes) {
    if (aborted) break;
    const faa = icao.length === 4 && icao.startsWith("K") ? icao.slice(1) : icao;

    // Scrape once per aircraft type
    for (const { tail, type: aircraftType } of AIRCRAFT_TAILS) {
      if (aborted) break;

      try {
        const html = await fetchAirportPage(icao, tail, cookie);
        const { landingFee, fbos } = parseAirportPage(html, icao, tail, aircraftType);

        // Optionally fetch FBO detail modals for email/URL/services
        if (options.includeDetails) {
          for (const fbo of fbos) {
            if (!fbo.ji_uuid) continue;
            try {
              await sleep(DELAY_MS);
              const js = await fetchFboDetail(fbo.ji_uuid, cookie);
              const detail = parseFboDetail(js);
              fbo.email = detail.email;
              fbo.url = detail.url;
              fbo.services = detail.services;
            } catch (detailErr) {
              const msg = detailErr instanceof Error ? detailErr.message : String(detailErr);
              if (msg === "SESSION_EXPIRED") {
                errors.push(`Session expired fetching detail for ${fbo.fbo_name} at ${icao}`);
                aborted = true;
                break;
              }
              errors.push(`Detail ${fbo.fbo_name}@${icao}: ${msg}`);
            }
          }
        }

        results.push({ icao, faa, aircraft_type: aircraftType, aircraft_tail: tail, landing_fee: landingFee, fbos });
        totalFbos += fbos.length;

        if (!options.dryRun && fbos.length > 0) {
          for (const fbo of fbos) {
            if (fbo.facility_fee == null && fbo.gallons_to_waive == null && fbo.security_fee == null) {
              continue; // Skip PRIVATE FBOs with no fee data
            }

            const is24hr = /24\s*h|24\/7|always\s*open/i.test(fbo.hours);
            const upsertData: Record<string, unknown> = {
              airport_code: faa,
              fbo_name: fbo.fbo_name,
              chain: "",
              aircraft_type: aircraftType,
              facility_fee: fbo.facility_fee,
              gallons_to_waive: fbo.gallons_to_waive,
              security_fee: fbo.security_fee,
              landing_fee: landingFee,
              overnight_fee: fbo.overnight_fee,
              parking_info: fbo.parking_info || null,
              jet_a_price: fbo.jet_a_price,
              hours: fbo.hours || null,
              phone: fbo.phone || null,
              is_24hr: is24hr,
              source: "jetinsight-scrape",
            };
            // Include detail fields only when we actually fetched them
            if (options.includeDetails && fbo.ji_uuid) {
              upsertData.ji_fbo_uuid = fbo.ji_uuid;
              upsertData.email = fbo.email || "";
              upsertData.url = fbo.url || "";
              upsertData.services = fbo.services || [];
              upsertData.ji_source_updated_at = new Date().toISOString();
            }
            await supa.from("fbo_handling_fees").upsert(
              upsertData,
              { onConflict: "airport_code,fbo_name,aircraft_type" },
            );
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg === "SESSION_EXPIRED") {
          errors.push(`Session expired at ${icao} (${aircraftType}) — aborting`);
          aborted = true;
          break;
        }
        errors.push(`${icao} (${aircraftType}): ${msg}`);
        results.push({ icao, faa, aircraft_type: aircraftType, aircraft_tail: tail, landing_fee: null, fbos: [], error: msg });
      }

      await sleep(DELAY_MS);
    }
  }

  return { results, totalFbos, totalAirports, errors };
}
