import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, isAuthed } from "@/lib/api-auth";
import { searchFlights } from "@/lib/hasdata";

export const dynamic = "force-dynamic";

/**
 * GET /api/crew/flights?origin=IAH&destination=BUR&date=2026-03-11
 *
 * Search commercial flights for crew swap travel.
 * Supports ICAO (KIAH) or IATA (IAH) codes.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (!isAuthed(auth)) return auth.error;

  const { searchParams } = new URL(req.url);
  const origin = searchParams.get("origin");
  const destination = searchParams.get("destination");
  const date = searchParams.get("date");

  if (!origin || !destination || !date) {
    return NextResponse.json(
      { error: "Required params: origin, destination, date (YYYY-MM-DD)" },
      { status: 400 },
    );
  }

  // Validate date format
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return NextResponse.json({ error: "date must be YYYY-MM-DD" }, { status: 400 });
  }

  try {
    const result = await searchFlights({
      origin,
      destination,
      date,
      adults: 1,
      max: 10,
    });
    return NextResponse.json(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    console.error("[crew/flights]", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
