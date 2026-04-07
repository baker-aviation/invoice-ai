import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin, isAuthed } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";
import { normalizeName } from "@/lib/nameResolver";

export const dynamic = "force-dynamic";

const CreateAliasSchema = z.object({
  crew_member_id: z.string().uuid(),
  source: z.enum(["sheet", "jetinsight", "slack", "manual"]),
  alias_name: z.string().min(1),
  confirmed: z.boolean().optional().default(true),
});

const DeleteAliasSchema = z.object({
  id: z.string().uuid(),
});

/**
 * GET /api/crew/name-aliases
 * Returns all aliases grouped by crew_member_id.
 */
export async function GET(req: NextRequest) {
  const serviceKey = req.headers.get("x-service-key");
  const envKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const isServiceAuth = serviceKey && envKey && serviceKey.trim() === envKey.trim();
  if (!isServiceAuth) {
    const auth = await requireAdmin(req);
    if (!isAuthed(auth)) return auth.error;
  }

  const supa = createServiceClient();

  const { data: aliases, error: aliasErr } = await supa
    .from("crew_name_aliases")
    .select("id, crew_member_id, source, alias_name, normalized_name, confirmed, created_at")
    .order("created_at", { ascending: false });

  if (aliasErr) {
    return NextResponse.json({ error: aliasErr.message }, { status: 500 });
  }

  const { data: crew, error: crewErr } = await supa
    .from("crew_members")
    .select("id, name, role, jetinsight_name, slack_user_id, slack_display_name")
    .or("is_terminated.eq.false,is_terminated.is.null")
    .order("name");

  if (crewErr) {
    return NextResponse.json({ error: crewErr.message }, { status: 500 });
  }

  // Group aliases by crew_member_id
  const grouped: Record<string, {
    crew_member: { id: string; name: string; role: string };
    aliases: typeof aliases;
  }> = {};

  for (const c of crew ?? []) {
    grouped[c.id] = {
      crew_member: { id: c.id, name: c.name, role: c.role },
      aliases: [],
    };
  }

  for (const a of aliases ?? []) {
    if (grouped[a.crew_member_id]) {
      grouped[a.crew_member_id].aliases.push(a);
    }
  }

  return NextResponse.json({ aliases: Object.values(grouped), raw_count: aliases?.length ?? 0 });
}

/**
 * POST /api/crew/name-aliases
 * Creates a new alias mapping.
 */
export async function POST(req: NextRequest) {
  const serviceKey = req.headers.get("x-service-key");
  const envKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const isServiceAuth = serviceKey && envKey && serviceKey.trim() === envKey.trim();
  if (!isServiceAuth) {
    const auth = await requireAdmin(req);
    if (!isAuthed(auth)) return auth.error;
  }

  let raw: unknown;
  try { raw = await req.json(); } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = CreateAliasSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: "Validation failed", details: parsed.error.issues }, { status: 400 });
  }

  const supa = createServiceClient();
  const normalized = normalizeName(parsed.data.alias_name);

  const { data, error } = await supa
    .from("crew_name_aliases")
    .upsert({
      crew_member_id: parsed.data.crew_member_id,
      source: parsed.data.source,
      alias_name: parsed.data.alias_name,
      normalized_name: normalized,
      confirmed: parsed.data.confirmed,
    }, { onConflict: "source,normalized_name" })
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ alias: data });
}

/**
 * DELETE /api/crew/name-aliases
 * Removes an alias by ID.
 */
export async function DELETE(req: NextRequest) {
  const serviceKey = req.headers.get("x-service-key");
  const envKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const isServiceAuth = serviceKey && envKey && serviceKey.trim() === envKey.trim();
  if (!isServiceAuth) {
    const auth = await requireAdmin(req);
    if (!isAuthed(auth)) return auth.error;
  }

  let raw: unknown;
  try { raw = await req.json(); } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = DeleteAliasSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: "Validation failed", details: parsed.error.issues }, { status: 400 });
  }

  const supa = createServiceClient();
  const { error } = await supa
    .from("crew_name_aliases")
    .delete()
    .eq("id", parsed.data.id);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ deleted: true });
}
