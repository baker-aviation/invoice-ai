/**
 * Pre-computed route pool for the crew swap optimizer.
 *
 * Instead of searching for commercial flights at optimizer runtime (which causes
 * timeouts), we pre-compute every pilot's routes to every relevant airport
 * and store them in the `pilot_routes` table. The optimizer then just looks up
 * routes — instant results, no timeouts.
 */

import { createServiceClient } from "@/lib/supabase/service";
import { estimateDriveTime, findNearbyCommercialAirports } from "./driveTime";
import { getCrewDifficulty } from "./airportTiers";
import { fetchAllCrewSchedules, type ScheduledFlight } from "./flightaware";
import { searchFlights } from "./hasdata";
import type { FlightOffer } from "./amadeus";
import type { AirportAlias } from "./swapOptimizer";
import { DEFAULT_AIRPORT_ALIASES } from "./airportAliases";

// ─── Types ──────────────────────────────────────────────────────────────────

export type PilotRoute = {
  id: number;
  crew_member_id: string;
  swap_date: string;
  destination_icao: string;
  route_type: string;
  origin_iata: string;
  via_commercial: string | null;
  flight_number: string | null;
  flight_data: FlightOffer | null;
  depart_at: string | null;
  arrive_at: string | null;
  fbo_arrive_at: string | null;
  duty_on_at: string | null;
  duration_minutes: number | null;
  cost_estimate: number;
  score: number;
  is_direct: boolean;
  connection_count: number;
  has_backup: boolean;
  backup_flight: string | null;
  searched_at: string;
};

export type RouteComputationStatus = {
  swap_date: string;
  total_routes: number;
  crew_count: number;
  destination_count: number;
  last_computed: string | null;
  is_stale: boolean;
};

// ─── ICAO/IATA helpers (duplicated from swapOptimizer to avoid circular deps) ─

const ICAO_IATA: Record<string, string> = {
  CYYZ: "YYZ", CYUL: "YUL", CYVR: "YVR", CYOW: "YOW", CYYC: "YYC",
  CYEG: "YEG", CYWG: "YWG", CYHZ: "YHZ", CYQB: "YQB",
  MMMX: "MEX", MMUN: "CUN", MMMY: "MTY", MMGL: "GDL", MMSD: "SJD",
  MMPR: "PVR", MMMD: "MID",
  MBPV: "MHH", MYNN: "NAS", MKJP: "KIN", TIST: "STT", TJSJ: "SJU",
  TNCM: "SXM", TFFR: "PTP", TAPA: "ANU",
  TXKF: "BDA", MYGF: "FPO", MYEH: "ELH",
  MROC: "SJO", MRLB: "LIR", MHTG: "TGU", MGGT: "GUA",
  MSLP: "SAL", MNMG: "MGA", MPTO: "PTY",
};

function toIata(icao: string): string {
  if (ICAO_IATA[icao]) return ICAO_IATA[icao];
  return icao.length === 4 && icao.startsWith("K") ? icao.slice(1) : icao;
}

function toIcao(code: string): string {
  return code.length === 3 ? `K${code}` : code;
}

/** Get all commercial airports for an FBO */
function findAllCommercialAirports(fboIcao: string, aliases: AirportAlias[]): string[] {
  const upper = fboIcao.toUpperCase();
  const result = new Set<string>();
  const matching = aliases.filter((a) => a.fbo_icao.toUpperCase() === upper);
  const sorted = [...matching].sort((a, b) => (b.preferred ? 1 : 0) - (a.preferred ? 1 : 0));
  for (const a of sorted) result.add(a.commercial_icao);
  const nearby = findNearbyCommercialAirports(upper, 30);
  for (const n of nearby) {
    if (!result.has(n.icao)) result.add(n.icao);
  }
  if (result.size === 0) result.add(fboIcao);
  return Array.from(result);
}

// ─── Route computation for a single pilot ───────────────────────────────────

