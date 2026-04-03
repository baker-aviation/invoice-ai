import { NextRequest, NextResponse } from "next/server";
import { requireAuth, requireAdmin, isAuthed, isRateLimited } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";

type RouteCtx = { params: Promise<{ id: string }> };

/**
 * GET /api/ops/mx-events/[id] — single event by ID
 */
export async function GET(req: NextRequest, { params }: RouteCtx) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;

  const { id } = await params;

  const supa = createServiceClient();
  const { data: event, error } = await supa
    .from("mx_events")
    .select("*")
    .eq("id", id)
    .single();

  if (error) {
    console.error("[ops/mx-events] get error:", error);
    const status = error.code === "PGRST116" ? 404 : 500;
    const message = status === 404 ? "MX event not found" : "Failed to fetch MX event";
    return NextResponse.json({ error: message }, { status });
  }

  return NextResponse.json({ event });
}

/**
 * PATCH /api/ops/mx-events/[id] — update an event
 */
export async function PATCH(req: NextRequest, { params }: RouteCtx) {
  const auth = await requireAdmin(req);
  if ("error" in auth) return auth.error;

  if (await isRateLimited(auth.userId, 20)) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const { id } = await params;

  let input: Record<string, unknown>;
  try {
    input = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const updates: Record<string, unknown> = {};

  // String fields — trim if provided
  const stringFields = [
    "title", "description", "tail_number", "airport_icao", "category",
    "priority", "status", "work_order_ref", "assigned_to", "completed_by",
  ] as const;
  for (const field of stringFields) {
    if (input[field] !== undefined) {
      const val = typeof input[field] === "string" ? (input[field] as string).trim() : null;
      updates[field] = field === "airport_icao" && val ? val.toUpperCase() : val || null;
    }
  }

  // Date/time fields
  const dateFields = [
    "scheduled_date", "scheduled_end", "start_time", "end_time", "completed_at",
  ] as const;
  for (const field of dateFields) {
    if (input[field] !== undefined) updates[field] = input[field] || null;
  }

  // Numeric fields
  if (input.estimated_hours !== undefined) updates.estimated_hours = input.estimated_hours ?? null;
  if (input.assigned_van !== undefined) updates.assigned_van = input.assigned_van ?? null;

  // Auto-set completed_at when status transitions to completed
  if (updates.status === "completed" && !updates.completed_at) {
    updates.completed_at = new Date().toISOString();
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
  }

  const supa = createServiceClient();
  const { data: event, error } = await supa
    .from("mx_events")
    .update(updates)
    .eq("id", id)
    .select("*")
    .single();

  if (error) {
    console.error("[ops/mx-events] update error:", error);
    const status = error.code === "PGRST116" ? 404 : 500;
    const message = status === 404 ? "MX event not found" : "Failed to update MX event";
    return NextResponse.json({ error: message }, { status });
  }

  return NextResponse.json({ event });
}

/**
 * DELETE /api/ops/mx-events/[id] — soft delete (set status = 'cancelled')
 */
export async function DELETE(req: NextRequest, { params }: RouteCtx) {
  const auth = await requireAdmin(req);
  if ("error" in auth) return auth.error;

  if (await isRateLimited(auth.userId, 20)) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const { id } = await params;

  const supa = createServiceClient();
  const { error } = await supa
    .from("mx_events")
    .update({ status: "cancelled" })
    .eq("id", id);

  if (error) {
    console.error("[ops/mx-events] soft-delete error:", error);
    return NextResponse.json({ error: "Failed to cancel MX event" }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
