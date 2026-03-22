import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthed } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";

export const dynamic = "force-dynamic";

/** GET — list all pinned NOTAM alert IDs */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;

  const supa = createServiceClient();
  const { data, error } = await supa
    .from("notam_pins")
    .select("alert_id, pinned_by, note, created_at")
    .order("created_at", { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ pins: data ?? [] });
}

/** POST — pin a NOTAM. Body: { alert_id, note? } */
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;

  let input: Record<string, unknown>;
  try { input = await req.json(); } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const alert_id = input.alert_id as string;
  if (!alert_id) return NextResponse.json({ error: "alert_id required" }, { status: 400 });

  const supa = createServiceClient();
  const { error } = await supa
    .from("notam_pins")
    .upsert(
      { alert_id, pinned_by: auth.userId, note: (input.note as string) ?? null },
      { onConflict: "alert_id" },
    );

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}

/** DELETE — unpin a NOTAM. Body: { alert_id } */
export async function DELETE(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;

  let input: Record<string, unknown>;
  try { input = await req.json(); } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const alert_id = input.alert_id as string;
  if (!alert_id) return NextResponse.json({ error: "alert_id required" }, { status: 400 });

  const supa = createServiceClient();
  const { error } = await supa.from("notam_pins").delete().eq("alert_id", alert_id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
