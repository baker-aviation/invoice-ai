import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthed, isRateLimited } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;

  try {
    const supa = createServiceClient();
    const { data, error } = await supa
      .from("aircraft_tags")
      .select("id, tail_number, tag, note, created_by, created_at")
      .order("created_at", { ascending: false });

    if (error) {
      console.error("[aircraft-tags] GET error:", error);
      return NextResponse.json({ error: "Failed to fetch tags" }, { status: 500 });
    }

    return NextResponse.json({ tags: data ?? [] });
  } catch (err) {
    console.error("[aircraft-tags] GET error:", err);
    return NextResponse.json({ error: "Database error" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;
  if (await isRateLimited(auth.userId)) return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });

  try {
    const body = await req.json();
    const { tail_number, tag, note } = body as { tail_number?: string; tag?: string; note?: string };

    if (!tail_number || !tag) {
      return NextResponse.json({ error: "tail_number and tag are required" }, { status: 400 });
    }

    const supa = createServiceClient();
    const { data, error } = await supa
      .from("aircraft_tags")
      .upsert(
        { tail_number, tag, note: note ?? null, created_by: auth.userId },
        { onConflict: "tail_number,tag" },
      )
      .select("id, tail_number, tag, note, created_at")
      .single();

    if (error) {
      console.error("[aircraft-tags] POST error:", error);
      return NextResponse.json({ error: "Failed to save tag" }, { status: 500 });
    }

    return NextResponse.json({ ok: true, tag: data });
  } catch (err) {
    console.error("[aircraft-tags] POST error:", err);
    return NextResponse.json({ error: "Database error" }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;
  if (await isRateLimited(auth.userId)) return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });

  try {
    const body = await req.json();
    const { tail_number, tag } = body as { tail_number?: string; tag?: string };

    if (!tail_number || !tag) {
      return NextResponse.json({ error: "tail_number and tag are required" }, { status: 400 });
    }

    const supa = createServiceClient();
    const { error } = await supa
      .from("aircraft_tags")
      .delete()
      .eq("tail_number", tail_number)
      .eq("tag", tag);

    if (error) {
      console.error("[aircraft-tags] DELETE error:", error);
      return NextResponse.json({ error: "Failed to delete tag" }, { status: 500 });
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[aircraft-tags] DELETE error:", err);
    return NextResponse.json({ error: "Database error" }, { status: 500 });
  }
}
