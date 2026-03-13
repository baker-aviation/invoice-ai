import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthed } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";

export const dynamic = "force-dynamic";

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

function deriveStatus(eventType: SwimEventType, altitudeFt: number | null): string {
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
      return altitudeFt != null && altitudeFt > 0 ? "En Route" : "Arrived";
    case "CANCEL":
      return "Cancelled";
    case "DIVERSION":
      return "Diverted";
    default:
      return "Unknown";
  }
}

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;

  try {
    const supa = createServiceClient();
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    const { data, error } = await supa
      .from("swim_positions")
      .select("tail_number, departure_icao, arrival_icao, event_type, event_time, altitude_ft, etd, eta")
      .gte("event_time", since)
      .order("event_time", { ascending: false });

    if (error) {
      console.error("[swim-status] GET error:", error);
      return NextResponse.json({ error: "Failed to fetch SWIM data" }, { status: 500 });
    }

    // Group by tail+route, keep only the latest event per combination
    const latest = new Map<string, SwimRow>();
    for (const row of (data ?? []) as SwimRow[]) {
      if (!row.tail_number) continue;
      const key = `${row.tail_number}|${row.departure_icao ?? ""}|${row.arrival_icao ?? ""}`;
      if (!latest.has(key)) {
        latest.set(key, row); // already sorted desc, first hit is latest
      }
    }

    const statuses = Array.from(latest.entries()).map(([, row]) => ({
      tail_number: row.tail_number,
      departure_icao: row.departure_icao,
      arrival_icao: row.arrival_icao,
      status: deriveStatus(row.event_type, row.altitude_ft),
      event_time: row.event_time,
      etd: row.etd,
      eta: row.eta,
    }));

    return NextResponse.json({ statuses });
  } catch (err) {
    console.error("[swim-status] GET error:", err);
    return NextResponse.json({ error: "Database error" }, { status: 500 });
  }
}
