// HasData Google Flights API client for commercial flight search
// Docs: https://docs.hasdata.com/apis/google-travel/flights
// Scrapes Google Flights and returns structured flight data with real pricing.

import type { FlightOffer, FlightSearchResult } from "./amadeus";
import { getAirportTimezone } from "./airportTimezones";
import { BUDGET_CARRIERS } from "./swapRules";

const API_KEY = process.env.HASDATA_API_KEY!;
const BASE_URL = "https://api.hasdata.com/scrape/google/flights";

// ─── Types (HasData response) ────────────────────────────────────────────────

type HdAirport = {
  id: string;
  name: string;
  time: string; // "2026-03-15 5:50"
};

type HdFlight = {
  departureAirport: HdAirport;
  arrivalAirport: HdAirport;
  duration: number; // minutes
  airplane: string;
  airline: string;
  flightNumber: string;
  legroom?: string;
  travelClass?: string;
  oftenDelayedByOver30Min?: boolean;
};

type HdResult = {
  price: number;
  type: string;
  totalDuration: number; // minutes
  flights: HdFlight[];
  bookingToken?: string;
};

type HdResponse = {
  requestMetadata: { id: string; status: string };
  bestFlights?: HdResult[];
  otherFlights?: HdResult[];
};

// ─── Flight search ───────────────────────────────────────────────────────────

/**
 * Search one-way commercial flights via HasData (Google Flights scraper).
 * Returns up to `max` cheapest offers sorted by price.
 */
export async function searchFlights(params: {
  origin: string;      // IATA or ICAO code
  destination: string;
  date: string;        // YYYY-MM-DD
  adults?: number;
  max?: number;
}): Promise<FlightSearchResult> {
  const { origin, destination, date, adults = 1, max = 10 } = params;

  const orig = icaoToIata(origin);
  const dest = icaoToIata(destination);

  const qs = new URLSearchParams({
    departureId: orig,
    arrivalId: dest,
    outboundDate: date,
    type: "oneWay",
    adults: String(adults),
    travelClass: "economy",
    currency: "USD",
    sortBy: "price",
  });

  const res = await fetch(`${BASE_URL}?${qs}`, {
    headers: {
      "x-api-key": API_KEY,
      "Content-Type": "application/json",
    },
  });

  const text = await res.text();

  if (!res.ok) {
    console.warn(`HasData ${res.status} for ${orig}->${dest} on ${date}: ${text.slice(0, 200)}`);
    if (res.status === 400 || res.status === 401 || res.status === 429 || res.status === 402) {
      return { origin: orig, destination: dest, date, offers: [], count: 0 };
    }
    throw new Error(`HasData search failed (${res.status}): ${text.slice(0, 200)}`);
  }

  let data: HdResponse;
  try {
    data = JSON.parse(text);
  } catch {
    console.warn(`HasData returned non-JSON for ${orig}->${dest}: ${text.slice(0, 200)}`);
    return { origin: orig, destination: dest, date, offers: [], count: 0 };
  }

  console.log(`[HasData] ${orig}->${dest} ${date}: status=${data.requestMetadata?.status} best=${(data.bestFlights ?? []).length} other=${(data.otherFlights ?? []).length}`);

  // Combine bestFlights + otherFlights, prefer major carriers over budget
  const all = [...(data.bestFlights ?? []), ...(data.otherFlights ?? [])];
  const filtered = filterBudgetCarriers(all);
  const limited = filtered.slice(0, max);

  const offers: FlightOffer[] = limited.map((r, i) => ({
    id: String(i),
    price: { total: String(r.price), currency: "USD" },
    itineraries: [{
      duration: minutesToIsoDuration(r.totalDuration),
      segments: r.flights.map((f) => ({
        departure: {
          iataCode: f.departureAirport.id,
          at: parseHdTime(f.departureAirport.time, f.departureAirport.id),
        },
        arrival: {
          iataCode: f.arrivalAirport.id,
          at: parseHdTime(f.arrivalAirport.time, f.arrivalAirport.id),
        },
        carrierCode: f.flightNumber.split(" ")[0] ?? f.airline,
        number: f.flightNumber.split(" ")[1] ?? "",
        duration: minutesToIsoDuration(f.duration),
        numberOfStops: 0,
      })),
    }],
    numberOfBookableSeats: 9, // Google Flights doesn't provide seat count
  }));

  return { origin: orig, destination: dest, date, offers, count: offers.length };
}

// ─── Budget carrier filter ────────────────────────────────────────────────────

