import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, isAuthed } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";
import { buildSwapPlan, getRequiredFlightSearches, getPoolFlightSearches, assignOncomingCrew, type CrewMember, type FlightLeg, type AirportAlias, type SwapAssignment, type OncomingPool } from "@/lib/swapOptimizer";
import { DEFAULT_AIRPORT_ALIASES } from "@/lib/airportAliases";
import { searchFlights } from "@/lib/hasdata";
import type { FlightOffer } from "@/lib/amadeus";

export const dynamic = "force-dynamic";
export const maxDuration = 300; // 5 min — flight searches + feasibility matrix take time

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

  try {
  const body = await req.json();
  const swapDate = body.swap_date as string;
  const searchCommercial = body.search_flights === true;
  // Accept swap_assignments directly from client (parsed from Excel upload)
  const clientSwapAssignments = body.swap_assignments as Record<string, SwapAssignment> | undefined;
  // Accept oncoming pool for crew-to-tail assignment
  const clientOncomingPool = body.oncoming_pool as OncomingPool | undefined;

  if (!swapDate || !/^\d{4}-\d{2}-\d{2}$/.test(swapDate)) {
    return NextResponse.json({ error: "swap_date required (YYYY-MM-DD)" }, { status: 400 });
  }

  const supa = createServiceClient();

  // Fetch flights around the swap date (±3 days for context)
  const wedDate = new Date(swapDate);
  const start = new Date(wedDate.getTime() - 3 * 24 * 60 * 60 * 1000).toISOString();
  const end = new Date(wedDate.getTime() + 3 * 24 * 60 * 60 * 1000).toISOString();

  const [flightsRes, crewRes, aliasRes, rotationsRes] = await Promise.all([
    supa
      .from("flights")
      .select("id, tail_number, departure_icao, arrival_icao, scheduled_departure, scheduled_arrival, flight_type, pic, sic")
      .gte("scheduled_departure", start)
      .lte("scheduled_departure", end)
      .order("scheduled_departure"),
    supa.from("crew_members").select("*").eq("active", true),
    supa.from("airport_aliases").select("fbo_icao, commercial_icao, preferred"),
    // Fallback: get crew rotations to build swap assignments if not provided by client
    !clientSwapAssignments
      ? supa.from("crew_rotations")
          .select("crew_member_id, tail_number, rotation_start, rotation_end, crew_members(name, role)")
          .order("rotation_start", { ascending: false })
      : Promise.resolve({ data: null, error: null }),
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

  // Merge DB aliases with defaults (DB takes precedence)
  const dbAliases: AirportAlias[] = (aliasRes.data ?? []).map((a) => ({
    fbo_icao: a.fbo_icao as string,
    commercial_icao: a.commercial_icao as string,
    preferred: (a.preferred as boolean) ?? false,
  }));
  const dbFboKeys = new Set(dbAliases.map((a) => `${a.fbo_icao}|${a.commercial_icao}`));
  const aliases: AirportAlias[] = [
    ...dbAliases,
    ...DEFAULT_AIRPORT_ALIASES.filter((a) => !dbFboKeys.has(`${a.fbo_icao}|${a.commercial_icao}`)),
  ];

  // Use client-provided swap assignments (from Excel upload), or fall back to crew_rotations
  let swapAssignments: Record<string, SwapAssignment> = {};

  if (clientSwapAssignments && Object.keys(clientSwapAssignments).length > 0) {
    swapAssignments = clientSwapAssignments;
  } else if (rotationsRes.data) {
    // Fallback: reconstruct from crew_rotations (less reliable)
    for (const rot of rotationsRes.data) {
      const tail = rot.tail_number as string;
      const memberArr = rot.crew_members as unknown as { name: string; role: string }[] | { name: string; role: string } | null;
      const member = Array.isArray(memberArr) ? memberArr[0] : memberArr;
      if (!member || !tail) continue;

      if (!swapAssignments[tail]) {
        swapAssignments[tail] = { oncoming_pic: null, oncoming_sic: null, offgoing_pic: null, offgoing_sic: null };
      }
      const sa = swapAssignments[tail];
      const rotEnd = rot.rotation_end as string | null;
      const isPic = member.role === "PIC";

      if (rotEnd) {
        if (isPic) sa.offgoing_pic = sa.offgoing_pic ?? member.name;
        else sa.offgoing_sic = sa.offgoing_sic ?? member.name;
      } else {
        if (isPic) sa.oncoming_pic = sa.oncoming_pic ?? member.name;
        else sa.oncoming_sic = sa.oncoming_sic ?? member.name;
      }
    }
  }

  const hasPool = clientOncomingPool && (clientOncomingPool.pic?.length > 0 || clientOncomingPool.sic?.length > 0);

  // ── STEP 1: Search commercial flights ──────────────────────────────────────
  // Search BEFORE assignment so we have real costs for crew-to-tail matching.
  // For oncoming pool: search ALL pool crew home airports → ALL swap locations.
  // For offgoing: search swap locations → home airports.
  let commercialFlights: Map<string, FlightOffer[]> | undefined;

  if (searchCommercial) {
    commercialFlights = new Map();
    const searchPairs = new Set<string>();

    // Pool searches: every pool member's home → every swap location
    if (hasPool) {
      const poolSearches = getPoolFlightSearches({
        oncomingPool: clientOncomingPool!,
        aliases,
        swapAssignments,
        flights,
        swapDate,
      });
      for (const s of poolSearches) {
        searchPairs.add(`${s.origin}-${s.destination}`);
      }
    }

    // Offgoing searches: swap locations → offgoing crew home airports
    const offgoingSearches = getRequiredFlightSearches({
      crewRoster,
      aliases,
      swapAssignments,
      flights,
      swapDate,
    });
    for (const s of offgoingSearches) {
      searchPairs.add(`${s.origin}-${s.destination}`);
    }

    const pairsArray = Array.from(searchPairs);
    let searchSuccessCount = 0;
    let searchFailCount = 0;

    // Determine search dates: swap-day (Wednesday) + Tue/Thu if volunteers exist
    const searchDates = [swapDate];
    if (clientOncomingPool) {
      const allPoolMembers = [...(clientOncomingPool.pic ?? []), ...(clientOncomingPool.sic ?? [])];
      const hasEarly = allPoolMembers.some((m) => m.early_volunteer);
      const hasLate = allPoolMembers.some((m) => m.late_volunteer);
      if (hasEarly) {
        const dayBefore = new Date(swapDate);
        dayBefore.setDate(dayBefore.getDate() - 1);
        searchDates.unshift(dayBefore.toISOString().slice(0, 10));
      }
      if (hasLate) {
        const dayAfter = new Date(swapDate);
        dayAfter.setDate(dayAfter.getDate() + 1);
        searchDates.push(dayAfter.toISOString().slice(0, 10));
      }
    }

    const allSearches: { pair: string; date: string }[] = [];
    for (const pair of pairsArray) {
      for (const date of searchDates) {
        allSearches.push({ pair, date });
      }
    }

    console.log(`[Swap Optimizer] Searching ${pairsArray.length} route pairs × ${searchDates.length} date(s) (${searchDates.join(", ")}) = ${allSearches.length} searches via HasData`);
    const flightSearchStart = Date.now();

    // Search in batches of 30 (HasData Pro: 30 concurrent requests)
    for (let i = 0; i < allSearches.length; i += 30) {
      const batch = allSearches.slice(i, i + 30);
      const results = await Promise.all(
        batch.map(async ({ pair, date }) => {
          const [orig, dest] = pair.split("-");
          try {
            const result = await searchFlights({ origin: orig, destination: dest, date, max: 5 });
            return { key: `${orig}-${dest}-${date}`, offers: result.offers };
          } catch (e) {
            console.warn(`[Swap Optimizer] Search failed ${orig}->${dest} ${date}:`, e instanceof Error ? e.message : e);
            return { key: `${orig}-${dest}-${date}`, offers: [] };
          }
        }),
      );
      for (const r of results) {
        if (r.offers.length > 0) {
          commercialFlights.set(r.key, r.offers);
          searchSuccessCount++;
        } else {
          searchFailCount++;
        }
      }
    }

    console.log(`[Swap Optimizer] Flight search results: ${searchSuccessCount} routes with flights, ${searchFailCount} empty, ${commercialFlights.size} total cached (${((Date.now() - flightSearchStart) / 1000).toFixed(1)}s)`);
  }

  // ── STEP 2: Assign oncoming crew using ACTUAL transport costs ──────────────
  let assignmentResult: ReturnType<typeof assignOncomingCrew> | null = null;

  if (hasPool) {
    const assignStart = Date.now();
    assignmentResult = assignOncomingCrew({
      swapAssignments,
      oncomingPool: clientOncomingPool!,
      crewRoster,
      flights,
      swapDate,
      aliases,
      commercialFlights,
    });
    swapAssignments = assignmentResult.assignments;
    console.log(`[Swap Optimizer] Assignment took ${((Date.now() - assignStart) / 1000).toFixed(1)}s`);
  }

  // ── STEP 3: Run transport optimizer for all assigned crew ──────────────────
  const transportStart = Date.now();
  const result = buildSwapPlan({
    flights,
    crewRoster,
    aliases,
    swapDate,
    commercialFlights,
    swapAssignments: Object.keys(swapAssignments).length > 0 ? swapAssignments : undefined,
    oncomingPool: clientOncomingPool,
  });

  console.log(`[Swap Optimizer] Transport plan took ${((Date.now() - transportStart) / 1000).toFixed(1)}s`);

  return NextResponse.json({
    ok: true,
    ...result,
    commercial_flights_searched: searchCommercial ? (commercialFlights?.size ?? 0) : 0,
    crew_assignment: assignmentResult ? {
      standby: assignmentResult.standby,
      details: assignmentResult.details,
    } : undefined,
  });

  } catch (e) {
    console.error("[Swap Optimizer] Unhandled error:", e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Optimization failed" },
      { status: 500 },
    );
  }
}
