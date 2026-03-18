import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthed } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";

export const dynamic = "force-dynamic";

/**
 * GET /api/ops/remarks
 * Returns the latest remark per flight_id for all flights in the window.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;

  const supa = createServiceClient();
  const { data, error } = await supa
    .from("flight_remarks")
    .select("id, flight_id, remark, created_by, updated_at")
    .order("updated_at", { ascending: false })
    .limit(5000);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Dedupe: keep only latest per flight_id
  const latest = new Map<string, (typeof data)[number]>();
  for (const r of data ?? []) {
    if (!latest.has(r.flight_id)) latest.set(r.flight_id, r);
  }

  return NextResponse.json({ remarks: Object.fromEntries(latest) });
}

/**
 * POST /api/ops/remarks
 * Upsert a remark for a flight leg.
 * Body: { flight_id: string, remark: string }
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;

  let body: { flight_id?: string; remark?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { flight_id, remark } = body;
  if (!flight_id || typeof flight_id !== "string") {
    return NextResponse.json({ error: "Missing flight_id" }, { status: 400 });
  }
  if (typeof remark !== "string" || remark.length > 500) {
    return NextResponse.json({ error: "Remark must be ≤500 chars" }, { status: 400 });
  }

  const supa = createServiceClient();
  const now = new Date().toISOString();

  if (remark.trim() === "") {
    // Empty remark = delete
    const { error } = await supa
      .from("flight_remarks")
      .delete()
      .eq("flight_id", flight_id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true, deleted: true });
  }

  // Check if one already exists for this flight
  const { data: existing } = await supa
    .from("flight_remarks")
    .select("id")
    .eq("flight_id", flight_id)
    .order("updated_at", { ascending: false })
    .limit(1);

  if (existing && existing.length > 0) {
    const { error } = await supa
      .from("flight_remarks")
      .update({ remark: remark.trim(), created_by: auth.email, updated_at: now })
      .eq("id", existing[0].id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  } else {
    const { error } = await supa
      .from("flight_remarks")
      .insert({ flight_id, remark: remark.trim(), created_by: auth.email, updated_at: now });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
