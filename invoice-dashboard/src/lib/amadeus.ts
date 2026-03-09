// Amadeus Self-Service API client for commercial flight search
// Docs: https://developers.amadeus.com/self-service/category/flights/api-doc/flight-offers-search

const API_KEY = process.env.AMADEUS_API_KEY!;
const API_SECRET = process.env.AMADEUS_API_SECRET!;

// Use test environment by default — switch to production when ready
const BASE_URL = "https://test.api.amadeus.com";

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

  // Strip K prefix if ICAO codes are passed (KIAH → IAH)
  const orig = origin.length === 4 && origin.startsWith("K") ? origin.slice(1) : origin;
  const dest = destination.length === 4 && destination.startsWith("K") ? destination.slice(1) : destination;

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
    // Amadeus returns 400 for invalid airport pairs — not an error we should throw on
    if (res.status === 400) {
      return { origin: orig, destination: dest, date, offers: [], count: 0 };
    }
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
