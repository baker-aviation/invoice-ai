import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, isRateLimited } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";

type RouteCtx = { params: Promise<{ id: string }> };

/**
 * PATCH /api/ops/mel-items/[id] — update or clear a MEL item
 */
export async function PATCH(req: NextRequest, { params }: RouteCtx) {
  const auth = await requireAdmin(req);
  if ("error" in auth) return auth.error;

  if (await isRateLimited(auth.userId, 20)) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const { id } = await params;

  let input: {
    category?: string;
    mel_reference?: string;
    description?: string;
    expiration_date?: string;
    status?: string;
  };
  try {
    input = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (input.category !== undefined) {
    const cat = input.category.trim().toUpperCase();
    if (!["A", "B", "C", "D"].includes(cat)) {
      return NextResponse.json({ error: "category must be A, B, C, or D" }, { status: 400 });
    }
    updates.category = cat;
  }
  if (input.mel_reference !== undefined) updates.mel_reference = input.mel_reference.trim() || null;
  if (input.description !== undefined) updates.description = input.description.trim();
  if (input.expiration_date !== undefined) updates.expiration_date = input.expiration_date || null;
  if (input.status === "cleared") {
    updates.status = "cleared";
    updates.cleared_by = auth.userId;
    updates.cleared_at = new Date().toISOString();
  } else if (input.status === "open") {
    updates.status = "open";
    updates.cleared_by = null;
    updates.cleared_at = null;
  }

  const supa = createServiceClient();
  const { data: item, error } = await supa
    .from("mel_items")
    .update(updates)
    .eq("id", Number(id))
    .select("*")
    .single();

  if (error) {
    console.error("[ops/mel-items] update error:", error);
    return NextResponse.json({ error: "Failed to update MEL item" }, { status: 500 });
  }

  return NextResponse.json({ item });
}

/**
 * DELETE /api/ops/mel-items/[id] — permanently delete a MEL item
 */
export async function DELETE(req: NextRequest, { params }: RouteCtx) {
  const auth = await requireAdmin(req);
  if ("error" in auth) return auth.error;

  if (await isRateLimited(auth.userId, 20)) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const { id } = await params;

  const supa = createServiceClient();
  const { error } = await supa.from("mel_items").delete().eq("id", Number(id));

  if (error) {
    console.error("[ops/mel-items] delete error:", error);
    return NextResponse.json({ error: "Failed to delete MEL item" }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
