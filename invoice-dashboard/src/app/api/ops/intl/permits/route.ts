import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthed, isRateLimited } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;

  const flightId = req.nextUrl.searchParams.get("flight_id");
  const status = req.nextUrl.searchParams.get("status");

  const supa = createServiceClient();
  let q = supa
    .from("intl_leg_permits")
    .select("*, country:countries(*)")
    .order("deadline", { ascending: true, nullsFirst: false });

  if (flightId) q = q.eq("flight_id", flightId);
  if (status) q = q.eq("status", status);

  const { data, error } = await q;
  if (error) {
    console.error("[intl/permits] list error:", error);
    return NextResponse.json({ error: "Failed to list permits" }, { status: 500 });
  }
  return NextResponse.json({ permits: data ?? [] });
}

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;
  if (await isRateLimited(auth.userId, 20)) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  let input: Record<string, unknown>;
  try { input = await req.json(); } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const flight_id = input.flight_id as string;
  const country_id = input.country_id as string;
  const permit_type = input.permit_type as string;
  if (!flight_id || !country_id || !permit_type) {
    return NextResponse.json({ error: "flight_id, country_id, permit_type required" }, { status: 400 });
  }
  if (!["overflight", "landing"].includes(permit_type)) {
    return NextResponse.json({ error: "permit_type must be overflight or landing" }, { status: 400 });
  }

  const supa = createServiceClient();
  const { data, error } = await supa
    .from("intl_leg_permits")
    .insert({
      flight_id,
      country_id,
      permit_type,
      status: input.status ?? "not_started",
      deadline: input.deadline ?? null,
      notes: input.notes ?? null,
      created_by: auth.userId,
    })
    .select("*, country:countries(*)")
    .single();

  if (error) {
    console.error("[intl/permits] insert error:", error);
    return NextResponse.json({ error: "Failed to create permit" }, { status: 500 });
  }
  return NextResponse.json({ permit: data }, { status: 201 });
}
