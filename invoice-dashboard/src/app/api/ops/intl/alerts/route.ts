import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthed } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;

  const unackedOnly = req.nextUrl.searchParams.get("all") !== "true";
  const flightId = req.nextUrl.searchParams.get("flight_id");

  const supa = createServiceClient();
  let q = supa
    .from("intl_leg_alerts")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(200);

  if (unackedOnly) q = q.eq("acknowledged", false);
  if (flightId) q = q.eq("flight_id", flightId);

  const { data, error } = await q;
  if (error) {
    console.error("[intl/alerts] list error:", error);
    return NextResponse.json({ error: "Failed to list alerts" }, { status: 500 });
  }
  return NextResponse.json({ alerts: data ?? [] });
}