/** Real pricing from HasData, keyed by "ORIGIN-DEST" e.g. "DFW-EWR" */
type PriceMap = Map<string, Map<string, number>>; // "ORIG-DEST" → flightNumber → price

/**
 * Compute all routes for a single crew member to a set of destination airports.
 * Uses pre-fetched FlightAware schedule data + HasData real pricing.
 * Stores results in `pilot_routes` table.
 */
export function computePilotRoutes(params: {
  crewMemberId: string;
  homeAirports: string[];
  swapDate: string;
  destinations: string[];
  aliases: AirportAlias[];
  scheduledFlights: Map<string, ScheduledFlight[]>;
  priceMap: PriceMap;
}): Array<Record<string, unknown>> {
  const { crewMemberId, homeAirports, swapDate, destinations, aliases, scheduledFlights, priceMap } = params;
  const routeRows: Array<Record<string, unknown>> = [];

  for (const destIcao of destinations) {
    const commAirports = findAllCommercialAirports(destIcao, aliases);
    const commIataSet = new Set(commAirports.map((c) => toIata(c)));

    for (const homeApt of homeAirports) {
      const homeIata = toIata(homeApt);
      const homeIcao = toIcao(homeApt);

      // ── Ground transport (home → FBO) ────────────────────────────────
      const drive = estimateDriveTime(homeIcao, destIcao);
      if (drive && drive.estimated_drive_minutes <= 300) {
        const driveMin = drive.estimated_drive_minutes;
        let routeType: string;
        let cost: number;

        if (driveMin <= 60) {
          routeType = "uber";
          cost = Math.max(25, Math.round(drive.estimated_drive_miles * 2.0));
        } else {
          routeType = "rental_car";
          cost = 80 + Math.round(drive.estimated_drive_miles * 0.50);
        }

        routeRows.push({
          crew_member_id: crewMemberId,
          swap_date: swapDate,
          destination_icao: destIcao,
          route_type: routeType,
          origin_iata: homeIata,
          via_commercial: null,
          flight_number: null,
          flight_data: null,
          depart_at: null,
          arrive_at: null,
          fbo_arrive_at: null,
          duty_on_at: null,
          duration_minutes: driveMin,
          cost_estimate: cost,
          score: routeType === "uber" ? 70 : 50,
          is_direct: true,
          connection_count: 0,
          has_backup: false,
          backup_flight: null,
        });
      }

      // ── Commercial flights from pre-fetched FlightAware schedules ────
      const homeFlights = scheduledFlights.get(homeIcao) ?? scheduledFlights.get(homeIata) ?? [];

      const matchingFlights = homeFlights.filter((f) => {
        if (f.destination_iata === homeIata) return false;
        return commIataSet.has(f.destination_iata) || commIataSet.has(toIata(f.destination_icao));
      });

      for (const f of matchingFlights) {
        const commIata = f.destination_iata;

        // Drive from commercial airport to FBO
        const driveToFbo = estimateDriveTime(toIcao(commIata), destIcao);
        const driveToFboMin = driveToFbo?.estimated_drive_minutes ?? 0;
        let groundCost = 0;
        if (driveToFboMin > 0 && driveToFboMin <= 60) {
          groundCost = Math.max(25, Math.round((driveToFbo?.estimated_drive_miles ?? 0) * 2.0));
        } else if (driveToFboMin > 0) {
          groundCost = 80 + Math.round((driveToFbo?.estimated_drive_miles ?? 0) * 0.50);
        }

        // Look up real HasData price for this route pair, then by flight number
        const pairKey = `${homeIata}-${commIata}`;
        const pairPrices = priceMap.get(pairKey);
        let flightPrice: number;
        let priceSource: string;

        if (pairPrices) {
          // Try exact flight number match first, then cheapest on the route
          const exactPrice = pairPrices.get(f.flight_number);
          if (exactPrice !== undefined) {
            flightPrice = exactPrice;
            priceSource = "hasdata_exact";
          } else {
            // Use cheapest price on this O→D pair as proxy
            flightPrice = Math.min(...pairPrices.values());
            priceSource = "hasdata_route";
          }
        } else {
          // Fallback estimate when HasData didn't cover this pair
          const budgetCarriers = new Set(["F9", "NK", "G4", "WN", "B6"]);
          const priceMult = budgetCarriers.has(f.airline_iata) ? 0.7 : 1.0;
          flightPrice = Math.min(Math.round((50 + f.duration_minutes * 1.5) * priceMult), 500);
          priceSource = "estimated";
        }

        const totalCost = flightPrice + groundCost;

        // Build FlightOffer-compatible object for storage
        const offer: FlightOffer = {
          id: f.flight_number,
          price: { total: String(flightPrice), currency: "USD" },
          itineraries: [{
            duration: `PT${Math.floor(f.duration_minutes / 60)}H${f.duration_minutes % 60}M`,
            segments: [{
              departure: { iataCode: f.origin_iata, at: f.scheduled_departure },
              arrival: { iataCode: commIata, at: f.scheduled_arrival },
              carrierCode: f.airline_iata,
              number: f.flight_number.replace(/^[A-Z]{1,3}/, ""),
              duration: `PT${Math.floor(f.duration_minutes / 60)}H${f.duration_minutes % 60}M`,
              numberOfStops: 0,
            }],
          }],
          numberOfBookableSeats: 9,
        };

        const fboArrMs = new Date(f.scheduled_arrival).getTime() + (30 + driveToFboMin) * 60_000;
        const fboArrAt = new Date(fboArrMs).toISOString();
        const dutyOnMs = new Date(f.scheduled_departure).getTime() - 60 * 60_000;
        const dutyOnAt = new Date(dutyOnMs).toISOString();

        // Score: real-priced routes score higher than estimated
        let score = 50;
        if (totalCost <= 100) score += 20;
        else if (totalCost <= 300) score += 10;
        score += 12; // direct flight bonus
        if (priceSource.startsWith("hasdata")) score += 5; // real price confidence bonus

        routeRows.push({
          crew_member_id: crewMemberId,
          swap_date: swapDate,
          destination_icao: destIcao,
          route_type: "commercial",
          origin_iata: homeIata,
          via_commercial: commIata,
          flight_number: f.flight_number,
          flight_data: offer,
          depart_at: f.scheduled_departure,
          arrive_at: f.scheduled_arrival,
          fbo_arrive_at: fboArrAt,
          duty_on_at: dutyOnAt,
          duration_minutes: f.duration_minutes,
          cost_estimate: totalCost,
          score,
          is_direct: true,
          connection_count: 0,
          has_backup: false,
          backup_flight: null,
        });
      }
    }
  }

  return routeRows;
}

