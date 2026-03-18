import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, isRateLimited } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";

type RouteCtx = { params: Promise<{ id: string }> };

/**
 * PATCH /api/ops/mx-notes/[id] — update subject/body
 */
export async function PATCH(req: NextRequest, { params }: RouteCtx) {
  const auth = await requireAdmin(req);
  if ("error" in auth) return auth.error;

  if (isRateLimited(auth.userId, 20)) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const { id } = await params;

  let input: { subject?: string; body?: string };
  try {
    input = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const updates: Record<string, string | null> = {};
  if (input.subject !== undefined) updates.subject = input.subject.trim() || null;
  if (input.body !== undefined) updates.body = input.body.trim() || null;

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
  }

  const supa = createServiceClient();
  const { data: note, error } = await supa
    .from("ops_alerts")
    .update(updates)
    .eq("id", id)
    .eq("alert_type", "MX_NOTE")
    .select("id, tail_number, airport_icao, subject, body, created_at, acknowledged_at")
    .single();

  if (error) {
    console.error("[ops/mx-notes] update error:", error);
    return NextResponse.json({ error: "Failed to update MX note" }, { status: 500 });
  }

  return NextResponse.json({ note });
}

/**
 * DELETE /api/ops/mx-notes/[id] — acknowledge (soft delete)
 */
export async function DELETE(req: NextRequest, { params }: RouteCtx) {
  const auth = await requireAdmin(req);
  if ("error" in auth) return auth.error;

  if (isRateLimited(auth.userId, 20)) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const { id } = await params;

  const supa = createServiceClient();
  const { error } = await supa
    .from("ops_alerts")
    .update({ acknowledged_at: new Date().toISOString(), acknowledged_by: auth.userId })
    .eq("id", id)
    .eq("alert_type", "MX_NOTE");

  if (error) {
    console.error("[ops/mx-notes] acknowledge error:", error);
    return NextResponse.json({ error: "Failed to acknowledge MX note" }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
