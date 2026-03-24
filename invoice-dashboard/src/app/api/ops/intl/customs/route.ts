import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthed, isRateLimited } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;

  const icao = req.nextUrl.searchParams.get("icao");
  const difficulty = req.nextUrl.searchParams.get("difficulty");

  const supa = createServiceClient();
  let q = supa.from("us_customs_airports").select("*").order("icao");
  if (icao) q = q.eq("icao", icao);
  if (difficulty) q = q.eq("difficulty", difficulty);

  const { data, error } = await q;
  if (error) {
    console.error("[intl/customs] list error:", error);
    return NextResponse.json({ error: "Failed to list customs airports" }, { status: 500 });
  }
  return NextResponse.json({ airports: data ?? [] });
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

  const icao = (input.icao as string)?.trim().toUpperCase();
  const airport_name = (input.airport_name as string)?.trim();
  const customs_type = input.customs_type as string;
  if (!icao || !airport_name || !customs_type) {
    return NextResponse.json({ error: "icao, airport_name, customs_type required" }, { status: 400 });
  }
  if (!["AOE", "LRA", "UserFee", "None"].includes(customs_type)) {
    return NextResponse.json({ error: "customs_type must be AOE, LRA, UserFee, or None" }, { status: 400 });
  }

  const supa = createServiceClient();
  const { data, error } = await supa
    .from("us_customs_airports")
    .insert({
      icao,
      airport_name,
      customs_type,
      hours_open: input.hours_open ?? null,
      hours_close: input.hours_close ?? null,
      timezone: input.timezone ?? null,
      advance_notice_hours: input.advance_notice_hours ?? null,
      overtime_available: input.overtime_available ?? false,
      restrictions: input.restrictions ?? null,
      notes: input.notes ?? null,
      difficulty: input.difficulty ?? null,
      created_by: auth.userId,
    })
    .select("*")
    .single();

  if (error) {
    console.error("[intl/customs] insert error:", error);
    return NextResponse.json({ error: "Failed to create customs airport" }, { status: 500 });
  }
  return NextResponse.json({ airport: data }, { status: 201 });
}
