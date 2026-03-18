import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { requireAuth, isAuthed } from "@/lib/api-auth";

/**
 * GET /api/vans/drafts?date=2026-03-15
 * Load shared draft overrides for a date.
 *
 * POST /api/vans/drafts
 * Save draft overrides for a date (shared across all admins).
 *
 * Columns: overrides, removals, unscheduled, leg_notes,
 *   wont_see_tails (string[]), dismissed_conflicts (Record<id, hash>),
 *   hidden_mx_ids (string[]), airport_overrides ([tail, airport][])
 *
 * Migration (run in Supabase SQL editor):
 *   ALTER TABLE van_draft_overrides
 *     ADD COLUMN IF NOT EXISTS wont_see_tails jsonb DEFAULT '[]'::jsonb,
 *     ADD COLUMN IF NOT EXISTS dismissed_conflicts jsonb DEFAULT '{}'::jsonb,
 *     ADD COLUMN IF NOT EXISTS hidden_mx_ids jsonb DEFAULT '[]'::jsonb,
 *     ADD COLUMN IF NOT EXISTS airport_overrides jsonb DEFAULT '[]'::jsonb;
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
    wont_see_tails: data?.wont_see_tails ?? [],
    dismissed_conflicts: data?.dismissed_conflicts ?? {},
    hidden_mx_ids: data?.hidden_mx_ids ?? [],
    airport_overrides: data?.airport_overrides ?? [],
    updated_at: data?.updated_at ?? null,
  });
}

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;

  const body = await req.json();
  const { date, overrides, removals, unscheduled, leg_notes,
    wont_see_tails, dismissed_conflicts, hidden_mx_ids, airport_overrides } = body;
  if (!date) return NextResponse.json({ error: "date required" }, { status: 400 });

  const supa = createServiceClient();
  const now = new Date().toISOString();
  const { error } = await supa
    .from("van_draft_overrides")
    .upsert({
      date,
      overrides: overrides ?? [],
      removals: removals ?? [],
      unscheduled: unscheduled ?? [],
      leg_notes: leg_notes ?? {},
      wont_see_tails: wont_see_tails ?? [],
      dismissed_conflicts: dismissed_conflicts ?? {},
      hidden_mx_ids: hidden_mx_ids ?? [],
      airport_overrides: airport_overrides ?? [],
      updated_by: auth.userId,
      updated_at: now,
    }, { onConflict: "date" });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true, updated_at: now });
}
