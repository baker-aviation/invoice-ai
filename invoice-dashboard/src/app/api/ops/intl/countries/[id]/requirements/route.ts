import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthed, isRateLimited } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, ctx: Ctx) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;

  const { id } = await ctx.params;
  const supa = createServiceClient();
  const { data, error } = await supa
    .from("country_requirements")
    .select("*")
    .eq("country_id", id)
    .eq("is_active", true)
    .order("sort_order");

  if (error) {
    console.error("[intl/requirements] list error:", error);
    return NextResponse.json({ error: "Failed to list requirements" }, { status: 500 });
  }
  return NextResponse.json({ requirements: data ?? [] });
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

  const name = (input.name as string)?.trim();
  const requirement_type = (input.requirement_type as string)?.trim();
  if (!name) return NextResponse.json({ error: "name required" }, { status: 400 });
  if (!requirement_type || !["overflight", "landing", "customs", "handling"].includes(requirement_type)) {
    return NextResponse.json({ error: "requirement_type must be overflight, landing, customs, or handling" }, { status: 400 });
  }

  const supa = createServiceClient();
  const { data, error } = await supa
    .from("country_requirements")
    .insert({
      country_id: id,
      requirement_type,
      name,
      description: input.description ?? null,
      required_documents: input.required_documents ?? [],
      sort_order: input.sort_order ?? 0,
    })
    .select("*")
    .single();

  if (error) {
    console.error("[intl/requirements] insert error:", error);
    return NextResponse.json({ error: "Failed to create requirement" }, { status: 500 });
  }
  return NextResponse.json({ requirement: data }, { status: 201 });
}
