import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthed } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";

export const dynamic = "force-dynamic";

/**
 * GET /api/fuel-planning/plan-links-by-date?date=YYYY-MM-DD
 *
 * Returns the current fuel_plan_links rows for the given date as a
 * { [tail]: token } map plus { [tail]: plan_data }. Used by the
 * Aircraft Fuel Plans tab to rehydrate token state after a page
 * refresh instead of forcing a regenerate.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;

  const date = req.nextUrl.searchParams.get("date");
  if (!date) {
    return NextResponse.json({ error: "date query param required" }, { status: 400 });
  }

  const supa = createServiceClient();
  const nowIso = new Date().toISOString();
  const { data, error } = await supa
    .from("fuel_plan_links")
    .select("tail_number, token, plan_data, locked_at, expires_at")
    .eq("date", date)
    .gt("expires_at", nowIso);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const tokens: Record<string, string> = {};
  const plans: Record<string, unknown> = {};
  const locked: Record<string, string> = {};
  for (const row of data ?? []) {
    if (!row.tail_number) continue;
    tokens[row.tail_number] = row.token;
    plans[row.tail_number] = row.plan_data;
    if (row.locked_at) locked[row.tail_number] = row.locked_at;
  }

  return NextResponse.json({ tokens, plans, locked, count: Object.keys(tokens).length });
}
