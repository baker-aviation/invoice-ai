import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, isAuthed } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";
import { runParser } from "@/app/api/cron/parse-volunteers/route";

export const dynamic = "force-dynamic";

/**
 * GET /api/crew/volunteers?swap_date=2026-03-18
 * Returns parsed volunteer responses for a given swap date.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (!isAuthed(auth)) return auth.error;

  const swapDate = req.nextUrl.searchParams.get("swap_date");
  if (!swapDate) {
    return NextResponse.json({ error: "swap_date required" }, { status: 400 });
  }

  const supa = createServiceClient();
  const { data, error } = await supa
    .from("volunteer_responses")
    .select(`
      id,
      swap_date,
      slack_user_id,
      crew_member_id,
      raw_text,
      parsed_preference,
      notes,
      thread_ts,
      parsed_at,
      crew_members (id, name, role, home_airports)
    `)
    .eq("swap_date", swapDate)
    .order("parsed_at");

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ volunteers: data, count: data?.length ?? 0 });
}

/**
 * POST /api/crew/volunteers
 * Body: { swap_date?: "2026-03-18" }
 * Manually triggers the Slack thread parser (same logic as the cron job).
 */
export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (!isAuthed(auth)) return auth.error;

  const body = await req.json().catch(() => ({}));
  const swapDate = (body as { swap_date?: string }).swap_date;

  return runParser(swapDate);
}

/**
 * PATCH /api/crew/volunteers
 * Body: { id: "uuid", parsed_preference: "early", notes?: "..." }
 * Override a parsed preference manually.
 */
export async function PATCH(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (!isAuthed(auth)) return auth.error;

  const body = await req.json();
  const { id, parsed_preference, notes, crew_member_id } = body as {
    id: string;
    parsed_preference?: string;
    notes?: string;
    crew_member_id?: string;
  };

  if (!id) {
    return NextResponse.json({ error: "id required" }, { status: 400 });
  }

  const validPrefs = ["early", "late", "standby", "early_and_late", "unknown"];
  if (parsed_preference && !validPrefs.includes(parsed_preference)) {
    return NextResponse.json(
      { error: `parsed_preference must be one of: ${validPrefs.join(", ")}` },
      { status: 400 },
    );
  }

  const supa = createServiceClient();
  const update: Record<string, unknown> = {};
  if (parsed_preference) update.parsed_preference = parsed_preference;
  if (notes !== undefined) update.notes = notes;
  if (crew_member_id !== undefined) update.crew_member_id = crew_member_id;

  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
  }

  const { data, error } = await supa
    .from("volunteer_responses")
    .update(update)
    .eq("id", id)
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, volunteer: data });
}
