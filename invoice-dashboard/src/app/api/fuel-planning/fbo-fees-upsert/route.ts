import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthed, isRateLimited } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";

export const dynamic = "force-dynamic";

/**
 * POST /api/fuel-planning/fbo-fees-upsert
 *
 * Crowd-sourced FBO fee gap-fill. Writes to fbo_direct_fees (highest
 * precedence in the three-source merge). Tagged with confidence="manual"
 * and raw_response="user:<userId>" for audit.
 *
 * Body: {
 *   airport: string,
 *   fbo_name: string,
 *   aircraft_type: string,
 *   facility_fee?: number | null,
 *   gallons_to_waive?: number | null,
 *   landing_fee?: number | null,
 *   security_fee?: number | null,
 *   overnight_fee?: number | null,
 * }
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;
  if (await isRateLimited(auth.userId, 30)) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const body = await req.json().catch(() => ({}));
  const airport = (body.airport ?? "").toUpperCase().trim();
  const fbo_name = String(body.fbo_name ?? "").trim();
  const aircraft_type = String(body.aircraft_type ?? "").trim();

  if (!airport || !fbo_name || !aircraft_type) {
    return NextResponse.json(
      { error: "airport, fbo_name, and aircraft_type required" },
      { status: 400 },
    );
  }

  const normalizedAirport = airport.length === 4 && airport.startsWith("K") ? airport.slice(1) : airport;

  const row: Record<string, unknown> = {
    airport_code: normalizedAirport,
    fbo_name,
    aircraft_type,
    source_email: `user:${auth.userId}`,
    source_date: new Date().toISOString().slice(0, 10),
    raw_response: "Entered via Aircraft Fuel Plans gap-fill",
    confidence: "manual",
    updated_at: new Date().toISOString(),
  };

  for (const field of ["facility_fee", "gallons_to_waive", "landing_fee", "security_fee", "overnight_fee"]) {
    if (body[field] !== undefined && body[field] !== null && body[field] !== "") {
      const n = Number(body[field]);
      if (Number.isFinite(n)) row[field] = n;
    }
  }

  const supa = createServiceClient();
  const { error } = await supa
    .from("fbo_direct_fees")
    .upsert(row, { onConflict: "airport_code,fbo_name,aircraft_type" });

  if (error) {
    console.error("[fbo-fees-upsert] error:", error.message);
    return NextResponse.json({ error: "Failed to save" }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
