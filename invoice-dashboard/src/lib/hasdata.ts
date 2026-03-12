// HasData Google Flights API client for commercial flight search
// Docs: https://docs.hasdata.com/apis/google-travel/flights
// Scrapes Google Flights and returns structured flight data with real pricing.

import type { FlightOffer, FlightSearchResult } from "./amadeus";

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

  if (!res.ok) {
    const text = await res.text();
    console.warn(`HasData ${res.status} for ${orig}->${dest} on ${date}: ${text.slice(0, 200)}`);
    if (res.status === 400 || res.status === 401 || res.status === 429) {
      return { origin: orig, destination: dest, date, offers: [], count: 0 };
    }
    throw new Error(`HasData search failed (${res.status}): ${text}`);
  }

  const data: HdResponse = await res.json();

  // Combine bestFlights + otherFlights, take up to max
  const all = [...(data.bestFlights ?? []), ...(data.otherFlights ?? [])];
  const limited = all.slice(0, max);

  const offers: FlightOffer[] = limited.map((r, i) => ({
    id: String(i),
    price: { total: String(r.price), currency: "USD" },
    itineraries: [{
      duration: minutesToIsoDuration(r.totalDuration),
      segments: r.flights.map((f) => ({
        departure: {
          iataCode: f.departureAirport.id,
          at: parseHdTime(f.departureAirport.time),
        },
        arrival: {
          iataCode: f.arrivalAirport.id,
          at: parseHdTime(f.arrivalAirport.time),
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

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Convert "2026-03-15 5:50" to ISO string "2026-03-15T05:50:00" */
function parseHdTime(timeStr: string): string {
  const [datePart, timePart] = timeStr.split(" ");
  if (!timePart) return `${datePart}T00:00:00`;
  const [h, m] = timePart.split(":");
  return `${datePart}T${h.padStart(2, "0")}:${m.padStart(2, "0")}:00`;
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
