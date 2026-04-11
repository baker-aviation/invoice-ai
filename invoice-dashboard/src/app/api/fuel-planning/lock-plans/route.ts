import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthed } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";

export const dynamic = "force-dynamic";

/**
 * POST /api/fuel-planning/lock-plans
 *
 * Locks fuel plan links for the given date. Stores a snapshot of each
 * plan's legs so later JI schedule changes can be detected and flagged.
 *
 * Body: { date: "YYYY-MM-DD" }
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;

  const body = await req.json().catch(() => ({}));
  const date = (body.date as string) || "";
  if (!date) return NextResponse.json({ error: "date required" }, { status: 400 });

  const supa = createServiceClient();
  const { data: links, error } = await supa
    .from("fuel_plan_links")
    .select("id, plan_data")
    .eq("date", date)
    .is("locked_at", null);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const now = new Date().toISOString();
  let locked = 0;
  for (const link of links ?? []) {
    const legs = (link.plan_data as { legs?: unknown[] })?.legs ?? [];
    const { error: updateErr } = await supa
      .from("fuel_plan_links")
      .update({ locked_at: now, locked_legs: legs })
      .eq("id", link.id);
    if (!updateErr) locked++;
  }

  return NextResponse.json({ ok: true, locked, total: links?.length ?? 0 });
}
