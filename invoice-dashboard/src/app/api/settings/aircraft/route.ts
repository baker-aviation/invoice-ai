import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, isAuthed, isRateLimited } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";

/**
 * Aircraft settings API — manages tail numbers and JetInsight ICS URLs.
 *
 * Data is stored in a Supabase table `aircraft_config`. If the table doesn't
 * exist yet, the GET endpoint falls back to extracting unique tail numbers
 * from the flights table (read-only mode).
 */

// GET: list all aircraft configs
export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (!isAuthed(auth)) return auth.error;

  const supa = createServiceClient();

  // Try to read from aircraft_config table first
  const { data: configs, error: configErr } = await supa
    .from("aircraft_config")
    .select("*")
    .order("tail_number", { ascending: true });

  if (!configErr && configs) {
    return NextResponse.json({ ok: true, aircraft: configs, source: "aircraft_config" });
  }

  // Fallback: extract unique tail numbers from flights table
  const { data: flights, error: flightErr } = await supa
    .from("flights")
    .select("tail_number")
    .not("tail_number", "is", null)
    .order("tail_number", { ascending: true });

  if (flightErr) {
    return NextResponse.json({ error: "Failed to fetch data" }, { status: 500 });
  }

  const tails = [...new Set((flights ?? []).map((f) => f.tail_number).filter(Boolean))].sort();
  const aircraft = tails.map((tail) => ({
    tail_number: tail,
    ics_url: null,
    active: true,
    notes: null,
  }));

  return NextResponse.json({
    ok: true,
    aircraft,
    source: "flights_fallback",
    hint: "Create the aircraft_config table to enable editing. See /api/settings/aircraft/setup",
  });
}

// POST: create or update an aircraft config row
export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (!isAuthed(auth)) return auth.error;

  if (isRateLimited(auth.userId)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  let body: Record<string, any>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const tailNumber = String(body.tail_number ?? "").trim().toUpperCase();
  if (!tailNumber || !/^N\d{1,5}[A-Z]{0,2}$/.test(tailNumber)) {
    return NextResponse.json(
      { error: "Invalid tail number. Must be FAA format (e.g., N51GB)" },
      { status: 400 },
    );
  }

  const icsUrl = body.ics_url ? String(body.ics_url).trim() : null;
  if (icsUrl && !icsUrl.startsWith("http")) {
    return NextResponse.json({ error: "ICS URL must start with http" }, { status: 400 });
  }

  const active = body.active !== false;
  const notes = body.notes ? String(body.notes).trim().slice(0, 500) : null;

  const supa = createServiceClient();

  const { data, error } = await supa
    .from("aircraft_config")
    .upsert(
      {
        tail_number: tailNumber,
        ics_url: icsUrl,
        active,
        notes,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "tail_number" },
    )
    .select()
    .single();

  if (error) {
    // If table doesn't exist, give helpful message
    if (error.message?.includes("does not exist") || error.code === "42P01") {
      return NextResponse.json({
        error: "aircraft_config table not found. Run the setup SQL first.",
        setup_sql: SETUP_SQL,
      }, { status: 500 });
    }
    console.error("[settings/aircraft] upsert error:", error);
    return NextResponse.json({ error: "Failed to save" }, { status: 500 });
  }

  return NextResponse.json({ ok: true, aircraft: data });
}

// DELETE: remove an aircraft config
export async function DELETE(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (!isAuthed(auth)) return auth.error;

  const { searchParams } = new URL(req.url);
  const tailNumber = searchParams.get("tail_number")?.trim().toUpperCase();

  if (!tailNumber) {
    return NextResponse.json({ error: "tail_number parameter required" }, { status: 400 });
  }

  const supa = createServiceClient();

  const { error } = await supa
    .from("aircraft_config")
    .delete()
    .eq("tail_number", tailNumber);

  if (error) {
    console.error("[settings/aircraft] delete error:", error);
    return NextResponse.json({ error: "Failed to delete" }, { status: 500 });
  }

  return NextResponse.json({ ok: true, deleted: tailNumber });
}

const SETUP_SQL = `
-- Run this in Supabase SQL Editor to create the aircraft config table
create table if not exists aircraft_config (
  id bigint generated always as identity primary key,
  tail_number text unique not null,
  ics_url text,
  active boolean default true,
  notes text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Enable RLS
alter table aircraft_config enable row level security;

-- Allow service role full access (API routes use service role key)
create policy "service_role_all" on aircraft_config
  for all using (true) with check (true);
`;
