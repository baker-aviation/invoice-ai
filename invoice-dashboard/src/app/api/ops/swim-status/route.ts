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
  // Track actual departure/arrival times from SWIM events
  const actuals = new Map<string, { actual_departure: string | null; actual_arrival: string | null }>();

  for (const row of (data ?? []) as SwimRow[]) {
    if (!row.tail_number) continue;
    const key = `${row.tail_number}|${row.departure_icao ?? ""}|${row.arrival_icao ?? ""}`;
    if (!latest.has(key)) {
      latest.set(key, row);
    }
    // Collect actual times from DEPARTURE/ARRIVAL events
    if (row.event_type === "DEPARTURE" || row.event_type === "ARRIVAL") {
      const prev = actuals.get(key) ?? { actual_departure: null, actual_arrival: null };
      if (row.event_type === "DEPARTURE" && !prev.actual_departure) {
        prev.actual_departure = row.event_time;
      } else if (row.event_type === "ARRIVAL" && !prev.actual_arrival) {
        prev.actual_arrival = row.event_time;
      }
      actuals.set(key, prev);
    }
  }

  return Array.from(latest.entries()).map(([key, row]) => ({
    tail_number: row.tail_number,
    departure_icao: row.departure_icao,
    arrival_icao: row.arrival_icao,
    status: deriveSwimStatus(row.event_type, row.altitude_ft),
    event_time: row.event_time,
    etd: row.etd,
    eta: row.eta,
    actual_departure: actuals.get(key)?.actual_departure ?? null,
    actual_arrival: actuals.get(key)?.actual_arrival ?? null,
  }));
}

// ── Route handler ──

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;

  try {
    // Merge ForeFlight (filing status) + SWIM (live tracking) into one response.
    // ForeFlight: Filed / Cancelled. SWIM: En Route / Arrived / Diverted.
    // SWIM tracking data takes priority over ForeFlight's "Scheduled".

    const STATUS_PRIORITY: Record<string, number> = {
      "En Route": 5, "Diverted": 4, "Arrived": 3, "Cancelled": 2, "Filed": 1, "Scheduled": 0,
    };

    const merged = new Map<string, {
      tail_number: string; departure_icao: string | null; arrival_icao: string | null;
      status: string; event_time: string; etd: string | null; eta: string | null;
    }>();

    // Track feed health
    const feeds: { name: string; status: "ok" | "error" | "off"; count: number; updated_at: string; error?: string }[] = [];

    // 1. ForeFlight — filing status + ETD/ETA
    if (process.env.FOREFLIGHT_API_KEY) {
      try {
        const flights = await fetchForeFlight();
        const now = new Date();
        const windowMs = 24 * 60 * 60 * 1000;

        const relevant = flights.filter((f) => {
          const dep = new Date(f.departureTime);
          return Math.abs(dep.getTime() - now.getTime()) <= windowMs;
        });

        for (const f of relevant) {
          const key = `${f.aircraftRegistration}|${toIcao(f.departure)}|${toIcao(f.destination)}`;
          merged.set(key, {
            tail_number: f.aircraftRegistration,
            departure_icao: toIcao(f.departure),
            arrival_icao: toIcao(f.destination),
            status: deriveForeFlightStatus(f),
            event_time: f.timeUpdated,
            etd: f.departureTime,
            eta: f.arrivalTime,
          });
        }
        feeds.push({ name: "ForeFlight", status: "ok", count: relevant.length, updated_at: new Date().toISOString() });
      } catch (err) {
        console.error("[swim-status] ForeFlight error:", err);
        feeds.push({ name: "ForeFlight", status: "error", count: 0, updated_at: new Date().toISOString(), error: String(err) });
      }
    } else {
      feeds.push({ name: "ForeFlight", status: "off", count: 0, updated_at: "" });
    }

    // 2. SWIM — live tracking (overrides ForeFlight if higher priority status)
    try {
      const swimStatuses = await fetchSwimStatuses();
      for (const s of swimStatuses) {
        const key = `${s.tail_number}|${s.departure_icao}|${s.arrival_icao}`;
        const existing = merged.get(key);
        const swimPri = STATUS_PRIORITY[s.status] ?? 0;
        const existPri = existing ? (STATUS_PRIORITY[existing.status] ?? 0) : -1;

        if (swimPri > existPri) {
          merged.set(key, {
            ...s,
            // Keep ForeFlight ETD/ETA if SWIM doesn't have them
            etd: s.etd ?? existing?.etd ?? null,
            eta: s.eta ?? existing?.eta ?? null,
          });
        } else if (!existing) {
          merged.set(key, s);
        }
      }
      feeds.push({ name: "FAA SWIM", status: "ok", count: swimStatuses.length, updated_at: new Date().toISOString() });
    } catch (err) {
      console.error("[swim-status] SWIM error:", err);
      feeds.push({ name: "FAA SWIM", status: "error", count: 0, updated_at: new Date().toISOString(), error: String(err) });
    }

    return NextResponse.json({ statuses: Array.from(merged.values()), feeds });
  } catch (err) {
    console.error("[swim-status] GET error:", err);
    return NextResponse.json({ error: "Failed to fetch flight status" }, { status: 500 });
  }
}
