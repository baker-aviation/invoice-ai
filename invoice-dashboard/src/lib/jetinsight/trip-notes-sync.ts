import "server-only";
import * as cheerio from "cheerio";
import { createServiceClient } from "@/lib/supabase/service";

const BASE_URL = "https://portal.jetinsight.com";
const DELAY_MS = 1000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TripFuelChoice {
  trip_id: string;
  airport_code: string;
  fbo_name: string;
  fuel_vendor: string;
  volume_tier: string;
  price_per_gallon: number;
}

export interface TripNotesResult {
  tripsScraped: number;
  fuelChoicesFound: number;
  inserted: number;
  skipped: number;
  errors: string[];
  sessionExpired: boolean;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Parse fuel choices from trip notes HTML.
 *
 * Format: "Fuel (PBI): Jet Aviation / WFS: 1+: $6.37"
 * Format: "Fuel (APF): Naples Aviation / Avfuel: 200+: $8.27"
 */
export function parseFuelChoices(html: string, tripId: string): TripFuelChoice[] {
  const $ = cheerio.load(html);
  const bodyText = $("body").text();

  const choices: TripFuelChoice[] = [];

  // Match all "Fuel (XXX): FBO / Vendor: Tier: $Price" patterns
  const fuelPattern = /Fuel\s*\(([A-Z]{3,4})\)\s*:\s*([^/\n]+?)\s*\/\s*([^:]+?)\s*:\s*([^:]+?)\s*:\s*\$([0-9]+(?:\.[0-9]+)?)/gi;

  let match;
  while ((match = fuelPattern.exec(bodyText)) !== null) {
    const airport = match[1].trim();
    const fbo = match[2].trim();
    const vendor = match[3].trim();
    const tier = match[4].trim();
    const price = parseFloat(match[5]);

    if (price > 0 && fbo && vendor) {
      // Normalize airport to ICAO
      const icao = airport.length === 3 ? `K${airport}` : airport;

      choices.push({
        trip_id: tripId,
        airport_code: icao,
        fbo_name: fbo,
        fuel_vendor: vendor,
        volume_tier: tier,
        price_per_gallon: price,
      });
    }
  }

  return choices;
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

async function fetchTripNotes(tripId: string, cookie: string): Promise<string> {
  const url = `${BASE_URL}/trips/${tripId}/notes`;
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
    throw new Error(`Fetch failed: ${res.status} ${res.statusText}`);
  }

  const html = await res.text();
  if (html.includes("sign_in") && (html.includes("Forgot your password") || html.includes("recaptcha"))) {
    throw new Error("SESSION_EXPIRED");
  }

  return html;
}

// ---------------------------------------------------------------------------
// Main sync function
// ---------------------------------------------------------------------------

/**
 * Scrape trip notes for fuel choices.
 *
 * @param daysBack — only look at trips departing within this many days ago
 * @param limit — max trips to scrape (for testing)
 */
export async function syncTripFuelChoices(
  daysBack: number = 7,
  limit?: number,
): Promise<TripNotesResult> {
  const result: TripNotesResult = {
    tripsScraped: 0,
    fuelChoicesFound: 0,
    inserted: 0,
    skipped: 0,
    errors: [],
    sessionExpired: false,
  };

  const supa = createServiceClient();

  // Get session cookie
  const { data: cookieRow } = await supa
    .from("jetinsight_config")
    .select("config_value")
    .eq("config_key", "session_cookie")
    .single();

  const cookie = cookieRow?.config_value;
  if (!cookie) {
    result.errors.push("No session cookie configured");
    return result;
  }

  // Get distinct trip IDs — look back daysBack and forward 3 days
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - daysBack);
  const future = new Date();
  future.setDate(future.getDate() + 3);

  const { data: flights } = await supa
    .from("flights")
    .select("jetinsight_trip_id, departure_icao, tail_number, salesperson, scheduled_departure")
    .not("jetinsight_trip_id", "is", null)
    .gte("scheduled_departure", cutoff.toISOString())
    .lte("scheduled_departure", future.toISOString())
    .order("scheduled_departure", { ascending: false });

  // Build lookup: trip_id|airport → { tail, salesperson, date }
  const flightInfo = new Map<string, { tail: string; salesperson: string | null; date: string }>();
  for (const f of flights ?? []) {
    if (f.jetinsight_trip_id && f.departure_icao) {
      const key = `${f.jetinsight_trip_id}|${f.departure_icao}`;
      if (!flightInfo.has(key)) {
        flightInfo.set(key, {
          tail: f.tail_number ?? "",
          salesperson: f.salesperson ?? null,
          date: f.scheduled_departure?.split("T")[0] ?? "",
        });
      }
    }
  }

  const tripIds = [...new Set((flights ?? []).map((f) => f.jetinsight_trip_id as string).filter(Boolean))];

  if (limit) tripIds.splice(limit);

  for (const tripId of tripIds) {
    try {
      const html = await fetchTripNotes(tripId, cookie);
      const choices = parseFuelChoices(html, tripId);
      result.tripsScraped++;
      result.fuelChoicesFound += choices.length;

      for (const choice of choices) {
        const info = flightInfo.get(`${choice.trip_id}|${choice.airport_code}`);
        const { error } = await supa.from("trip_fuel_choices").upsert(
          {
            jetinsight_trip_id: choice.trip_id,
            airport_code: choice.airport_code,
            fbo_name: choice.fbo_name,
            fuel_vendor: choice.fuel_vendor,
            volume_tier: choice.volume_tier,
            price_per_gallon: choice.price_per_gallon,
            salesperson: info?.salesperson ?? null,
            tail_number: info?.tail ?? null,
            flight_date: info?.date ?? null,
          },
          { onConflict: "jetinsight_trip_id,airport_code" },
        );

        if (error) {
          if (error.message.includes("duplicate")) {
            result.skipped++;
          } else {
            result.errors.push(`${tripId} ${choice.airport_code}: ${error.message}`);
          }
        } else {
          result.inserted++;
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg === "SESSION_EXPIRED") {
        result.sessionExpired = true;
        result.errors.push("Session expired — aborting");
        break;
      }
      result.errors.push(`${tripId}: ${msg}`);
    }

    await sleep(DELAY_MS);
  }

  return result;
}
