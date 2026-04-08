import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, isAuthed } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";
import type { FlightOffer } from "@/lib/amadeus";
import {
  checkDutyDay,
  midnightUtc,
  fboArrivalAfterCommercial,
  dutyOnForCommercial,
  ms,
  toIata,
  toIcao,
  findAllCommercialAirports,
  type AirportAlias,
} from "@/lib/swapOptimizer";
import { estimateDriveTime } from "@/lib/driveTime";
import { DEFAULT_AIRPORT_ALIASES } from "@/lib/airportAliases";
import {
  FBO_ARRIVAL_BUFFER,
  DEPLANE_BUFFER,
  UBER_MAX_MINUTES,
  RENTAL_MAX_MINUTES,
  DUTY_ON_BEFORE_COMMERCIAL,
} from "@/lib/swapRules";

export const dynamic = "force-dynamic";

// ─── Types ──────────────────────────────────────────────────────────────────

type TransportOption = {
  type: "commercial" | "uber" | "rental_car" | "drive" | "train";
  flight_number: string | null;
  origin_iata: string;
  destination_iata: string | null;
  depart_at: string | null;
  arrive_at: string | null;
  fbo_arrive_at: string | null;
  duty_on_at: string | null;
  cost_estimate: number;
  duration_minutes: number | null;
  is_direct: boolean;
  connection_count: number;
  has_backup: boolean;
  backup_flight: string | null;
  score: number;
  feasibility: {
    duty_hours: number | null;
    duty_ok: boolean;
    fbo_buffer_min: number | null;
    fbo_buffer_ok: boolean;
    midnight_ok: boolean;
  };
};

