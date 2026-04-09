import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, isRateLimited } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";

type RouteCtx = { params: Promise<{ id: string }> };

/**
 * PATCH /api/ops/mx-notes/[id] — update fields including complete/parts_tools
 */
export async function PATCH(req: NextRequest, { params }: RouteCtx) {
  const auth = await requireAdmin(req);
  if ("error" in auth) return auth.error;

  if (await isRateLimited(auth.userId, 20)) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const { id } = await params;

  let input: {
    subject?: string;
    body?: string;
    tail_number?: string;
    airport_icao?: string;
    scheduled_date?: string | null;
    assigned_van?: number | null;
    action?: "complete" | "uncomplete";
    parts_tools_needed?: boolean;
  };
  try {
    input = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const updates: Record<string, unknown> = {};
  if (input.subject !== undefined) updates.subject = input.subject.trim() || null;
  if (input.body !== undefined) updates.body = input.body.trim() || null;
  if (input.tail_number !== undefined) updates.tail_number = input.tail_number.trim() || null;
  if (input.airport_icao !== undefined) updates.airport_icao = input.airport_icao.trim().toUpperCase() || null;
  if (input.scheduled_date !== undefined) updates.scheduled_date = input.scheduled_date || null;
  if (input.assigned_van !== undefined) updates.assigned_van = input.assigned_van;
  if (input.parts_tools_needed !== undefined) updates.parts_tools_needed = input.parts_tools_needed;

  // Complete / uncomplete actions
  if (input.action === "complete") {
    updates.completed_at = new Date().toISOString();
    updates.completed_by = auth.userId;
  } else if (input.action === "uncomplete") {
    updates.completed_at = null;
    updates.completed_by = null;
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
  }

  const supa = createServiceClient();
  const { data: note, error } = await supa
    .from("ops_alerts")
    .update(updates)
    .eq("id", id)
    .eq("alert_type", "MX_NOTE")
    .select("id, tail_number, airport_icao, subject, body, created_at, acknowledged_at, completed_at, completed_by, parts_tools_needed, scheduled_date, assigned_van")
    .single();

  if (error) {
    console.error("[ops/mx-notes] update error:", error);
    return NextResponse.json({ error: "Failed to update MX note" }, { status: 500 });
  }

  return NextResponse.json({ note });
}

/**
 * DELETE /api/ops/mx-notes/[id] — hard delete the MX note
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
    .from("ops_alerts")
    .delete()
    .eq("id", id)
    .eq("alert_type", "MX_NOTE");

  if (error) {
    console.error("[ops/mx-notes] delete error:", error);
    return NextResponse.json({ error: "Failed to delete MX note" }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
