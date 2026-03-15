import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, isAuthed } from "@/lib/api-auth";
import { computeAllRoutes, getRouteStatus, clearRoutes } from "@/lib/pilotRoutes";

export const dynamic = "force-dynamic";
export const maxDuration = 120; // 2 min — bulk FlightAware fetch (~60 calls) + local matching

/**
 * POST /api/crew/routes
 * Body: { swap_date: "2026-03-18" }
 *
 * Triggers route computation for all crew members to all swap-day airports.
 */
export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (!isAuthed(auth)) return auth.error;

  try {
    const body = await req.json();
    const swapDate = body.swap_date as string;

    if (!swapDate || !/^\d{4}-\d{2}-\d{2}$/.test(swapDate)) {
      return NextResponse.json({ error: "swap_date required (YYYY-MM-DD)" }, { status: 400 });
    }

    console.log(`[Routes API] Computing routes for ${swapDate}`);
    const result = await computeAllRoutes(swapDate);

    return NextResponse.json({
      ok: true,
      swap_date: swapDate,
      crew_processed: result.crewProcessed,
      total_routes: result.totalRoutes,
      flightaware_calls: result.flightAwareCalls,
      scheduled_flights: result.totalScheduledFlights,
      errors: result.errors.length > 0 ? result.errors : undefined,
    });
  } catch (e) {
    console.error("[Routes API] Error:", e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Route computation failed" },
      { status: 500 },
    );
  }
}

/**
 * GET /api/crew/routes?date=2026-03-18
 *
 * Get computation status/summary for a swap date.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (!isAuthed(auth)) return auth.error;

  const date = req.nextUrl.searchParams.get("date");
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return NextResponse.json({ error: "date query param required (YYYY-MM-DD)" }, { status: 400 });
  }

  const status = await getRouteStatus(date);
  return NextResponse.json(status);
}

/**
 * DELETE /api/crew/routes?date=2026-03-18
 *
 * Clear cached routes for a swap date.
 */
export async function DELETE(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (!isAuthed(auth)) return auth.error;

  const date = req.nextUrl.searchParams.get("date");
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return NextResponse.json({ error: "date query param required (YYYY-MM-DD)" }, { status: 400 });
  }

  const result = await clearRoutes(date);
  return NextResponse.json({ ok: true, deleted: result.deleted });
}
