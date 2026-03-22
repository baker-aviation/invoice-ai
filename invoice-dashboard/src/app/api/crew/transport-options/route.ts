import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, isAuthed } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";
import type { PilotRoute } from "@/lib/pilotRoutes";
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
  FBO_ARRIVAL_BUFFER_PREFERRED,
  MAX_DUTY_HOURS,
  DEPLANE_BUFFER,
  UBER_MAX_MINUTES,
  RENTAL_MAX_MINUTES,
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
 *   destination_icao — swap location ICAO
 *   swap_date — YYYY-MM-DD
 *   direction — "oncoming" | "offgoing"
 *   first_leg_dep? — ISO string of first leg departure (for FBO buffer calc)
 *   last_leg_arr? — ISO string of last leg arrival (for duty day calc)
 *
 * Returns cached transport options from pilot_routes + computed ground options,
 * with server-side feasibility checks.
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

  const firstLegDep = sp.get("first_leg_dep"); // ISO string
  const lastLegArr = sp.get("last_leg_arr"); // ISO string

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

  // Load cached pilot_routes for this crew + destination + direction
  const { data: routes, error: routeErr } = await supa
    .from("pilot_routes")
    .select("*")
    .eq("crew_member_id", crewMemberId)
    .eq("destination_icao", destinationIcao)
    .eq("swap_date", swapDate)
    .eq("direction", direction)
    .order("score", { ascending: false });

  if (routeErr) {
    return NextResponse.json({ error: routeErr.message }, { status: 500 });
  }

  // Compute feasibility for each route
  const homeMidnight = homeAirports[0]
    ? midnightUtc(toIcao(homeAirports[0]), swapDate)
    : midnightUtc(destinationIcao, swapDate);

  const options: TransportOption[] = [];

  for (const r of (routes ?? []) as unknown as PilotRoute[]) {
    const feasibility = computeFeasibility(r, direction, firstLegDep, lastLegArr, homeMidnight);

    options.push({
      type: r.route_type as TransportOption["type"],
      flight_number: r.flight_number,
      origin_iata: r.origin_iata,
      destination_iata: r.via_commercial ?? toIata(destinationIcao),
      depart_at: r.depart_at,
      arrive_at: r.arrive_at,
      fbo_arrive_at: r.fbo_arrive_at,
      duty_on_at: r.duty_on_at,
      cost_estimate: r.cost_estimate,
      duration_minutes: r.duration_minutes,
      is_direct: r.is_direct,
      connection_count: r.connection_count,
      has_backup: r.has_backup,
      backup_flight: r.backup_flight,
      score: r.score,
      feasibility,
    });
  }

  // Always include ground options computed live (in case not in pilot_routes)
  const groundTypes = new Set(options.filter((o) => o.type !== "commercial").map((o) => `${o.type}-${o.origin_iata}`));
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
          feasibility: {
            duty_hours: null,
            duty_ok: true, // ground transport within limits is always ok
            fbo_buffer_min: null,
            fbo_buffer_ok: true,
            midnight_ok: true,
          },
        });
        groundTypes.add(key);
      }

      // Self-drive option
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
          feasibility: {
            duty_hours: null,
            duty_ok: true,
            fbo_buffer_min: null,
            fbo_buffer_ok: true,
            midnight_ok: true,
          },
        });
        groundTypes.add(driveKey);
      }
    }
  }

  // Sort: feasible options first, then by score descending
  options.sort((a, b) => {
    const aOk = a.feasibility.duty_ok && a.feasibility.fbo_buffer_ok && a.feasibility.midnight_ok ? 1 : 0;
    const bOk = b.feasibility.duty_ok && b.feasibility.fbo_buffer_ok && b.feasibility.midnight_ok ? 1 : 0;
    if (aOk !== bOk) return bOk - aOk;
    return b.score - a.score;
  });

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
  });
}

// ─── Feasibility computation ────────────────────────────────────────────────

function computeFeasibility(
  route: PilotRoute,
  direction: "oncoming" | "offgoing",
  firstLegDep: string | null,
  lastLegArr: string | null,
  homeMidnight: Date,
): TransportOption["feasibility"] {
  let dutyHours: number | null = null;
  let dutyOk = true;
  let fboBufferMin: number | null = null;
  let fboBufferOk = true;
  let midnightOk = true;

  if (direction === "oncoming") {
    // Duty hours: duty_on → last leg arrival (if provided)
    if (route.duty_on_at && lastLegArr) {
      const dutyOn = new Date(route.duty_on_at);
      const dutyEnd = new Date(lastLegArr);
      const check = checkDutyDay(dutyOn, dutyEnd);
      dutyHours = Math.round(check.hours * 10) / 10;
      dutyOk = check.valid;
    }

    // FBO buffer: how many minutes before first leg departure does crew arrive at FBO
    if (route.fbo_arrive_at && firstLegDep) {
      const fboArr = new Date(route.fbo_arrive_at);
      const legDep = new Date(firstLegDep);
      fboBufferMin = Math.round((legDep.getTime() - fboArr.getTime()) / 60_000);
      fboBufferOk = fboBufferMin >= FBO_ARRIVAL_BUFFER;
    }
  } else {
    // Offgoing: check midnight deadline
    if (route.arrive_at) {
      const homeArrival = new Date(route.arrive_at);
      // Add deplane buffer for commercial
      const effectiveArrival = route.route_type === "commercial"
        ? new Date(homeArrival.getTime() + ms(DEPLANE_BUFFER))
        : homeArrival;
      midnightOk = effectiveArrival.getTime() <= homeMidnight.getTime();
    }
  }

  return {
    duty_hours: dutyHours,
    duty_ok: dutyOk,
    fbo_buffer_min: fboBufferMin,
    fbo_buffer_ok: fboBufferOk,
    midnight_ok: midnightOk,
  };
}
