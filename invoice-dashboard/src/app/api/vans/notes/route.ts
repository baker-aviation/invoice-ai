import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthed } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";

export const dynamic = "force-dynamic";

/**
 * GET /api/vans/notes?date=YYYY-MM-DD
 * Returns all leg notes for a given date.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;

  const date = req.nextUrl.searchParams.get("date");
  if (!date) return NextResponse.json({ error: "date required" }, { status: 400 });

  const supa = createServiceClient();
  const { data, error } = await supa
    .from("van_leg_notes")
    .select("*")
    .eq("date", date)
    .order("created_at", { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ notes: data ?? [] });
}

/**
 * POST /api/vans/notes
 * { flight_id, date, tail_number, note, author }
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;

  const body = await req.json();
  const { flight_id, date, tail_number, note, author } = body;

  if (!flight_id || !date || !note?.trim()) {
    return NextResponse.json({ error: "flight_id, date, and note required" }, { status: 400 });
  }

  const supa = createServiceClient();
  const { data, error } = await supa
    .from("van_leg_notes")
    .upsert(
      {
        flight_id,
        date,
        tail_number: tail_number ?? null,
        note: note.trim(),
        author: author ?? null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "flight_id" },
    )
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, note: data });
}

/**
 * DELETE /api/vans/notes?flight_id=xxx
 */
export async function DELETE(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;

  const flightId = req.nextUrl.searchParams.get("flight_id");
  if (!flightId) return NextResponse.json({ error: "flight_id required" }, { status: 400 });

  const supa = createServiceClient();
  await supa.from("van_leg_notes").delete().eq("flight_id", flightId);
  return NextResponse.json({ ok: true });
}
