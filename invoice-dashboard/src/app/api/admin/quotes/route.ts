import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, isAuthed, isRateLimited } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";

/** GET — list all motivational quotes */
export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (!isAuthed(auth)) return auth.error;

  const supa = createServiceClient();
  const { data, error } = await supa
    .from("motivational_quotes")
    .select("*")
    .order("id");

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ quotes: data ?? [] });
}

/** POST — add a new quote */
export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (!isAuthed(auth)) return auth.error;
  if (await isRateLimited(auth.userId, 10)) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  let body: { quote?: string; author?: string; category?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const quote = body.quote?.trim();
  if (!quote) {
    return NextResponse.json({ error: "quote is required" }, { status: 400 });
  }

  const supa = createServiceClient();
  const { data, error } = await supa
    .from("motivational_quotes")
    .insert({
      quote,
      author: body.author?.trim() || null,
      category: body.category?.trim() || "sales",
    })
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, quote: data }, { status: 201 });
}

/** DELETE — remove a quote by id */
export async function DELETE(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (!isAuthed(auth)) return auth.error;

  let body: { id?: number };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!body.id || typeof body.id !== "number") {
    return NextResponse.json({ error: "id (number) is required" }, { status: 400 });
  }

  const supa = createServiceClient();
  const { error } = await supa
    .from("motivational_quotes")
    .delete()
    .eq("id", body.id);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
