import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, isAuthed } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";

export const dynamic = "force-dynamic";

/** POST /api/pilots/time-off — admin creates a time-off request on behalf of a pilot */
export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (!isAuthed(auth)) return auth.error;

  let body: { pilot_profile_id?: number; request_type?: string; start_date?: string; end_date?: string; reason?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON" }, { status: 400 });
  }

  const { pilot_profile_id, request_type, start_date, end_date, reason } = body;

  if (!pilot_profile_id || !request_type || !start_date || !end_date) {
    return NextResponse.json(
      { ok: false, error: "pilot_profile_id, request_type, start_date, and end_date are required" },
      { status: 400 },
    );
  }

  if (!["time_off", "standby"].includes(request_type)) {
    return NextResponse.json({ ok: false, error: "request_type must be time_off or standby" }, { status: 400 });
  }

  const supa = createServiceClient();
  const { data, error } = await supa
    .from("pilot_time_off_requests")
    .insert({
      pilot_profile_id,
      request_type,
      start_date,
      end_date,
      reason: reason ?? null,
      status: "pending",
    })
    .select()
    .single();

  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, request: data }, { status: 201 });
}

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