/**
 * GET /api/crew/transport-options
 *
 * Query params:
 *   crew_member_id — UUID of crew member
 *   destination_icao — swap location ICAO (FBO airport)
 *   swap_date — YYYY-MM-DD
 *   direction — "oncoming" | "offgoing"
 *   first_leg_dep? — ISO string of first leg departure (for FBO buffer calc)
 *   last_leg_arr? — ISO string of last leg arrival (for duty day calc)
 *
 * Primary data source: hasdata_flight_cache (Google Flights — real prices,
 * connections, works weeks out). Falls back to pilot_routes for any additional
 * ground transport options.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (!isAuthed(auth)) return auth.error;

  const sp = req.nextUrl.searchParams;
  const crewMemberId = sp.get("crew_member_id");
  const destinationIcao = sp.get("destination_icao");
  const swapDate = sp.get("swap_date");
  const direction = sp.get("direction") as "oncoming" | "offgoing" | null;

  if (!crewMemberId || !destinationIcao || !swapDate || !direction) {
    return NextResponse.json(
      { error: "crew_member_id, destination_icao, swap_date, direction required" },
      { status: 400 },
    );
  }

  const firstLegDep = sp.get("first_leg_dep");
  const lastLegArr = sp.get("last_leg_arr");

  const supa = createServiceClient();

  // Load crew member
  const { data: crewRow, error: crewErr } = await supa
    .from("crew_members")
    .select("id, name, role, home_airports")
    .eq("id", crewMemberId)
    .maybeSingle();

  if (crewErr || !crewRow) {
    return NextResponse.json({ error: "Crew member not found" }, { status: 404 });
  }

  const homeAirports = (crewRow.home_airports as string[]) ?? [];

  // Load aliases
  const { data: aliasData } = await supa
    .from("airport_aliases")
    .select("fbo_icao, commercial_icao, preferred");

  const dbAliases: AirportAlias[] = (aliasData ?? []).map((a) => ({
    fbo_icao: a.fbo_icao as string,
    commercial_icao: a.commercial_icao as string,
    preferred: (a.preferred as boolean) ?? false,
  }));
  const dbKeys = new Set(dbAliases.map((a) => `${a.fbo_icao}|${a.commercial_icao}`));
  const aliases: AirportAlias[] = [
    ...dbAliases,
    ...DEFAULT_AIRPORT_ALIASES.filter((a) => !dbKeys.has(`${a.fbo_icao}|${a.commercial_icao}`)),
  ];

  // ── Resolve airports ──────────────────────────────────────────────────
  // Crew home airports → IATA codes
  const homeIatas = homeAirports.map((h) => toIata(h));

  // FBO destination → nearby commercial IATA codes
  const commAirportsIcao = findAllCommercialAirports(destinationIcao, aliases);
  const commIatas = commAirportsIcao.map((c) => toIata(c));

  // Drive times from each commercial airport to the FBO
  const driveToFboMap = new Map<string, number>(); // commIata → minutes
  for (const commIcao of commAirportsIcao) {
    const ci = toIata(commIcao);
    if (ci === toIata(destinationIcao)) {
      driveToFboMap.set(ci, 0); // FBO itself is commercial
    } else {
      const drive = estimateDriveTime(commIcao, destinationIcao);
      if (drive) driveToFboMap.set(ci, drive.estimated_drive_minutes);
    }
  }

  // ── Build O→D pairs to query from hasdata_flight_cache ────────────────
  // Oncoming: home → commercial near FBO
  // Offgoing: commercial near FBO → home
  const pairsToQuery: { origin: string; dest: string }[] = [];
  for (const home of homeIatas) {
    for (const comm of commIatas) {
      if (home === comm) continue;
      if (direction === "oncoming") {
        pairsToQuery.push({ origin: home, dest: comm });
      } else {
        pairsToQuery.push({ origin: comm, dest: home });
      }
    }
  }

  // ── Query hasdata_flight_cache ────────────────────────────────────────
  const options: TransportOption[] = [];
  const homeMidnight = homeAirports[0]
    ? midnightUtc(toIcao(homeAirports[0]), swapDate)
    : midnightUtc(destinationIcao, swapDate);

  if (pairsToQuery.length > 0) {
    // Query all relevant pairs in one go using OR filter
    const origins = [...new Set(pairsToQuery.map((p) => p.origin))];
    const dests = [...new Set(pairsToQuery.map((p) => p.dest))];

    const { data: cacheRows, error: cacheErr } = await supa
      .from("hasdata_flight_cache")
      .select("origin_iata, destination_iata, flight_offers, offer_count")
      .eq("cache_date", swapDate)
      .in("origin_iata", origins)
      .in("destination_iata", dests);

    if (cacheErr) {
      console.error("[TransportOptions] Cache query error:", cacheErr.message);
    }

    // Index by pair key for fast lookup
    const validPairs = new Set(pairsToQuery.map((p) => `${p.origin}-${p.dest}`));
    const seenFlights = new Set<string>();

    for (const row of cacheRows ?? []) {
      const pairKey = `${row.origin_iata}-${row.destination_iata}`;
      if (!validPairs.has(pairKey)) continue;

      const offers = (typeof row.flight_offers === "string"
        ? JSON.parse(row.flight_offers as string)
        : row.flight_offers) as FlightOffer[];

      for (const offer of offers) {
        const segs = offer.itineraries[0]?.segments ?? [];
        if (segs.length === 0) continue;

        const firstSeg = segs[0];
        const lastSeg = segs[segs.length - 1];
        const flightNum = segs.map((s) => `${s.carrierCode}${s.number}`).join("/");

        // Dedupe by flight number
        if (seenFlights.has(flightNum)) continue;
        seenFlights.add(flightNum);

        const price = parseFloat(offer.price.total);
        const totalDuration = parseDuration(offer.itineraries[0]?.duration ?? "PT0M");
        const isDirect = segs.length === 1;
        const connectionCount = Math.max(0, segs.length - 1);

        const depAt = firstSeg.departure.at;
        const arrAt = lastSeg.arrival.at;

        // Determine the commercial airport near the FBO
        const commIata = direction === "oncoming"
          ? lastSeg.arrival.iataCode
          : firstSeg.departure.iataCode;
        const driveToFboMin = driveToFboMap.get(commIata) ?? driveToFboMap.get(toIata(commIata)) ?? 0;

        // Compute FBO arrival and duty-on times
        let fboArriveAt: string | null = null;
        let dutyOnAt: string | null = null;

        if (direction === "oncoming" && arrAt) {
          // FBO arrival = flight landing + deplane + ground transfer to FBO
          const fboArr = fboArrivalAfterCommercial(new Date(arrAt), driveToFboMin);
          fboArriveAt = fboArr.toISOString();
          // Duty-on = 60min before flight departure
          if (depAt) {
            dutyOnAt = dutyOnForCommercial(new Date(depAt)).toISOString();
          }
        } else if (direction === "offgoing" && depAt) {
          // Offgoing: crew leaves FBO, drives to commercial, flies home
          // FBO leave time = flight departure - ground transfer - airport security (90min)
          const fboLeaveMs = new Date(depAt).getTime() - ms(90 + driveToFboMin);
          fboArriveAt = new Date(fboLeaveMs).toISOString(); // repurpose as FBO leave time
        }

        // Ground cost from commercial airport to FBO
        let groundCost = 0;
        if (driveToFboMin > 0 && driveToFboMin <= UBER_MAX_MINUTES) {
          groundCost = Math.max(25, Math.round(driveToFboMin * 1.5)); // rough Uber estimate
        } else if (driveToFboMin > 0) {
          groundCost = 50; // rental shuttle estimate
        }

        const totalCost = (isNaN(price) ? 0 : Math.round(price)) + groundCost;

        // Score
        let score = 50;
        if (totalCost <= 100) score += 20;
        else if (totalCost <= 300) score += 10;
        if (isDirect) score += 12;
        else if (connectionCount === 1) score += 5;

        // Feasibility
        const feasibility = computeFeasibilityFromTimes({
          direction,
          dutyOnAt,
          fboArriveAt,
          arriveAt: arrAt,
          routeType: "commercial",
          firstLegDep,
          lastLegArr,
          homeMidnight,
        });

        options.push({
          type: "commercial",
          flight_number: flightNum || null,
          origin_iata: firstSeg.departure.iataCode,
          destination_iata: lastSeg.arrival.iataCode,
          depart_at: depAt,
          arrive_at: arrAt,
          fbo_arrive_at: fboArriveAt,
          duty_on_at: dutyOnAt,
          cost_estimate: totalCost,
          duration_minutes: totalDuration,
          is_direct: isDirect,
          connection_count: connectionCount,
          has_backup: false,
          backup_flight: null,
          score,
          feasibility,
        });
      }
    }
  }

  // ── Ground transport options (computed live) ───────────────────────────
  const groundTypes = new Set<string>();
  for (const homeApt of homeAirports) {
    const homeIata = toIata(homeApt);
    const homeIcao = toIcao(homeApt);
    const drive = estimateDriveTime(homeIcao, destinationIcao);

    if (drive && drive.estimated_drive_minutes <= RENTAL_MAX_MINUTES) {
      const driveMin = drive.estimated_drive_minutes;
      const isUber = driveMin <= UBER_MAX_MINUTES;
      const type = isUber ? "uber" : "rental_car";
      const key = `${type}-${homeIata}`;

      if (!groundTypes.has(key)) {
        const cost = isUber
          ? Math.max(25, Math.round(drive.estimated_drive_miles * 2.0))
          : 80 + Math.round(drive.estimated_drive_miles * 0.50);

        options.push({
          type,
          flight_number: null,
          origin_iata: homeIata,
          destination_iata: toIata(destinationIcao),
          depart_at: null,
          arrive_at: null,
          fbo_arrive_at: null,
          duty_on_at: null,
          cost_estimate: cost,
          duration_minutes: driveMin,
          is_direct: true,
          connection_count: 0,
          has_backup: false,
          backup_flight: null,
          score: isUber ? 70 : 50,
          feasibility: { duty_hours: null, duty_ok: true, fbo_buffer_min: null, fbo_buffer_ok: true, midnight_ok: true },
        });
        groundTypes.add(key);
      }

      // Self-drive
      const driveKey = `drive-${homeIata}`;
      if (!groundTypes.has(driveKey)) {
        const driveCost = Math.round(drive.estimated_drive_miles * 0.25);
        options.push({
          type: "drive",
          flight_number: null,
          origin_iata: homeIata,
          destination_iata: toIata(destinationIcao),
          depart_at: null,
          arrive_at: null,
          fbo_arrive_at: null,
          duty_on_at: null,
          cost_estimate: driveCost,
          duration_minutes: driveMin,
          is_direct: true,
          connection_count: 0,
          has_backup: false,
          backup_flight: null,
          score: 40,
          feasibility: { duty_hours: null, duty_ok: true, fbo_buffer_min: null, fbo_buffer_ok: true, midnight_ok: true },
        });
        groundTypes.add(driveKey);
      }
    }
  }

  // Sort: feasible first, then by score descending
  options.sort((a, b) => {
    const aOk = a.feasibility.duty_ok && a.feasibility.fbo_buffer_ok && a.feasibility.midnight_ok ? 1 : 0;
    const bOk = b.feasibility.duty_ok && b.feasibility.fbo_buffer_ok && b.feasibility.midnight_ok ? 1 : 0;
    if (aOk !== bOk) return bOk - aOk;
    return b.score - a.score;
  });

  // Check if any requested flight pairs were missing from the cache.
  // If so, tell the frontend so it can offer to seed them on-demand.
  const commercialOptions = options.filter((o) => o.type === "commercial");
  const flightsNotSeeded = pairsToQuery.length > 0 && commercialOptions.length === 0;
  const unseededPairs = flightsNotSeeded
    ? pairsToQuery.map((p) => ({ origin: p.origin, destination: p.dest, date: swapDate }))
    : [];

  return NextResponse.json({
    crew: {
      id: crewRow.id,
      name: crewRow.name,
      role: crewRow.role,
      home_airports: homeAirports,
    },
    destination: {
      icao: destinationIcao,
      iata: toIata(destinationIcao),
    },
    direction,
    options,
    total: options.length,
    flights_not_seeded: flightsNotSeeded,
    unseeded_pairs: unseededPairs,
  });
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function parseDuration(iso: string): number {
  const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?/);
  if (!m) return 0;
  return (parseInt(m[1] ?? "0") * 60) + parseInt(m[2] ?? "0");
}

function computeFeasibilityFromTimes(params: {
  direction: "oncoming" | "offgoing";
  dutyOnAt: string | null;
  fboArriveAt: string | null;
  arriveAt: string | null;
  routeType: string;
  firstLegDep: string | null;
  lastLegArr: string | null;
  homeMidnight: Date;
}): TransportOption["feasibility"] {
  const { direction, dutyOnAt, fboArriveAt, arriveAt, routeType, firstLegDep, lastLegArr, homeMidnight } = params;

  let dutyHours: number | null = null;
  let dutyOk = true;
  let fboBufferMin: number | null = null;
  let fboBufferOk = true;
  let midnightOk = true;

  if (direction === "oncoming") {
    if (dutyOnAt && lastLegArr) {
      const check = checkDutyDay(new Date(dutyOnAt), new Date(lastLegArr));
      dutyHours = Math.round(check.hours * 10) / 10;
      dutyOk = check.valid;
    }
    if (fboArriveAt && firstLegDep) {
      fboBufferMin = Math.round((new Date(firstLegDep).getTime() - new Date(fboArriveAt).getTime()) / 60_000);
      fboBufferOk = fboBufferMin >= FBO_ARRIVAL_BUFFER;
    }
  } else {
    if (arriveAt) {
      const homeArrival = new Date(arriveAt);
      const effectiveArrival = routeType === "commercial"
        ? new Date(homeArrival.getTime() + ms(DEPLANE_BUFFER))
        : homeArrival;
      midnightOk = effectiveArrival.getTime() <= homeMidnight.getTime();
    }
  }

  return { duty_hours: dutyHours, duty_ok: dutyOk, fbo_buffer_min: fboBufferMin, fbo_buffer_ok: fboBufferOk, midnight_ok: midnightOk };
}
