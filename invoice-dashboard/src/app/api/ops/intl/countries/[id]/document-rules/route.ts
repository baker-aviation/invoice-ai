import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthed, isRateLimited } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";

type Ctx = { params: Promise<{ id: string }> };

const VALID_CATEGORIES = ["trip", "crew", "aircraft", "company"];
const VALID_MATCH_TYPES = ["exact_name", "name_contains", "all"];
const VALID_APPLIES_TO = ["landing", "overflight", "both"];

export async function GET(req: NextRequest, ctx: Ctx) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;

  const { id } = await ctx.params;
  const supa = createServiceClient();
  const { data, error } = await supa
    .from("country_document_rules")
    .select("*")
    .eq("country_id", id)
    .eq("is_active", true)
    .order("sort_order");

  if (error) {
    return NextResponse.json({ error: "Failed to list document rules" }, { status: 500 });
  }
  return NextResponse.json({ rules: data ?? [] });
}

export async function POST(req: NextRequest, ctx: Ctx) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;
  if (await isRateLimited(auth.userId, 20)) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const { id } = await ctx.params;
  let input: Record<string, unknown>;
  try { input = await req.json(); } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const doc_category = input.doc_category as string;
  const match_type = input.match_type as string;
  const match_value = (input.match_value as string)?.trim() || null;

  if (!doc_category || !VALID_CATEGORIES.includes(doc_category)) {
    return NextResponse.json({ error: "doc_category must be trip, crew, aircraft, or company" }, { status: 400 });
  }
  if (!match_type || !VALID_MATCH_TYPES.includes(match_type)) {
    return NextResponse.json({ error: "match_type must be exact_name, name_contains, or all" }, { status: 400 });
  }
  if (match_type !== "all" && !match_value) {
    return NextResponse.json({ error: "match_value required for non-'all' match types" }, { status: 400 });
  }

  const applies_to = (input.applies_to as string) || "landing";
  if (!VALID_APPLIES_TO.includes(applies_to)) {
    return NextResponse.json({ error: "applies_to must be landing, overflight, or both" }, { status: 400 });
  }

  const supa = createServiceClient();
  const { data, error } = await supa
    .from("country_document_rules")
    .insert({
      country_id: id,
      doc_category,
      match_type,
      match_value,
      is_required: input.is_required ?? true,
      applies_to,
      notes: input.notes ?? null,
      sort_order: input.sort_order ?? 0,
    })
    .select("*")
    .single();

  if (error) {
    return NextResponse.json({ error: "Failed to create rule" }, { status: 500 });
  }
  return NextResponse.json({ rule: data }, { status: 201 });
}

export async function PATCH(req: NextRequest, ctx: Ctx) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;

  const { id: countryId } = await ctx.params;
  let input: Record<string, unknown>;
  try { input = await req.json(); } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const ruleId = input.rule_id as string;
  if (!ruleId) return NextResponse.json({ error: "rule_id required" }, { status: 400 });

  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (input.doc_category && VALID_CATEGORIES.includes(input.doc_category as string)) updates.doc_category = input.doc_category;
  if (input.match_type && VALID_MATCH_TYPES.includes(input.match_type as string)) updates.match_type = input.match_type;
  if (input.match_value !== undefined) updates.match_value = (input.match_value as string)?.trim() || null;
  if (input.is_required !== undefined) updates.is_required = input.is_required;
  if (input.applies_to && VALID_APPLIES_TO.includes(input.applies_to as string)) updates.applies_to = input.applies_to;
  if (input.notes !== undefined) updates.notes = input.notes;
  if (input.is_active !== undefined) updates.is_active = input.is_active;

  const supa = createServiceClient();
  const { data, error } = await supa
    .from("country_document_rules")
    .update(updates)
    .eq("id", ruleId)
    .eq("country_id", countryId)
    .select("*")
    .single();

  if (error) {
    return NextResponse.json({ error: "Failed to update rule" }, { status: 500 });
  }
  return NextResponse.json({ rule: data });
}

export async function DELETE(req: NextRequest, ctx: Ctx) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;

  const { id: countryId } = await ctx.params;
  const ruleId = req.nextUrl.searchParams.get("rule_id");
  if (!ruleId) return NextResponse.json({ error: "rule_id required" }, { status: 400 });

  const supa = createServiceClient();
  await supa.from("country_document_rules").delete().eq("id", ruleId).eq("country_id", countryId);
  return NextResponse.json({ ok: true });
}
