import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, isAuthed } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";

export const dynamic = "force-dynamic";

/**
 * POST /api/crew/airport-aliases
 *
 * Upsert an FBO → commercial airport alias.
 * Body: { fbo_icao: string, commercial_icao: string, preferred?: boolean }
 */
export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (!isAuthed(auth)) return auth.error;

  let body: { fbo_icao?: string; commercial_icao?: string; preferred?: boolean };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const fbo = body.fbo_icao?.trim().toUpperCase();
  const commercial = body.commercial_icao?.trim().toUpperCase();

  if (!fbo || !commercial) {
    return NextResponse.json(
      { error: "fbo_icao and commercial_icao are required" },
      { status: 400 },
    );
  }

  // Basic ICAO validation: 3-4 chars
  if (fbo.length < 3 || fbo.length > 4 || commercial.length < 3 || commercial.length > 4) {
    return NextResponse.json(
      { error: "ICAO codes must be 3-4 characters" },
      { status: 400 },
    );
  }

  const supa = createServiceClient();
  const preferred = body.preferred ?? true;

  // Try delete + insert instead of upsert (no unique constraint on fbo_icao)
  await supa.from("airport_aliases").delete().eq("fbo_icao", fbo);
  const { data, error } = await supa
    .from("airport_aliases")
    .insert({ fbo_icao: fbo, commercial_icao: commercial, preferred })
    .select()
    .single();

  if (error) {
    return NextResponse.json(
      { error: error.message },
      { status: 500 },
    );
  }

  return NextResponse.json({ alias: data });
}
