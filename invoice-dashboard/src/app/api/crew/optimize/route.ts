import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, isAuthed } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";
import { buildSwapPlan, type CrewMember, type FlightLeg, type AirportAlias } from "@/lib/swapOptimizer";
import { searchFlights, type FlightOffer } from "@/lib/amadeus";

export const dynamic = "force-dynamic";

/**
 * POST /api/crew/optimize
 * Body: { swap_date: "2026-03-11", search_flights?: boolean }
 *
 * Runs the swap optimizer for the given Wednesday.
 * If search_flights=true, also queries Amadeus for commercial flights (uses API quota).
 */
export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (!isAuthed(auth)) return auth.error;

  const body = await req.json();
  const swapDate = body.swap_date as string;
  const searchCommercial = body.search_flights === true;

  if (!swapDate || !/^\d{4}-\d{2}-\d{2}$/.test(swapDate)) {
    return NextResponse.json({ error: "swap_date required (YYYY-MM-DD)" }, { status: 400 });
  }

  const supa = createServiceClient();

  // Fetch flights around the swap date (±3 days for context)
  const wedDate = new Date(swapDate);
  const start = new Date(wedDate.getTime() - 3 * 24 * 60 * 60 * 1000).toISOString();
  const end = new Date(wedDate.getTime() + 3 * 24 * 60 * 60 * 1000).toISOString();

  const [flightsRes, crewRes, aliasRes] = await Promise.all([
    supa
      .from("flights")
      .select("id, tail_number, departure_icao, arrival_icao, scheduled_departure, scheduled_arrival, flight_type, pic, sic")
      .gte("scheduled_departure", start)
      .lte("scheduled_departure", end)
      .order("scheduled_departure"),
    supa.from("crew_members").select("*").eq("active", true),
    supa.from("airport_aliases").select("fbo_icao, commercial_icao, preferred"),
  ]);

  if (flightsRes.error) {
    return NextResponse.json({ error: flightsRes.error.message }, { status: 500 });
  }
  if (crewRes.error) {
    return NextResponse.json({ error: crewRes.error.message }, { status: 500 });
  }

  const flights: FlightLeg[] = (flightsRes.data ?? []).map((f) => ({
    id: f.id as string,
    tail_number: f.tail_number as string,
    departure_icao: f.departure_icao as string,
    arrival_icao: f.arrival_icao as string,
    scheduled_departure: f.scheduled_departure as string,
    scheduled_arrival: f.scheduled_arrival as string | null,
    flight_type: f.flight_type as string | null,
    pic: f.pic as string | null,
    sic: f.sic as string | null,
  }));

  const crewRoster: CrewMember[] = (crewRes.data ?? []).map((c) => ({
    id: c.id as string,
    name: c.name as string,
    role: c.role as "PIC" | "SIC",
    home_airports: (c.home_airports as string[]) ?? [],
    aircraft_types: (c.aircraft_types as string[]) ?? [],
    is_checkairman: (c.is_checkairman as boolean) ?? false,
    is_skillbridge: (c.is_skillbridge as boolean) ?? false,
    priority: (c.priority as number) ?? 0,
  }));

  const aliases: AirportAlias[] = (aliasRes.data ?? []).map((a) => ({
    fbo_icao: a.fbo_icao as string,
    commercial_icao: a.commercial_icao as string,
    preferred: (a.preferred as boolean) ?? false,
  }));

  // Optionally search for commercial flights
  let commercialFlights: Map<string, FlightOffer[]> | undefined;

  if (searchCommercial) {
    commercialFlights = new Map();

    // Determine unique origin-destination pairs needed
    const searchPairs = new Set<string>();

    // For each crew member's home airports → each swap candidate airport
    const tailAirports = new Set<string>();
    for (const f of flights) {
      if (f.scheduled_departure.startsWith(swapDate)) {
        if (f.departure_icao) tailAirports.add(f.departure_icao);
        if (f.arrival_icao) tailAirports.add(f.arrival_icao);
      }
    }

    for (const crew of crewRoster) {
      for (const home of crew.home_airports) {
        for (const apt of tailAirports) {
          // Strip K prefix for IATA
          const homeIata = home.length === 4 && home.startsWith("K") ? home.slice(1) : home;
          const aptIata = apt.length === 4 && apt.startsWith("K") ? apt.slice(1) : apt;
          if (homeIata !== aptIata) {
            searchPairs.add(`${homeIata}-${aptIata}`);
            searchPairs.add(`${aptIata}-${homeIata}`); // return trip
          }
        }
      }
    }

    // Limit searches to avoid burning API quota
    const pairsArray = Array.from(searchPairs).slice(0, 20);

    // Search in parallel (batches of 5)
    for (let i = 0; i < pairsArray.length; i += 5) {
      const batch = pairsArray.slice(i, i + 5);
      const results = await Promise.all(
        batch.map(async (pair) => {
          const [orig, dest] = pair.split("-");
          try {
            const result = await searchFlights({ origin: orig, destination: dest, date: swapDate, max: 5 });
            return { key: `${orig}-${dest}-${swapDate}`, offers: result.offers };
          } catch {
            return { key: `${orig}-${dest}-${swapDate}`, offers: [] };
          }
        }),
      );
      for (const r of results) {
        if (r.offers.length > 0) {
          commercialFlights.set(r.key, r.offers);
        }
      }
    }
  }

  // Run optimizer
  const result = buildSwapPlan({
    flights,
    crewRoster,
    aliases,
    swapDate,
    commercialFlights,
  });

  return NextResponse.json({
    ok: true,
    ...result,
    commercial_flights_searched: searchCommercial ? (commercialFlights?.size ?? 0) : 0,
  });
}
