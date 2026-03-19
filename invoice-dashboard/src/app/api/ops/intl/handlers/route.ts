import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthed, isRateLimited } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;

  const flightId = req.nextUrl.searchParams.get("flight_id");
  const supa = createServiceClient();
  let q = supa.from("intl_leg_handlers").select("*").order("created_at");
  if (flightId) q = q.eq("flight_id", flightId);

  const { data, error } = await q;
  if (error) {
    console.error("[intl/handlers] list error:", error);
    return NextResponse.json({ error: "Failed to list handlers" }, { status: 500 });
  }
  return NextResponse.json({ handlers: data ?? [] });
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
  const handler_name = (input.handler_name as string)?.trim();
  const airport_icao = (input.airport_icao as string)?.trim().toUpperCase();
  if (!flight_id || !handler_name || !airport_icao) {
    return NextResponse.json({ error: "flight_id, handler_name, airport_icao required" }, { status: 400 });
  }

  const supa = createServiceClient();
  const { data, error } = await supa
    .from("intl_leg_handlers")
    .insert({
      flight_id,
      handler_name,
      handler_contact: input.handler_contact ?? null,
      airport_icao,
      notes: input.notes ?? null,
      created_by: auth.userId,
    })
    .select("*")
    .single();

  if (error) {
    console.error("[intl/handlers] insert error:", error);
    return NextResponse.json({ error: "Failed to create handler" }, { status: 500 });
  }
  return NextResponse.json({ handler: data }, { status: 201 });
}
