import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthed } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";

export const dynamic = "force-dynamic";

/** GET /api/pilot/time-off — own time-off requests (pilot portal) */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;

  const supa = createServiceClient();

  // Find pilot profile for the logged-in user
  const { data: profile } = await supa
    .from("pilot_profiles")
    .select("id")
    .eq("user_id", auth.userId)
    .single();

  if (!profile) {
    return NextResponse.json({ ok: true, count: 0, requests: [] });
  }

  const { data, error } = await supa
    .from("pilot_time_off_requests")
    .select("*")
    .eq("pilot_profile_id", profile.id)
    .order("created_at", { ascending: false });

  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, count: (data ?? []).length, requests: data ?? [] });
}

/** POST /api/pilot/time-off — submit a time-off request (pilot portal) */
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;

  const supa = createServiceClient();

  // Find pilot profile for the logged-in user
  const { data: profile } = await supa
    .from("pilot_profiles")
    .select("id")
    .eq("user_id", auth.userId)
    .single();

  if (!profile) {
    return NextResponse.json(
      { ok: false, error: "No pilot profile found for this user" },
      { status: 404 },
    );
  }

  const body = await req.json();
  const { request_type, start_date, end_date, reason } = body;

  if (!request_type || !start_date || !end_date) {
    return NextResponse.json(
      { ok: false, error: "request_type, start_date, and end_date are required" },
      { status: 400 },
    );
  }

  if (!["time_off", "standby"].includes(request_type)) {
    return NextResponse.json(
      { ok: false, error: "request_type must be 'time_off' or 'standby'" },
      { status: 400 },
    );
  }

  const { data, error } = await supa
    .from("pilot_time_off_requests")
    .insert({
      pilot_profile_id: profile.id,
      request_type,
      start_date,
      end_date,
      reason: reason ?? null,
    })
    .select()
    .single();

  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, request: data }, { status: 201 });
}
