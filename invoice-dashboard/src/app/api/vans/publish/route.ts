import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthed, isRateLimited } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";

/**
 * POST /api/vans/publish
 *
 * Publishes the Director's finalized schedule for all vans on a given date.
 * Body: { date: string, assignments: { vanId: number, flightIds: string[] }[] }
 *
 * GET /api/vans/publish?date=YYYY-MM-DD
 *
 * Checks if a published schedule exists for the given date.
 * Returns { published_at: string | null }
 */

type SyntheticFlight = {
  id: string;
  tail: string;
  airport: string | null;
};

type Assignment = {
  vanId: number;
  flightIds: string[];
  syntheticFlights?: SyntheticFlight[];
};

type PublishBody = {
  date: string;
  assignments: Assignment[];
};

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;

  const date = req.nextUrl.searchParams.get("date");
  if (!date) {
    return NextResponse.json({ error: "Missing date parameter" }, { status: 400 });
  }

  const supa = createServiceClient();
  const { data } = await supa
    .from("van_published_schedules")
    .select("van_id, flight_ids, synthetic_flights, published_at")
    .eq("schedule_date", date)
    .order("published_at", { ascending: false });

  const publishedAt = data?.[0]?.published_at ?? null;
  const assignments = (data ?? []).map((row: any) => ({
    vanId: row.van_id,
    flightIds: row.flight_ids ?? [],
    syntheticFlights: row.synthetic_flights ?? [],
  }));
  return NextResponse.json({ published_at: publishedAt, assignments });
}

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;

  if (await isRateLimited(auth.userId, 10)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  let body: PublishBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { date, assignments } = body;
  if (!date || !assignments || !Array.isArray(assignments)) {
    return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
  }

  const supa = createServiceClient();
  const now = new Date().toISOString();

  // Upsert all van assignments for this date
  const rows = assignments.map((a) => ({
    van_id: a.vanId,
    schedule_date: date,
    flight_ids: a.flightIds,
    synthetic_flights: a.syntheticFlights ?? null,
    published_by: auth.userId,
    published_at: now,
  }));

  const { error } = await supa
    .from("van_published_schedules")
    .upsert(rows, { onConflict: "van_id,schedule_date" });

  if (error) {
    console.error("[vans/publish] Upsert error:", error.message, error.details, JSON.stringify(rows));
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, published_at: now });
}