/**
 * Remove budget carrier flights (Spirit, Frontier, Allegiant) UNLESS they are
 * the only option. If ANY non-budget flight exists, all budget flights are
 * dropped — even if the budget flight is half the price.
 *
 * A flight is "budget" if ALL of its legs are operated by budget carriers.
 * Mixed itineraries (e.g. AA leg + NK leg) are treated as non-budget.
 */
function filterBudgetCarriers(results: HdResult[]): HdResult[] {
  if (results.length === 0) return results;

  const isBudget = (r: HdResult) =>
    r.flights.length > 0 &&
    r.flights.every((f) => {
      const carrier = (f.flightNumber?.split(" ")[0] ?? "").toUpperCase();
      return BUDGET_CARRIERS.includes(carrier);
    });

  const major = results.filter((r) => !isBudget(r));

  // If no major carrier options exist, allow budget as last resort
  if (major.length === 0) return results;

  return major;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Convert "2026-03-15 5:50" (local airport time) to UTC ISO string.
 *  HasData returns times in the airport's local timezone. We need UTC
 *  so the optimizer's timing calculations are correct. */
function parseHdTime(timeStr: string, airportIata: string): string {
  const [datePart, timePart] = timeStr.split(" ");
  if (!timePart) return `${datePart}T00:00:00Z`;
  const [h, m] = timePart.split(":");
  const localStr = `${datePart}T${h.padStart(2, "0")}:${m.padStart(2, "0")}:00`;

  // Look up airport timezone (try IATA as-is, then with K prefix for US airports)
  const tz = getAirportTimezone(`K${airportIata}`) ?? getAirportTimezone(airportIata);
  if (!tz) {
    // No timezone found — assume US Eastern as fallback
    return localToUtc(localStr, "America/New_York");
  }
  return localToUtc(localStr, tz);
}

/** Convert a local datetime string to UTC ISO string using IANA timezone.
 *  Uses iterative approach: treat local time as UTC, check what local time
 *  that corresponds to, then adjust by the difference. */
function localToUtc(localIso: string, tz: string): string {
  const [date, time] = localIso.split("T");
  const [y, mo, d] = date.split("-").map(Number);
  const [hr, mi] = (time ?? "00:00").split(":").map(Number);

  // Guess: assume local time = UTC, then see what local time that produces
  const guess = new Date(Date.UTC(y, mo - 1, d, hr, mi, 0));

  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  });
  const parts = fmt.formatToParts(guess);
  const get = (t: string) => parseInt(parts.find((p) => p.type === t)?.value ?? "0");
  const localH = get("hour") === 24 ? 0 : get("hour");
  const localM = get("minute");
  const localD = get("day");

  // Offset in minutes between what we wanted (hr:mi) and what we got (localH:localM)
  const wantedMin = d * 1440 + hr * 60 + mi;
  const gotMin = localD * 1440 + localH * 60 + localM;
  const diffMs = (wantedMin - gotMin) * 60_000;

  const utc = new Date(guess.getTime() + diffMs);
  return utc.toISOString();
}

/** Convert minutes to ISO 8601 duration: 141 → "PT2H21M" */
function minutesToIsoDuration(mins: number): string {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h === 0) return `PT${m}M`;
  if (m === 0) return `PT${h}H`;
  return `PT${h}H${m}M`;
}

// ─── ICAO to IATA conversion ─────────────────────────────────────────────────

const ICAO_TO_IATA: Record<string, string> = {
  CYYZ: "YYZ", CYUL: "YUL", CYVR: "YVR", CYOW: "YOW", CYYC: "YYC",
  CYEG: "YEG", CYWG: "YWG", CYHZ: "YHZ", CYQB: "YQB",
  MMMX: "MEX", MMUN: "CUN", MMMY: "MTY", MMGL: "GDL",
  MMSD: "SJD", MMPR: "PVR", MMMD: "MID",
  MBPV: "MHH", MYNN: "NAS", MKJP: "KIN", TIST: "STT", TJSJ: "SJU",
  TNCM: "SXM", TFFR: "PTP", TAPA: "ANU",
  MROC: "SJO", MRLB: "LIR", MHTG: "TGU", MGGT: "GUA",
  MSLP: "SAL", MNMG: "MGA", MPTO: "PTY",
  TXKF: "BDA", MYGF: "FPO", MYEH: "ELH",
};

function icaoToIata(code: string): string {
  if (ICAO_TO_IATA[code]) return ICAO_TO_IATA[code];
  if (code.length === 4 && code.startsWith("K")) return code.slice(1);
  return code;
}
