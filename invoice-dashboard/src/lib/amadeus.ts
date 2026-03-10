// Amadeus Self-Service API client for commercial flight search
// Docs: https://developers.amadeus.com/self-service/category/flights/api-doc/flight-offers-search

const API_KEY = process.env.AMADEUS_API_KEY!;
const API_SECRET = process.env.AMADEUS_API_SECRET!;

// Production API for real flight data. Set AMADEUS_BASE_URL=https://test.api.amadeus.com for sandbox.
const BASE_URL = process.env.AMADEUS_BASE_URL ?? "https://api.amadeus.com";

// ─── Token management ────────────────────────────────────────────────────────

let cachedToken: { access_token: string; expires_at: number } | null = null;

async function getToken(): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expires_at - 60_000) {
    return cachedToken.access_token;
  }

  const res = await fetch(`${BASE_URL}/v1/security/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: API_KEY,
      client_secret: API_SECRET,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Amadeus auth failed (${res.status}): ${text}`);
  }

  const data = await res.json();
  cachedToken = {
    access_token: data.access_token,
    expires_at: Date.now() + data.expires_in * 1000,
  };
  return cachedToken.access_token;
}

// ─── Types ───────────────────────────────────────────────────────────────────

export type FlightOffer = {
  id: string;
  price: { total: string; currency: string };
  itineraries: {
    duration: string; // ISO 8601 duration e.g. "PT5H30M"
    segments: {
      departure: { iataCode: string; at: string };
      arrival: { iataCode: string; at: string };
      carrierCode: string;
      number: string;
      duration: string;
      numberOfStops: number;
    }[];
  }[];
  numberOfBookableSeats: number;
};

export type FlightSearchResult = {
  origin: string;
  destination: string;
  date: string;
  offers: FlightOffer[];
  count: number;
};

// ─── Flight search ───────────────────────────────────────────────────────────

/**
 * Search one-way commercial flights between two airports on a given date.
 * Returns up to `max` cheapest offers sorted by price.
 */
export async function searchFlights(params: {
  origin: string;      // IATA code e.g. "IAH"
  destination: string; // IATA code e.g. "BUR"
  date: string;        // YYYY-MM-DD
  adults?: number;
  max?: number;
}): Promise<FlightSearchResult> {
  const token = await getToken();
  const { origin, destination, date, adults = 1, max = 5 } = params;

  // Convert ICAO to IATA codes
  const orig = icaoToIata(origin);
  const dest = icaoToIata(destination);

  const qs = new URLSearchParams({
    originLocationCode: orig,
    destinationLocationCode: dest,
    departureDate: date,
    adults: String(adults),
    nonStop: "false",
    max: String(max),
    currencyCode: "USD",
  });

  const res = await fetch(`${BASE_URL}/v2/shopping/flight-offers?${qs}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    const text = await res.text();
    if (res.status === 400) {
      console.warn(`Amadeus 400 for ${orig}->${dest} on ${date}: ${text.slice(0, 200)}`);
      return { origin: orig, destination: dest, date, offers: [], count: 0 };
    }
    console.error(`Amadeus ${res.status} for ${orig}->${dest}: ${text.slice(0, 200)}`);
    throw new Error(`Amadeus search failed (${res.status}): ${text}`);
  }

  const data = await res.json();
  const offers: FlightOffer[] = (data.data ?? []).map((o: Record<string, unknown>) => ({
    id: o.id,
    price: o.price,
    itineraries: o.itineraries,
    numberOfBookableSeats: o.numberOfBookableSeats,
  }));

  return { origin: orig, destination: dest, date, offers, count: offers.length };
}

// ─── ICAO to IATA conversion ─────────────────────────────────────────────────

const ICAO_TO_IATA: Record<string, string> = {
  // Canada
  CYYZ: "YYZ", CYUL: "YUL", CYVR: "YVR", CYOW: "YOW", CYYC: "YYC",
  CYEG: "YEG", CYWG: "YWG", CYHZ: "YHZ", CYQB: "YQB",
  // Mexico
  MMMX: "MEX", MMUN: "CUN", MMMY: "MTY", MMGL: "GDL",
  MMSD: "SJD", MMPR: "PVR", MMMD: "MID",
  // Caribbean
  MBPV: "MHH", MYNN: "NAS", MKJP: "KIN", TIST: "STT", TJSJ: "SJU",
  TNCM: "SXM", TFFR: "PTP", TAPA: "ANU",
  // Central America
  MROC: "SJO", MRLB: "LIR", MHTG: "TGU", MGGT: "GUA",
  MSLP: "SAL", MNMG: "MGA", MPTO: "PTY",
  // Bermuda
  TXKF: "BDA",
  // Bahamas
  MYGF: "FPO", MYEH: "ELH",
};

function icaoToIata(code: string): string {
  // Check lookup table first (international)
  if (ICAO_TO_IATA[code]) return ICAO_TO_IATA[code];
  // US airports: strip K prefix (KIAH → IAH)
  if (code.length === 4 && code.startsWith("K")) return code.slice(1);
  // Already IATA or unknown — return as-is
  return code;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Parse ISO 8601 duration (PT5H30M) to human-readable */
export function formatDuration(iso: string): string {
  const match = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?/);
  if (!match) return iso;
  const h = match[1] ? `${match[1]}h` : "";
  const m = match[2] ? `${match[2]}m` : "";
  return `${h}${m}` || "0m";
}

/** Parse ISO 8601 duration to minutes */
export function durationMinutes(iso: string): number {
  const match = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?/);
  if (!match) return 0;
  return (parseInt(match[1] ?? "0") * 60) + parseInt(match[2] ?? "0");
}
