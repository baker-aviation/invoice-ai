import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthed } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";
import { toIcao } from "@/lib/iataToIcao";

export const dynamic = "force-dynamic";

// ── ForeFlight API types ──

interface ForeFlightFlight {
  departure: string;
  destination: string;
  aircraftRegistration: string;
  flightId: string;
  filingStatus: "Filed" | "None" | "Cancelled";
  departureTime: string;
  arrivalTime: string;
  atcStatus: string;
  released: boolean;
  crew: unknown[];
  route: string;
  tripTime: number;
  timeUpdated: string;
}

// ── In-memory cache (2 min TTL) ──

let foreFlightCache: { data: ForeFlightFlight[]; ts: number } | null = null;
const CACHE_TTL_MS = 2 * 60 * 1000; // 2 minutes

async function fetchForeFlight(): Promise<ForeFlightFlight[]> {
  const now = Date.now();
  if (foreFlightCache && now - foreFlightCache.ts < CACHE_TTL_MS) {
    return foreFlightCache.data;
  }

  const apiKey = process.env.FOREFLIGHT_API_KEY;
  if (!apiKey) throw new Error("FOREFLIGHT_API_KEY not set");

  const res = await fetch(
    "https://public-api.foreflight.com/public/api/Flights/flights",
    {
      headers: { "x-api-key": apiKey },
      cache: "no-store",
    }
  );

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`ForeFlight API ${res.status}: ${text}`);
  }

  const body = await res.json();
  const flights: ForeFlightFlight[] = body.flights ?? body;
  foreFlightCache = { data: flights, ts: now };
  return flights;
}

/**
 * ForeFlight only tells us about filing status — it doesn't do live tracking.
 * Leave En Route / Arrived to FlightAware and SWIM which have radar/ADS-B data.
 */
function deriveForeFlightStatus(f: ForeFlightFlight): string {
  if (f.filingStatus === "Cancelled") return "Cancelled";
  if (f.filingStatus === "Filed") return "Filed";
  return "Scheduled";
}

// ── SWIM fallback types ──

type SwimEventType =
  | "FLIGHT_PLAN"
  | "DEPARTURE"
  | "ARRIVAL"
  | "POSITION"
  | "TRACK"
  | "TAXI_OUT"
  | "TAXI_IN"
  | "DIVERSION"
  | "CANCEL";

interface SwimRow {
  tail_number: string;
  departure_icao: string | null;
  arrival_icao: string | null;
  event_type: SwimEventType;
  event_time: string;
  altitude_ft: number | null;
  etd: string | null;
  eta: string | null;
}

function deriveSwimStatus(eventType: SwimEventType, altitudeFt: number | null): string {
  switch (eventType) {
    case "FLIGHT_PLAN":
      return "Filed";
    case "TAXI_OUT":
    case "DEPARTURE":
      return "En Route";
    case "TAXI_IN":
    case "ARRIVAL":
      return "Arrived";
    case "POSITION":
    case "TRACK":
      return "En Route";
    case "CANCEL":
      return "Cancelled";
    case "DIVERSION":
      return "Diverted";
    default:
      return "Unknown";
  }
}

// ── SWIM fallback fetch ──

async function fetchSwimStatuses() {
  const supa = createServiceClient();
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const { data, error } = await supa
    .from("swim_positions")
    .select("tail_number, departure_icao, arrival_icao, event_type, event_time, altitude_ft, etd, eta")
    .gte("event_time", since)
    .order("event_time", { ascending: false });

  if (error) throw error;

  const latest = new Map<string, SwimRow>();
  for (const row of (data ?? []) as SwimRow[]) {
    if (!row.tail_number) continue;
    const key = `${row.tail_number}|${row.departure_icao ?? ""}|${row.arrival_icao ?? ""}`;
    if (!latest.has(key)) {
      latest.set(key, row);
    }
  }

  return Array.from(latest.entries()).map(([, row]) => ({
    tail_number: row.tail_number,
    departure_icao: row.departure_icao,
    arrival_icao: row.arrival_icao,
    status: deriveSwimStatus(row.event_type, row.altitude_ft),
    event_time: row.event_time,
    etd: row.etd,
    eta: row.eta,
  }));
}

// ── Route handler ──

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;

  try {
    // Try ForeFlight first if API key is configured
    if (process.env.FOREFLIGHT_API_KEY) {
      try {
        const flights = await fetchForeFlight();
        const now = new Date();
        const windowMs = 24 * 60 * 60 * 1000;

        // Filter to flights within ±24h of now
        const relevant = flights.filter((f) => {
          const dep = new Date(f.departureTime);
          return Math.abs(dep.getTime() - now.getTime()) <= windowMs;
        });

        const statuses = relevant.map((f) => ({
          tail_number: f.aircraftRegistration,
          departure_icao: toIcao(f.departure),
          arrival_icao: toIcao(f.destination),
          status: deriveForeFlightStatus(f),
          event_time: f.timeUpdated,
          etd: f.departureTime,
          eta: f.arrivalTime,
        }));

        return NextResponse.json({ statuses });
      } catch (err) {
        console.error("[swim-status] ForeFlight error, falling back to SWIM:", err);
        // Fall through to SWIM
      }
    }

    // SWIM fallback
    const statuses = await fetchSwimStatuses();
    return NextResponse.json({ statuses });
  } catch (err) {
    console.error("[swim-status] GET error:", err);
    return NextResponse.json({ error: "Failed to fetch flight status" }, { status: 500 });
  }
}
