import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthed, isRateLimited } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";

// ── GET: list all registry entries (joined with samsara_vehicles) ──────────

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;

  if (await isRateLimited(auth.userId)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  const supa = createServiceClient();
  const { data, error } = await supa
    .from("vehicle_registry")
    .select("*, samsara_vehicles(lat:last_seen_at, check_engine)")
    .order("name");

  if (error) {
    console.error("[vehicles/registry] GET error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, vehicles: data });
}

// ── PATCH: update type, role, zone, loadout, notes for a vehicle ───────────

export async function PATCH(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;

  if (await isRateLimited(auth.userId)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  const body = await req.json();
  const { samsara_id, vehicle_type, vehicle_role, zone_id, zone_name, loadout, notes } = body;

  if (!samsara_id) {
    return NextResponse.json({ error: "samsara_id required" }, { status: 400 });
  }

  const supa = createServiceClient();

  // If zone is changing, log the transfer
  if (zone_id !== undefined) {
    const { data: current } = await supa
      .from("vehicle_registry")
      .select("zone_id, zone_name, name")
      .eq("samsara_id", samsara_id)
      .single();

    if (current && current.zone_id !== zone_id) {
      await supa.from("vehicle_transfers").insert({
        samsara_id,
        vehicle_name: current.name,
        from_zone_id: current.zone_id,
        from_zone_name: current.zone_name,
        to_zone_id: zone_id,
        to_zone_name: zone_name ?? null,
        transferred_by: auth.userId,
        reason: body.transfer_reason ?? null,
      });
    }
  }

  // Build update payload — only include provided fields
  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (vehicle_type !== undefined) update.vehicle_type = vehicle_type;
  if (vehicle_role !== undefined) update.vehicle_role = vehicle_role;
  if (zone_id !== undefined) update.zone_id = zone_id;
  if (zone_name !== undefined) update.zone_name = zone_name;
  if (loadout !== undefined) update.loadout = loadout;
  if (notes !== undefined) update.notes = notes;

  const { data, error } = await supa
    .from("vehicle_registry")
    .update(update)
    .eq("samsara_id", samsara_id)
    .select()
    .single();

  if (error) {
    console.error("[vehicles/registry] PATCH error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, vehicle: data });
}
