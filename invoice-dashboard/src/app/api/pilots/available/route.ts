import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthed } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";

export const dynamic = "force-dynamic";

/**
 * GET /api/pilots/available — returns pilots who are:
 *   1. available_to_fly = true (onboarding complete)
 *   2. On an active rotation for the given date range
 *   3. NOT on approved time off for the given date range
 *
 * Query params: start_date, end_date (YYYY-MM-DD)
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;

  const sp = req.nextUrl.searchParams;
  const startDate = sp.get("start_date");
  const endDate = sp.get("end_date");

  if (!startDate || !endDate) {
    return NextResponse.json(
      { ok: false, error: "start_date and end_date query params are required" },
      { status: 400 },
    );
  }

  const supa = createServiceClient();

  // Get all available pilots
  const { data: pilots, error: pilotErr } = await supa
    .from("pilot_profiles")
    .select("*")
    .eq("available_to_fly", true);

  if (pilotErr) {
    return NextResponse.json({ ok: false, error: pilotErr.message }, { status: 500 });
  }

  if (!pilots || pilots.length === 0) {
    return NextResponse.json({ ok: true, count: 0, pilots: [] });
  }

  // Get crew member IDs that have rotations overlapping the date range
  const crewMemberIds = pilots
    .map((p: any) => p.crew_member_id)
    .filter(Boolean);

  let onRotation = new Set<number>();
  if (crewMemberIds.length > 0) {
    const { data: rotations } = await supa
      .from("crew_rotations")
      .select("crew_member_id")
      .in("crew_member_id", crewMemberIds)
      .lte("rotation_start", endDate)
      .or(`rotation_end.gte.${startDate},rotation_end.is.null`);

    onRotation = new Set((rotations ?? []).map((r: any) => r.crew_member_id));
  }

  // Get pilot profile IDs with approved time off overlapping the date range
  const pilotIds = pilots.map((p: any) => p.id);
  const { data: timeOff } = await supa
    .from("pilot_time_off_requests")
    .select("pilot_profile_id")
    .in("pilot_profile_id", pilotIds)
    .eq("status", "approved")
    .lte("start_date", endDate)
    .gte("end_date", startDate);

  const onTimeOff = new Set((timeOff ?? []).map((t: any) => t.pilot_profile_id));

  // Filter: on rotation AND not on time off
  const available = pilots.filter((p: any) => {
    if (onTimeOff.has(p.id)) return false;
    // If they have a crew_member_id, they must be on rotation
    if (p.crew_member_id) return onRotation.has(p.crew_member_id);
    // If no crew_member link, include them if available
    return true;
  });

  return NextResponse.json({ ok: true, count: available.length, pilots: available });
}