// ─── Orchestrator: compute routes for ALL crew ──────────────────────────────

/**
 * Compute routes for ALL active crew members to ALL swap-day destinations.
 *
 * Three-phase pipeline:
 *   1. FlightAware bulk fetch — discover all flights from ~60 unique home airports
 *   2. HasData pricing — get real Google Flights prices for unique O→D pairs
 *   3. Local matching — match flights to crew×destination, store with real prices
 *
 * ~60 FlightAware calls + ~50-150 HasData calls instead of 2000+ blind searches.
 */
export async function computeAllRoutes(swapDate: string): Promise<{
  crewProcessed: number;
  totalRoutes: number;
  flightAwareCalls: number;
  hasDataCalls: number;
  totalScheduledFlights: number;
  pricedPairs: number;
  errors: string[];
}> {
  const supa = createServiceClient();
  const errors: string[] = [];

  // 1. Get all active crew members
  const { data: crewData, error: crewErr } = await supa
    .from("crew_members")
    .select("id, name, home_airports, role, aircraft_types")
    .eq("active", true);

  if (crewErr || !crewData) {
    return { crewProcessed: 0, totalRoutes: 0, flightAwareCalls: 0, hasDataCalls: 0, totalScheduledFlights: 0, pricedPairs: 0, errors: [`Failed to load crew: ${crewErr?.message}`] };
  }

  // 2. Get all flights on swap day to determine destination airports
  const { data: flightData, error: flightErr } = await supa
    .from("flights")
    .select("tail_number, departure_icao, arrival_icao, scheduled_departure, scheduled_arrival")
    .gte("scheduled_departure", `${swapDate}T00:00:00Z`)
    .lte("scheduled_departure", `${swapDate}T23:59:59Z`);

  if (flightErr) {
    errors.push(`Failed to load flights: ${flightErr.message}`);
  }

  // Also get flights from days before to find overnight positions
  const dayBefore = new Date(swapDate);
  dayBefore.setDate(dayBefore.getDate() - 1);
  const { data: priorFlights } = await supa
    .from("flights")
    .select("tail_number, arrival_icao, scheduled_departure")
    .gte("scheduled_departure", `${dayBefore.toISOString().slice(0, 10)}T00:00:00Z`)
    .lt("scheduled_departure", `${swapDate}T00:00:00Z`)
    .order("scheduled_departure", { ascending: false });

  // 3. Determine destination airports (where tails will be on swap day)
  const destinationIcaos = new Set<string>();
  const wedFlights = flightData ?? [];

  for (const f of wedFlights) {
    if (f.departure_icao) destinationIcaos.add(f.departure_icao);
    if (f.arrival_icao) destinationIcaos.add(f.arrival_icao);
  }

  const tailsWithWedFlights = new Set(wedFlights.map((f) => f.tail_number));
  if (priorFlights) {
    const seenTails = new Set<string>();
    for (const f of priorFlights) {
      if (!seenTails.has(f.tail_number) && !tailsWithWedFlights.has(f.tail_number)) {
        if (f.arrival_icao) destinationIcaos.add(f.arrival_icao);
        seenTails.add(f.tail_number);
      }
    }
  }

  if (destinationIcaos.size === 0) {
    return { crewProcessed: 0, totalRoutes: 0, flightAwareCalls: 0, hasDataCalls: 0, totalScheduledFlights: 0, pricedPairs: 0, errors: ["No destination airports found for swap date"] };
  }

  const destinations = Array.from(destinationIcaos);

  // 4. Load aliases
  const { data: aliasData } = await supa
    .from("airport_aliases")
    .select("fbo_icao, commercial_icao, preferred");

  const dbAliases: AirportAlias[] = (aliasData ?? []).map((a) => ({
    fbo_icao: a.fbo_icao as string,
    commercial_icao: a.commercial_icao as string,
    preferred: (a.preferred as boolean) ?? false,
  }));
  const dbFboKeys = new Set(dbAliases.map((a) => `${a.fbo_icao}|${a.commercial_icao}`));
  const aliases: AirportAlias[] = [
    ...dbAliases,
    ...DEFAULT_AIRPORT_ALIASES.filter((a) => !dbFboKeys.has(`${a.fbo_icao}|${a.commercial_icao}`)),
  ];

  // 5. Collect all unique home airports across all crew
  const allHomeAirports = new Set<string>();
  for (const c of crewData) {
    const homes = (c.home_airports as string[]) ?? [];
    for (const h of homes) allHomeAirports.add(h.toUpperCase());
  }

  console.log(`[PilotRoutes] ${crewData.length} crew, ${destinations.length} destinations, ${allHomeAirports.size} unique home airports`);

  // ═══════════════════════════════════════════════════════════════════════════
  // PHASE 1: FlightAware — discover all flights from home airports
  // ═══════════════════════════════════════════════════════════════════════════
  let scheduledFlights = new Map<string, ScheduledFlight[]>();
  let flightAwareCalls = 0;
  let totalScheduledFlights = 0;

  try {
    const faResult = await fetchAllCrewSchedules([...allHomeAirports], swapDate);
    scheduledFlights = faResult.flightsByOrigin;
    flightAwareCalls = faResult.apiCalls;
    totalScheduledFlights = faResult.totalFlights;
    for (const e of faResult.errors) errors.push(e);
    console.log(`[PilotRoutes] Phase 1 done: ${totalScheduledFlights} flights from ${scheduledFlights.size} airports in ${flightAwareCalls} FA calls`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown";
    errors.push(`FlightAware bulk fetch failed: ${msg}`);
    console.error(`[PilotRoutes] FlightAware bulk fetch failed:`, msg);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PHASE 2: Determine unique O→D pairs that have FlightAware matches,
  //          then batch HasData to get real Google Flights prices
  // ═══════════════════════════════════════════════════════════════════════════
  // Build set of commercial airports near each FBO destination
  const destCommAirports = new Map<string, Set<string>>(); // destIcao → Set<commIata>
  for (const destIcao of destinations) {
    const comms = findAllCommercialAirports(destIcao, aliases);
    destCommAirports.set(destIcao, new Set(comms.map((c) => toIata(c))));
  }

  // Scan FlightAware results to find which O→D pairs actually have flights
  const viableOdPairs = new Set<string>(); // "ORIG_IATA-DEST_IATA"
  for (const [_airport, flights] of scheduledFlights) {
    for (const f of flights) {
      const originIata = f.origin_iata;
      const destIata = f.destination_iata;
      // Check if this flight's destination is near any of our FBO destinations
      for (const [, commSet] of destCommAirports) {
        if (commSet.has(destIata) || commSet.has(toIata(f.destination_icao))) {
          viableOdPairs.add(`${originIata}-${destIata}`);
          break;
        }
      }
    }
  }

  console.log(`[PilotRoutes] Phase 2: ${viableOdPairs.size} unique O→D pairs to price via HasData`);

  // Fetch real prices from HasData for each unique O→D pair
  const priceMap: PriceMap = new Map();
  let hasDataCalls = 0;
  const odPairList = [...viableOdPairs];

  // Process HasData in batches of 3 (respecting rate limits)
  for (let i = 0; i < odPairList.length; i += 3) {
    const batch = odPairList.slice(i, i + 3);
    const results = await Promise.all(
      batch.map(async (pair) => {
        const [origin, dest] = pair.split("-");
        try {
          hasDataCalls++;
          const result = await searchFlights({ origin, destination: dest, date: swapDate, max: 15 });
          const flightPrices = new Map<string, number>();

          for (const offer of result.offers) {
            const segs = offer.itineraries[0]?.segments ?? [];
            if (segs.length === 0) continue;
            // Build flight number key: "AA1234" or "AA1234/AA5678" for connections
            const flightNum = segs.map((s) => `${s.carrierCode}${s.number}`).join("/");
            const price = parseFloat(offer.price.total);
            if (!isNaN(price)) {
              // Keep cheapest price per flight number
              const existing = flightPrices.get(flightNum);
              if (existing === undefined || price < existing) {
                flightPrices.set(flightNum, price);
              }
            }
          }

          // Also store connection flights from HasData that FA might not have
          // (HasData returns connections, FlightAware only returns nonstops)
          for (const offer of result.offers) {
            const segs = offer.itineraries[0]?.segments ?? [];
            if (segs.length > 1 && segs.length <= 2) {
              const flightNum = segs.map((s) => `${s.carrierCode}${s.number}`).join("/");
              const price = parseFloat(offer.price.total);
              if (!isNaN(price)) {
                flightPrices.set(flightNum, price);
              }
            }
          }

          return { pair, flightPrices, error: null };
        } catch (e) {
          return { pair, flightPrices: new Map<string, number>(), error: `HasData ${pair}: ${e instanceof Error ? e.message : "unknown"}` };
        }
      }),
    );

    for (const r of results) {
      if (r.error) errors.push(r.error);
      if (r.flightPrices.size > 0) {
        priceMap.set(r.pair, r.flightPrices);
      }
    }

    // HasData rate limit pause
    if (i + 3 < odPairList.length) {
      await new Promise((r) => setTimeout(r, 500));
    }

    // Progress log every 30 pairs
    if ((i + 3) % 30 === 0 && i + 3 < odPairList.length) {
      console.log(`[PilotRoutes] HasData pricing: ${i + 3}/${odPairList.length} pairs done`);
    }
  }

  console.log(`[PilotRoutes] Phase 2 done: ${priceMap.size} pairs priced from ${hasDataCalls} HasData calls`);

  // ═══════════════════════════════════════════════════════════════════════════
  // PHASE 3: Match flights to crew × destinations locally, store routes
  // ═══════════════════════════════════════════════════════════════════════════
  const crewWithDifficulty = crewData.map((c) => ({
    ...c,
    difficulty: getCrewDifficulty((c.home_airports as string[]) ?? []),
  }));
  crewWithDifficulty.sort((a, b) => b.difficulty - a.difficulty);

  let totalRoutes = 0;
  let crewProcessed = 0;

  // Process in batches of 10 (all local, no API calls)
  for (let i = 0; i < crewWithDifficulty.length; i += 10) {
    const batch = crewWithDifficulty.slice(i, i + 10);
    const allRows: Array<Record<string, unknown>> = [];

    for (const crew of batch) {
      const homeAirports = (crew.home_airports as string[]) ?? [];
      if (homeAirports.length === 0) {
        errors.push(`${crew.name}: no home airports`);
        continue;
      }
      try {
        const rows = computePilotRoutes({
          crewMemberId: crew.id as string,
          homeAirports,
          swapDate,
          destinations,
          aliases,
          scheduledFlights,
          priceMap,
        });
        allRows.push(...rows);
      } catch (e) {
        errors.push(`${crew.name}: ${e instanceof Error ? e.message : "unknown error"}`);
      }
    }

    crewProcessed += batch.length;

    // Batch insert all rows for this batch of crew
    if (allRows.length > 0) {
      // Delete existing routes for these crew members
      const crewIds = batch.map((c) => c.id as string);
      await supa
        .from("pilot_routes")
        .delete()
        .in("crew_member_id", crewIds)
        .eq("swap_date", swapDate);

      for (let j = 0; j < allRows.length; j += 100) {
        const chunk = allRows.slice(j, j + 100);
        const { error } = await supa.from("pilot_routes").insert(chunk);
        if (error) {
          console.error(`[PilotRoutes] Insert error:`, error.message);
        } else {
          totalRoutes += chunk.length;
        }
      }
    }

    if (crewProcessed % 50 === 0 && i + 10 < crewWithDifficulty.length) {
      console.log(`[PilotRoutes] Phase 3: ${crewProcessed}/${crewWithDifficulty.length} crew, ${totalRoutes} routes`);
    }
  }

  console.log(`[PilotRoutes] Done: ${crewProcessed} crew, ${totalRoutes} routes, ${flightAwareCalls} FA + ${hasDataCalls} HD calls, ${errors.length} errors`);
  return { crewProcessed, totalRoutes, flightAwareCalls, hasDataCalls, totalScheduledFlights, pricedPairs: priceMap.size, errors };
}

// ─── Load pre-computed routes for the optimizer ─────────────────────────────

/**
 * Load pre-computed routes from `pilot_routes` and convert them into
 * the Map<string, FlightOffer[]> format the optimizer expects.
 *
 * Key format: `${originIata}-${destIata}-${date}`
 * This matches the key format used by lookupFlights() in swapOptimizer.ts.
 */
export async function getRoutesForOptimizer(swapDate: string): Promise<{
  commercialFlights: Map<string, FlightOffer[]>;
  routeCount: number;
  crewRouteMap: Map<string, PilotRoute[]>;  // crewMemberId → routes
}> {
  const supa = createServiceClient();

  const { data, error } = await supa
    .from("pilot_routes")
    .select("*")
    .eq("swap_date", swapDate)
    .order("score", { ascending: false });

  if (error || !data) {
    console.error("[PilotRoutes] Failed to load routes:", error?.message);
    return { commercialFlights: new Map(), routeCount: 0, crewRouteMap: new Map() };
  }

  const commercialFlights = new Map<string, FlightOffer[]>();
  const crewRouteMap = new Map<string, PilotRoute[]>();

  for (const row of data) {
    // Build crew route map
    const crewId = row.crew_member_id as string;
    if (!crewRouteMap.has(crewId)) crewRouteMap.set(crewId, []);
    crewRouteMap.get(crewId)!.push(row as unknown as PilotRoute);

    // Build commercial flights map (only for flight routes with flight_data)
    if (row.route_type === "commercial" && row.flight_data && row.via_commercial) {
      const originIata = row.origin_iata as string;
      const destIata = row.via_commercial as string;
      const key = `${originIata}-${destIata}-${swapDate}`;

      if (!commercialFlights.has(key)) {
        commercialFlights.set(key, []);
      }

      const offer = row.flight_data as unknown as FlightOffer;
      // Deduplicate by flight number
      const existing = commercialFlights.get(key)!;
      const flightNum = row.flight_number as string;
      if (!existing.some((o) => {
        const segs = o.itineraries[0]?.segments ?? [];
        const oNum = segs.map((s) => `${s.carrierCode}${s.number}`).join("/");
        return oNum === flightNum;
      })) {
        existing.push(offer);
      }
    }
  }

  console.log(`[PilotRoutes] Loaded ${data.length} routes for ${swapDate}: ${commercialFlights.size} flight keys, ${crewRouteMap.size} crew members`);
  return { commercialFlights, routeCount: data.length, crewRouteMap };
}

// ─── Route status ───────────────────────────────────────────────────────────

/**
 * Get the computation status for a swap date.
 */
export async function getRouteStatus(swapDate: string): Promise<RouteComputationStatus> {
  const supa = createServiceClient();

  const { data, error } = await supa
    .from("pilot_routes")
    .select("crew_member_id, destination_icao, searched_at")
    .eq("swap_date", swapDate);

  if (error || !data || data.length === 0) {
    return {
      swap_date: swapDate,
      total_routes: 0,
      crew_count: 0,
      destination_count: 0,
      last_computed: null,
      is_stale: true,
    };
  }

  const crewIds = new Set(data.map((r) => r.crew_member_id));
  const destIcaos = new Set(data.map((r) => r.destination_icao));
  const latestSearch = data.reduce((latest, r) => {
    const t = r.searched_at as string;
    return t > latest ? t : latest;
  }, "");

  // Routes are stale if computed > 12 hours ago
  const staleThreshold = Date.now() - 12 * 60 * 60 * 1000;
  const isStale = new Date(latestSearch).getTime() < staleThreshold;

  return {
    swap_date: swapDate,
    total_routes: data.length,
    crew_count: crewIds.size,
    destination_count: destIcaos.size,
    last_computed: latestSearch,
    is_stale: isStale,
  };
}

/**
 * Clear all cached routes for a swap date.
 */
export async function clearRoutes(swapDate: string): Promise<{ deleted: number }> {
  const supa = createServiceClient();

  const { data, error } = await supa
    .from("pilot_routes")
    .delete()
    .eq("swap_date", swapDate)
    .select("id");

  if (error) {
    console.error("[PilotRoutes] Failed to clear routes:", error.message);
    return { deleted: 0 };
  }

  return { deleted: data?.length ?? 0 };
}
