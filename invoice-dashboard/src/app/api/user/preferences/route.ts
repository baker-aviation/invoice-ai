import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthed } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";

/** GET — fetch current user's preferences */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;

  const supa = createServiceClient();
  const { data, error } = await supa
    .from("user_preferences")
    .select("preferences")
    .eq("user_id", auth.userId)
    .maybeSingle();

  if (error) {
    return NextResponse.json({ error: "Failed to fetch preferences" }, { status: 500 });
  }

  return NextResponse.json({ ok: true, preferences: data?.preferences ?? {} });
}

/** PATCH — merge preferences for current user */
export async function PATCH(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { preferences } = body as { preferences?: Record<string, unknown> };
  if (!preferences || typeof preferences !== "object") {
    return NextResponse.json({ error: "preferences object required" }, { status: 400 });
  }

  const supa = createServiceClient();

  // Fetch existing to merge
  const { data: existing } = await supa
    .from("user_preferences")
    .select("preferences")
    .eq("user_id", auth.userId)
    .maybeSingle();

  const merged = { ...(existing?.preferences as Record<string, unknown> ?? {}), ...preferences };

  const { error } = await supa
    .from("user_preferences")
    .upsert(
      { user_id: auth.userId, preferences: merged, updated_at: new Date().toISOString() },
      { onConflict: "user_id" },
    );

  if (error) {
    return NextResponse.json({ error: "Failed to save preferences" }, { status: 500 });
  }

  return NextResponse.json({ ok: true, preferences: merged });
}
