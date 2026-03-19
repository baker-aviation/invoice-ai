import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import { requireAdmin, isRateLimited, isAuthed } from "@/lib/api-auth";

const TABLE = "baker_ppr_airports";

function getServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Missing Supabase config");
  return createClient(url, key);
}

// ── GET: list all Baker PPR airports (admin only) ─────────────────────

export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (!isAuthed(auth)) return auth.error;

  const sb = getServiceClient();
  const { data, error } = await sb
    .from(TABLE)
    .select("*")
    .order("icao", { ascending: true });

  if (error) {
    return NextResponse.json({ error: "Failed to fetch airports" }, { status: 500 });
  }
  return NextResponse.json({ airports: data });
}

// ── POST: add a Baker PPR airport (admin only) ──────────────────────────────

const AddSchema = z.object({
  icao: z
    .string()
    .min(3)
    .max(5)
    .transform((v) => v.toUpperCase().trim()),
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

  const parsed = AddSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", details: parsed.error.issues },
      { status: 400 },
    );
  }

  const sb = getServiceClient();
  const { data, error } = await sb
    .from(TABLE)
    .insert({ icao: parsed.data.icao })
    .select()
    .single();

  if (error) {
    if (error.code === "23505") {
      return NextResponse.json({ error: "Airport already exists" }, { status: 409 });
    }
    return NextResponse.json({ error: "Failed to add airport" }, { status: 500 });
  }
  return NextResponse.json({ airport: data }, { status: 201 });
}

// ── DELETE: remove a Baker PPR airport (admin only) ─────────────────────────

const DeleteSchema = z.object({
  icao: z
    .string()
    .min(3)
    .max(5)
    .transform((v) => v.toUpperCase().trim()),
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
  const { error } = await sb.from(TABLE).delete().eq("icao", parsed.data.icao);

  if (error) {
    return NextResponse.json({ error: "Failed to delete airport" }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
