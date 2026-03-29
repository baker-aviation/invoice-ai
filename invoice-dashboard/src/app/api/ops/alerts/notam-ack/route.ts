import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthed } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";

/**
 * Per-flight NOTAM acknowledgment for shared NOTAM alerts (flight_id IS NULL).
 * Stores in notam_flight_acks table instead of mutating the shared alert row.
 *
 * POST: { alert_id, flight_id } → ack
 * DELETE: { alert_id, flight_id } → un-ack
 * GET: ?flight_ids=id1,id2,... → returns all acks for those flights
 */

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;

  const { alert_id, flight_id } = await req.json();
  if (!alert_id || !flight_id) {
    return NextResponse.json({ error: "alert_id and flight_id required" }, { status: 400 });
  }

  const supa = createServiceClient();
  const { error } = await supa.from("notam_flight_acks").upsert(
    { alert_id, flight_id, user_id: auth.userId, acked_at: new Date().toISOString() },
    { onConflict: "alert_id,flight_id" },
  );

  if (error) {
    console.error("[notam-ack] Insert error:", error);
    return NextResponse.json({ error: "Database error" }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;

  const { alert_id, flight_id } = await req.json();
  if (!alert_id || !flight_id) {
    return NextResponse.json({ error: "alert_id and flight_id required" }, { status: 400 });
  }

  const supa = createServiceClient();
  const { error } = await supa
    .from("notam_flight_acks")
    .delete()
    .eq("alert_id", alert_id)
    .eq("flight_id", flight_id);

  if (error) {
    console.error("[notam-ack] Delete error:", error);
    return NextResponse.json({ error: "Database error" }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;

  const flightIds = req.nextUrl.searchParams.get("flight_ids")?.split(",").filter(Boolean) ?? [];
  if (flightIds.length === 0) {
    return NextResponse.json({ acks: [] });
  }

  const supa = createServiceClient();
  const { data, error } = await supa
    .from("notam_flight_acks")
    .select("alert_id, flight_id, user_id, acked_at")
    .in("flight_id", flightIds);

  if (error) {
    console.error("[notam-ack] Query error:", error);
    return NextResponse.json({ error: "Database error" }, { status: 500 });
  }
  return NextResponse.json({ acks: data ?? [] });
}
