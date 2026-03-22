import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthed } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";

export const dynamic = "force-dynamic";

/** GET — list all pinned alert IDs and keys */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;

  const supa = createServiceClient();
  const { data, error } = await supa
    .from("notam_pins")
    .select("alert_id, pin_key, pinned_by, note, created_at")
    .order("created_at", { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ pins: data ?? [] });
}

/** POST — pin an alert. Body: { alert_id?, pin_key?, note? } */
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;

  let input: Record<string, unknown>;
  try { input = await req.json(); } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const alert_id = (input.alert_id as string) || null;
  const pin_key = (input.pin_key as string) || null;
  if (!alert_id && !pin_key) return NextResponse.json({ error: "alert_id or pin_key required" }, { status: 400 });

  const supa = createServiceClient();

  // Delete any existing pin for this alert/key, then insert fresh
  if (alert_id) {
    await supa.from("notam_pins").delete().eq("alert_id", alert_id);
  } else {
    await supa.from("notam_pins").delete().eq("pin_key", pin_key!);
  }

  const { error } = await supa
    .from("notam_pins")
    .insert({ alert_id, pin_key, pinned_by: auth.userId, note: (input.note as string) ?? null });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}

/** DELETE — unpin an alert. Body: { alert_id?, pin_key? } */
export async function DELETE(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;

  let input: Record<string, unknown>;
  try { input = await req.json(); } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const alert_id = (input.alert_id as string) || null;
  const pin_key = (input.pin_key as string) || null;
  if (!alert_id && !pin_key) return NextResponse.json({ error: "alert_id or pin_key required" }, { status: 400 });

  const supa = createServiceClient();
  const query = alert_id
    ? supa.from("notam_pins").delete().eq("alert_id", alert_id)
    : supa.from("notam_pins").delete().eq("pin_key", pin_key!);

  const { error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
