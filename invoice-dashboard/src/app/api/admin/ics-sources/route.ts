import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import { requireAdmin, isRateLimited, isAuthed } from "@/lib/api-auth";

const TABLE = "ics_sources";

function getServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Missing Supabase config");
  return createClient(url, key);
}

// ── GET: list all ICS sources ───────────────────────────────────────────────

export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (!isAuthed(auth)) return auth.error;

  const sb = getServiceClient();
  const { data, error } = await sb
    .from(TABLE)
    .select("*")
    .order("created_at", { ascending: true });

  if (error) {
    return NextResponse.json({ error: "Database operation failed" }, { status: 500 });
  }
  return NextResponse.json({ sources: data });
}

// ── POST: create a new ICS source ───────────────────────────────────────────

const CreateSchema = z.object({
  label: z.string().min(1).max(100),
  url: z.string().url().max(2000),
  callsign: z.string().max(20).optional().nullable(),
  enabled: z.boolean().optional().default(true),
});

export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
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
    return NextResponse.json({ error: "Database operation failed" }, { status: 500 });
  }
  return NextResponse.json({ source: data }, { status: 201 });
}

// ── PUT: update an existing ICS source ──────────────────────────────────────

const UpdateSchema = z.object({
  id: z.number(),
  label: z.string().min(1).max(100).optional(),
  url: z.string().url().max(2000).optional(),
  callsign: z.string().max(20).optional().nullable(),
  enabled: z.boolean().optional(),
});

export async function PUT(req: NextRequest) {
  const auth = await requireAdmin(req);
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
  return NextResponse.json({ source: data });
}

// ── DELETE: remove an ICS source ────────────────────────────────────────────

const DeleteSchema = z.object({
  id: z.number(),
});

export async function DELETE(req: NextRequest) {
  const auth = await requireAdmin(req);
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
