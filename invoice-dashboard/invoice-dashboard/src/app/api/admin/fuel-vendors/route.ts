import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, isAuthed, isRateLimited } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";
import { z } from "zod";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// GET /api/admin/fuel-vendors — list all vendors
// ---------------------------------------------------------------------------

export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (!isAuthed(auth)) return auth.error;

  const supa = createServiceClient();
  const { data, error } = await supa
    .from("fuel_vendors")
    .select("*")
    .order("is_international", { ascending: true })
    .order("name", { ascending: true });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ vendors: data });
}

// ---------------------------------------------------------------------------
// POST /api/admin/fuel-vendors — create a vendor
// ---------------------------------------------------------------------------

const CreateSchema = z.object({
  name: z.string().min(1, "Name is required"),
  slug: z.string().min(1, "Slug is required").regex(/^[a-z0-9-]+$/, "Slug must be lowercase alphanumeric with dashes"),
  contact_email: z.string().email().nullable().optional(),
  release_type: z.enum(["email", "card", "api"]).default("email"),
  is_international: z.boolean().default(false),
  requires_destination: z.boolean().default(false),
  notes: z.string().nullable().optional(),
  active: z.boolean().default(true),
});

export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (!isAuthed(auth)) return auth.error;
  if (await isRateLimited(auth.userId, 20)) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const body = await req.json().catch(() => ({}));
  const parsed = CreateSchema.safeParse(body);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
    return NextResponse.json({ error: "Validation failed", details: issues }, { status: 400 });
  }

  const supa = createServiceClient();
  const { data, error } = await supa
    .from("fuel_vendors")
    .insert({
      ...parsed.data,
      contact_email: parsed.data.contact_email || null,
      notes: parsed.data.notes || null,
    })
    .select()
    .single();

  if (error) {
    if (error.code === "23505") {
      return NextResponse.json({ error: "A vendor with that name or slug already exists" }, { status: 409 });
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ vendor: data }, { status: 201 });
}

// ---------------------------------------------------------------------------
// PUT /api/admin/fuel-vendors — update a vendor
// ---------------------------------------------------------------------------

const UpdateSchema = z.object({
  id: z.number(),
  name: z.string().min(1).optional(),
  slug: z.string().min(1).regex(/^[a-z0-9-]+$/).optional(),
  contact_email: z.string().email().nullable().optional(),
  release_type: z.enum(["email", "card", "api"]).optional(),
  is_international: z.boolean().optional(),
  requires_destination: z.boolean().optional(),
  notes: z.string().nullable().optional(),
  active: z.boolean().optional(),
});

export async function PUT(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (!isAuthed(auth)) return auth.error;
  if (await isRateLimited(auth.userId, 20)) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const body = await req.json().catch(() => ({}));
  const parsed = UpdateSchema.safeParse(body);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
    return NextResponse.json({ error: "Validation failed", details: issues }, { status: 400 });
  }

  const { id, ...updates } = parsed.data;
  const supa = createServiceClient();
  const { data, error } = await supa
    .from("fuel_vendors")
    .update(updates)
    .eq("id", id)
    .select()
    .single();

  if (error) {
    if (error.code === "23505") {
      return NextResponse.json({ error: "A vendor with that name or slug already exists" }, { status: 409 });
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ vendor: data });
}

// ---------------------------------------------------------------------------
// DELETE /api/admin/fuel-vendors — delete a vendor
// ---------------------------------------------------------------------------

export async function DELETE(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (!isAuthed(auth)) return auth.error;
  if (await isRateLimited(auth.userId, 10)) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const { id } = await req.json().catch(() => ({ id: null }));
  if (!id) {
    return NextResponse.json({ error: "id is required" }, { status: 400 });
  }

  const supa = createServiceClient();
  const { error } = await supa.from("fuel_vendors").delete().eq("id", id);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
