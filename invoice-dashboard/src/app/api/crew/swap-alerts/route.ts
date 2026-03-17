import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, isAuthed } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";

export const dynamic = "force-dynamic";

/**
 * GET /api/crew/swap-alerts?swap_date=2026-03-18
 * Returns unacknowledged flight change alerts for the swap date.
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
    .from("swap_leg_alerts")
    .select("*")
    .eq("swap_date", swapDate)
    .order("detected_at", { ascending: false });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const unacknowledged = (data ?? []).filter((a) => !a.acknowledged);

  return NextResponse.json({
    alerts: data,
    unacknowledged_count: unacknowledged.length,
    total: data?.length ?? 0,
  });
}

/**
 * PATCH /api/crew/swap-alerts
 * Body: { id: "uuid" } — acknowledge an alert
 * Body: { swap_date: "2026-03-18", acknowledge_all: true } — acknowledge all for date
 */
export async function PATCH(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (!isAuthed(auth)) return auth.error;

  const body = await req.json();
  const supa = createServiceClient();
  const now = new Date().toISOString();

  if (body.acknowledge_all && body.swap_date) {
    const { error } = await supa
      .from("swap_leg_alerts")
      .update({
        acknowledged: true,
        acknowledged_by: auth.email,
        acknowledged_at: now,
      })
      .eq("swap_date", body.swap_date)
      .eq("acknowledged", false);

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  }

  if (body.id) {
    const { error } = await supa
      .from("swap_leg_alerts")
      .update({
        acknowledged: true,
        acknowledged_by: auth.email,
        acknowledged_at: now,
      })
      .eq("id", body.id);

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: "id or (swap_date + acknowledge_all) required" }, { status: 400 });
}
