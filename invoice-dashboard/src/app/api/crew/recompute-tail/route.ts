import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin, isAuthed } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";
import type { PilotRoute } from "@/lib/pilotRoutes";
import { toIata, toIcao } from "@/lib/swapOptimizer";
import { estimateDriveTime } from "@/lib/driveTime";
import { UBER_MAX_MINUTES } from "@/lib/swapRules";

export const dynamic = "force-dynamic";

const RequestSchema = z.object({
  tail_number: z.string(),
  new_swap_point: z.string(), // ICAO
  swap_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  crew_assignments: z.object({
    oncoming_pic: z.string().nullable().optional(),
    oncoming_sic: z.string().nullable().optional(),
    offgoing_pic: z.string().nullable().optional(),
    offgoing_sic: z.string().nullable().optional(),
  }),
}).strip();

type CrewTransport = {
  name: string;
  role: "PIC" | "SIC";
  direction: "oncoming" | "offgoing";
  best_option: {
    type: string;
    flight_number: string | null;
    origin_iata: string;
    depart_at: string | null;
    arrive_at: string | null;
    fbo_arrive_at: string | null;
    duty_on_at: string | null;
    cost_estimate: number;
    duration_minutes: number | null;
    score: number;
    has_backup: boolean;
    backup_flight: string | null;
  } | null;
  option_count: number;
};

/**
 * POST /api/crew/recompute-tail
 *
 * Given a tail with a new swap point, find the best transport options
 * for each crew member from their pre-computed routes.
 */
export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (!isAuthed(auth)) return auth.error;

  let raw: unknown;
  try { raw = await req.json(); } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = RequestSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten().fieldErrors }, { status: 400 });
  }

  const { tail_number, new_swap_point, swap_date, crew_assignments } = parsed.data;
  const supa = createServiceClient();

  // Resolve crew member IDs from names
  const crewSlots: { name: string; role: "PIC" | "SIC"; direction: "oncoming" | "offgoing" }[] = [];
  if (crew_assignments.oncoming_pic) crewSlots.push({ name: crew_assignments.oncoming_pic, role: "PIC", direction: "oncoming" });
  if (crew_assignments.oncoming_sic) crewSlots.push({ name: crew_assignments.oncoming_sic, role: "SIC", direction: "oncoming" });
  if (crew_assignments.offgoing_pic) crewSlots.push({ name: crew_assignments.offgoing_pic, role: "PIC", direction: "offgoing" });
  if (crew_assignments.offgoing_sic) crewSlots.push({ name: crew_assignments.offgoing_sic, role: "SIC", direction: "offgoing" });

  if (crewSlots.length === 0) {
    return NextResponse.json({ error: "No crew assigned" }, { status: 400 });
  }

  // Load crew members
  const crewNames = crewSlots.map((s) => s.name);
  const { data: crewData } = await supa
    .from("crew_members")
    .select("id, name, role, home_airports")
    .in("name", crewNames);

  const crewMap = new Map((crewData ?? []).map((c) => [c.name as string, c]));

  const results: CrewTransport[] = [];
  let totalCost = 0;

  for (const slot of crewSlots) {
    const crewRow = crewMap.get(slot.name);
    if (!crewRow) {
      results.push({ name: slot.name, role: slot.role, direction: slot.direction, best_option: null, option_count: 0 });
      continue;
    }

    // Look up pilot_routes for this crew + new swap point
    const { data: routes } = await supa
      .from("pilot_routes")
      .select("*")
      .eq("crew_member_id", crewRow.id)
      .eq("destination_icao", new_swap_point)
      .eq("swap_date", swap_date)
      .eq("direction", slot.direction)
      .order("score", { ascending: false })
      .limit(1);

    const bestRoute = (routes ?? [])[0] as unknown as PilotRoute | undefined;

    if (bestRoute) {
      results.push({
        name: slot.name,
        role: slot.role,
        direction: slot.direction,
        best_option: {
          type: bestRoute.route_type,
          flight_number: bestRoute.flight_number,
          origin_iata: bestRoute.origin_iata,
          depart_at: bestRoute.depart_at,
          arrive_at: bestRoute.arrive_at,
          fbo_arrive_at: bestRoute.fbo_arrive_at,
          duty_on_at: bestRoute.duty_on_at,
          cost_estimate: bestRoute.cost_estimate,
          duration_minutes: bestRoute.duration_minutes,
          score: bestRoute.score,
          has_backup: bestRoute.has_backup,
          backup_flight: bestRoute.backup_flight,
        },
        option_count: 1, // We queried with limit 1
      });
      totalCost += bestRoute.cost_estimate;
    } else {
      // Check if ground transport is possible
      const homeAirports = (crewRow.home_airports as string[]) ?? [];
      let groundOption = null;
      for (const home of homeAirports) {
        const drive = estimateDriveTime(toIcao(home), new_swap_point);
        if (drive && drive.estimated_drive_minutes <= 300) {
          const isUber = drive.estimated_drive_minutes <= UBER_MAX_MINUTES;
          const cost = isUber
            ? Math.max(25, Math.round(drive.estimated_drive_miles * 2.0))
            : 80 + Math.round(drive.estimated_drive_miles * 0.50);
          groundOption = {
            type: isUber ? "uber" : "rental_car",
            flight_number: null,
            origin_iata: toIata(home),
            depart_at: null,
            arrive_at: null,
            fbo_arrive_at: null,
            duty_on_at: null,
            cost_estimate: cost,
            duration_minutes: drive.estimated_drive_minutes,
            score: isUber ? 70 : 50,
            has_backup: false,
            backup_flight: null,
          };
          totalCost += cost;
          break;
        }
      }

      results.push({
        name: slot.name,
        role: slot.role,
        direction: slot.direction,
        best_option: groundOption,
        option_count: groundOption ? 1 : 0,
      });
    }
  }

  return NextResponse.json({
    tail_number,
    new_swap_point,
    new_swap_point_iata: toIata(new_swap_point),
    crew: results,
    total_cost: totalCost,
  });
}
