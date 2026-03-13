import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, isAuthed } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";

export const dynamic = "force-dynamic";

/** GET /api/pilots/time-off — all time-off requests (admin) */
export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (!isAuthed(auth)) return auth.error;

  const supa = createServiceClient();
  const status = req.nextUrl.searchParams.get("status");

  let query = supa
    .from("pilot_time_off_requests")
    .select("*, pilot_profiles(full_name)")
    .order("created_at", { ascending: false });

  if (status) {
    query = query.eq("status", status);
  }

  const { data, error } = await query;
  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  const requests = (data ?? []).map((r: any) => ({
    ...r,
    pilot_name: r.pilot_profiles?.full_name ?? null,
    pilot_profiles: undefined,
  }));

  return NextResponse.json({ ok: true, count: requests.length, requests });
}
