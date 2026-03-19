import { NextRequest, NextResponse } from "next/server";
import { requireAuth, requireAdmin, isAuthed, isRateLimited } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";

/** Standard MEL category deferral periods (calendar days) */
const CATEGORY_DAYS: Record<string, number> = { A: 0, B: 3, C: 10, D: 120 };

/**
 * GET /api/ops/mel-items — list open MEL items (optionally filter by tail)
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;

  const tail = req.nextUrl.searchParams.get("tail");
  const includeCleared = req.nextUrl.searchParams.get("include_cleared") === "true";

  const supa = createServiceClient();
  let q = supa
    .from("mel_items")
    .select("*")
    .order("expiration_date", { ascending: true, nullsFirst: false })
    .order("created_at", { ascending: false })
    .limit(500);

  if (tail) q = q.eq("tail_number", tail);
  if (!includeCleared) q = q.eq("status", "open");

  const { data, error } = await q;
  if (error) {
    console.error("[ops/mel-items] list error:", error);
    return NextResponse.json({ error: "Failed to list MEL items" }, { status: 500 });
  }

  return NextResponse.json({ items: data ?? [] });
}

/**
 * POST /api/ops/mel-items — create a new MEL item
 */
export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if ("error" in auth) return auth.error;

  if (await isRateLimited(auth.userId, 20)) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  let input: {
    tail_number?: string;
    category?: string;
    mel_reference?: string;
    description?: string;
    deferred_date?: string;
    expiration_date?: string;
  };
  try {
    input = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const tail_number = input.tail_number?.trim();
  const category = input.category?.trim().toUpperCase();
  const description = input.description?.trim();

  if (!tail_number) return NextResponse.json({ error: "tail_number is required" }, { status: 400 });
  if (!category || !["A", "B", "C", "D"].includes(category)) {
    return NextResponse.json({ error: "category must be A, B, C, or D" }, { status: 400 });
  }
  if (!description) return NextResponse.json({ error: "description is required" }, { status: 400 });

  // Compute expiration from deferral date + category if not explicitly provided
  const deferredDate = input.deferred_date || new Date().toISOString().slice(0, 10);
  let expirationDate = input.expiration_date || null;
  if (!expirationDate && CATEGORY_DAYS[category] > 0) {
    const d = new Date(deferredDate);
    d.setDate(d.getDate() + CATEGORY_DAYS[category]);
    expirationDate = d.toISOString().slice(0, 10);
  }

  const supa = createServiceClient();
  const { data: item, error } = await supa
    .from("mel_items")
    .insert({
      tail_number,
      category,
      mel_reference: input.mel_reference?.trim() || null,
      description,
      deferred_date: deferredDate,
      expiration_date: expirationDate,
      created_by: auth.userId,
    })
    .select("*")
    .single();

  if (error) {
    console.error("[ops/mel-items] insert error:", error);
    return NextResponse.json({ error: "Failed to create MEL item" }, { status: 500 });
  }

  return NextResponse.json({ item }, { status: 201 });
}
