import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, isAuthed } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";

export const dynamic = "force-dynamic";

/**
 * POST /api/crew/airport-aliases
 *
 * Upsert FBO → commercial airport alias(es).
 *
 * Single alias:
 *   Body: { fbo_icao: string, commercial_icao: string, preferred?: boolean }
 *
 * Multiple aliases (replaces all for this FBO):
 *   Body: { fbo_icao: string, commercial_icaos: string[], preferred_icao?: string }
 */
export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (!isAuthed(auth)) return auth.error;

  let body: {
    fbo_icao?: string;
    commercial_icao?: string;
    commercial_icaos?: string[];
    preferred?: boolean;
    preferred_icao?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const fbo = body.fbo_icao?.trim().toUpperCase();
  if (!fbo || fbo.length < 3 || fbo.length > 4) {
    return NextResponse.json({ error: "fbo_icao must be 3-4 characters" }, { status: 400 });
  }

  // Normalize to array of commercial airports
  let commercials: string[] = [];
  if (body.commercial_icaos && Array.isArray(body.commercial_icaos)) {
    commercials = body.commercial_icaos.map((c) => c.trim().toUpperCase()).filter((c) => c.length >= 3 && c.length <= 4);
  } else if (body.commercial_icao) {
    const c = body.commercial_icao.trim().toUpperCase();
    if (c.length >= 3 && c.length <= 4) commercials = [c];
  }

  if (commercials.length === 0) {
    return NextResponse.json({ error: "At least one commercial airport (commercial_icao or commercial_icaos) is required" }, { status: 400 });
  }

  const preferredIcao = body.preferred_icao?.trim().toUpperCase() ?? commercials[0];

  const supa = createServiceClient();

  // Delete all existing aliases for this FBO, then bulk insert
  await supa.from("airport_aliases").delete().eq("fbo_icao", fbo);

  const rows = commercials.map((c) => ({
    fbo_icao: fbo,
    commercial_icao: c,
    preferred: c === preferredIcao,
  }));

  const { data, error } = await supa
    .from("airport_aliases")
    .insert(rows)
    .select();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ aliases: data });
}
