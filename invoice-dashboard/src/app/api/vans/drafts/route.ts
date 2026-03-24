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
 *   hidden_mx_ids (string[]), airport_overrides ([tail, airport][]),
 *   sort_overrides ([vanId, flightId[]][])
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
    sort_overrides: data?.sort_overrides ?? [],
    updated_at: data?.updated_at ?? null,
  });
}

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;

  const body = await req.json();
  const { date, overrides, removals, unscheduled, leg_notes,
    wont_see_tails, dismissed_conflicts, hidden_mx_ids, airport_overrides, sort_overrides,
    expected_updated_at } = body;
  if (!date) return NextResponse.json({ error: "date required" }, { status: 400 });

  const supa = createServiceClient();
  const now = new Date().toISOString();
  const payload = {
    date,
    overrides: overrides ?? [],
    removals: removals ?? [],
    unscheduled: unscheduled ?? [],
    leg_notes: leg_notes ?? {},
    wont_see_tails: wont_see_tails ?? [],
    dismissed_conflicts: dismissed_conflicts ?? {},
    hidden_mx_ids: hidden_mx_ids ?? [],
    airport_overrides: airport_overrides ?? [],
    sort_overrides: sort_overrides ?? [],
    updated_by: auth.userId,
    updated_at: now,
  };

  // Optimistic locking: if the client sends expected_updated_at, verify no one
  // else has saved since the client last read. This prevents silent overwrites
  // when multiple dispatchers edit the same day concurrently.
  if (expected_updated_at) {
    // Try conditional update — only succeeds if updated_at matches what client expects
    const { data: updated, error: updateErr } = await supa
      .from("van_draft_overrides")
      .update(payload)
      .eq("date", date)
      .eq("updated_at", expected_updated_at)
      .select("date");

    if (updateErr) return NextResponse.json({ error: updateErr.message }, { status: 500 });

    if (updated && updated.length > 0) {
      // Matched — update succeeded
      return NextResponse.json({ ok: true, updated_at: now });
    }

    // No rows matched — either row doesn't exist yet, or someone else saved
    const { data: existing } = await supa
      .from("van_draft_overrides")
      .select("updated_at")
      .eq("date", date)
      .maybeSingle();

    if (existing) {
      // Row exists but updated_at doesn't match — conflict
      return NextResponse.json(
        { error: "conflict", message: "Another dispatcher saved changes — reloading latest", updated_at: existing.updated_at },
        { status: 409 }
      );
    }
    // Row doesn't exist yet — fall through to upsert
  }

  // First save for this date, or client didn't send expected_updated_at (backwards compat)
  const { error } = await supa
    .from("van_draft_overrides")
    .upsert(payload, { onConflict: "date" });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true, updated_at: now });
}
