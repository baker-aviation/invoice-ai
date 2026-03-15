import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { requireAuth, isAuthed } from "@/lib/api-auth";

/**
 * GET /api/vans/drafts?date=2026-03-15
 * Load shared draft overrides for a date.
 *
 * POST /api/vans/drafts
 * Save draft overrides for a date (shared across all admins).
 */

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;

  const date = req.nextUrl.searchParams.get("date");
  if (!date) return NextResponse.json({ error: "date required" }, { status: 400 });

  const supa = createServiceClient();
  const { data, error } = await supa
    .from("van_draft_overrides")
    .select("*")
    .eq("date", date)
    .maybeSingle();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({
    date,
    overrides: data?.overrides ?? [],
    removals: data?.removals ?? [],
    unscheduled: data?.unscheduled ?? [],
    leg_notes: data?.leg_notes ?? {},
    updated_at: data?.updated_at ?? null,
  });
}

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;

  const body = await req.json();
  const { date, overrides, removals, unscheduled, leg_notes } = body;
  if (!date) return NextResponse.json({ error: "date required" }, { status: 400 });

  const supa = createServiceClient();
  const { error } = await supa
    .from("van_draft_overrides")
    .upsert({
      date,
      overrides: overrides ?? [],
      removals: removals ?? [],
      unscheduled: unscheduled ?? [],
      leg_notes: leg_notes ?? {},
      updated_by: auth.user.id,
      updated_at: new Date().toISOString(),
    }, { onConflict: "date" });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true });
}
