import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import { requireSuperAdmin, isRateLimited, isAuthed } from "@/lib/api-auth";

const TABLE = "aircraft_tracker";

function getServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Missing Supabase config");
  return createClient(url, key);
}

// ── GET: list all aircraft ──────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  const auth = await requireSuperAdmin(req);
  if (!isAuthed(auth)) return auth.error;

  const sb = getServiceClient();
  const { data, error } = await sb
    .from(TABLE)
    .select("*")
    .order("tail_number", { ascending: true });

  if (error) {
    return NextResponse.json({ error: "Database operation failed" }, { status: 500 });
  }
  return NextResponse.json({ aircraft: data });
}

// ── POST: create a new aircraft row ─────────────────────────────────────────

const CreateSchema = z.object({
  tail_number: z.string().min(1).max(20),
  aircraft_type: z.string().max(50).optional().nullable(),
  overall_status: z.string().max(50).optional().nullable(),
});

export async function POST(req: NextRequest) {
  const auth = await requireSuperAdmin(req);
  if (!isAuthed(auth)) return auth.error;
  if (await isRateLimited(auth.userId, 20)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = CreateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", details: parsed.error.issues },
      { status: 400 },
    );
  }

  const sb = getServiceClient();
  const { data, error } = await sb
    .from(TABLE)
    .insert(parsed.data)
    .select()
    .single();

  if (error) {
    if (error.code === "23505") {
      return NextResponse.json({ error: "Tail number already exists" }, { status: 409 });
    }
    return NextResponse.json({ error: "Database operation failed" }, { status: 500 });
  }
  return NextResponse.json({ aircraft: data }, { status: 201 });
}

// ── PUT: update an existing aircraft row ────────────────────────────────────

const UpdateSchema = z.object({
  id: z.string().uuid(),
  tail_number: z.string().min(1).max(20).optional(),
  aircraft_type: z.string().max(50).optional().nullable(),
  part_135_flying: z.string().optional().nullable(),
  wb_date: z.string().optional().nullable(),
  wb_on_jet_insight: z.string().optional().nullable(),
  foreflight_wb_built: z.string().optional().nullable(),
  starlink_on_wb: z.string().optional().nullable(),
  initial_foreflight_build: z.string().optional().nullable(),
  foreflight_subscription: z.string().optional().nullable(),
  foreflight_config_built: z.string().optional().nullable(),
  validation_complete: z.string().optional().nullable(),
  beta_tested: z.string().optional().nullable(),
  go_live_approved: z.string().optional().nullable(),
  genesis_removed: z.string().optional().nullable(),
  overall_status: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
  kow_callsign: z.string().optional().nullable(),
  jet_insight_url: z.string().optional().nullable(),
  location_override: z.string().max(10).optional().nullable(),
});

export async function PUT(req: NextRequest) {
  const auth = await requireSuperAdmin(req);
  if (!isAuthed(auth)) return auth.error;
  if (await isRateLimited(auth.userId, 30)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = UpdateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", details: parsed.error.issues },
      { status: 400 },
    );
  }

  const { id, ...updates } = parsed.data;
  const sb = getServiceClient();
  const { data, error } = await sb
    .from(TABLE)
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq("id", id)
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: "Database operation failed" }, { status: 500 });
  }
  return NextResponse.json({ aircraft: data });
}

// ── DELETE: remove an aircraft row ──────────────────────────────────────────

const DeleteSchema = z.object({
  id: z.string().uuid(),
});

export async function DELETE(req: NextRequest) {
  const auth = await requireSuperAdmin(req);
  if (!isAuthed(auth)) return auth.error;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = DeleteSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", details: parsed.error.issues },
      { status: 400 },
    );
  }

  const sb = getServiceClient();
  const { error } = await sb.from(TABLE).delete().eq("id", parsed.data.id);

  if (error) {
    return NextResponse.json({ error: "Database operation failed" }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
