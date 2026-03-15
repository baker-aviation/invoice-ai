import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthed } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";

const TABLE = "client_alert_dismissals";

/**
 * GET /api/ops/alerts/client-dismiss
 * Returns all dismissed client alert keys with who dismissed them.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;

  const supa = createServiceClient();
  const { data, error } = await supa
    .from(TABLE)
    .select("alert_key, dismissed_by, dismissed_at")
    .order("dismissed_at", { ascending: false })
    .limit(5000);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ dismissals: data ?? [] });
}

/**
 * POST /api/ops/alerts/client-dismiss
 * Dismiss a client-side alert (Baker PPR, after-hours, etc.)
 * Body: { key: string }
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;

  let body: { key?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const key = body.key;
  if (!key || typeof key !== "string" || key.length > 500) {
    return NextResponse.json({ error: "Invalid alert key" }, { status: 400 });
  }

  const supa = createServiceClient();
  const { error } = await supa
    .from(TABLE)
    .upsert(
      { alert_key: key, dismissed_by: auth.userId, dismissed_at: new Date().toISOString() },
      { onConflict: "alert_key" },
    );

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}

/**
 * DELETE /api/ops/alerts/client-dismiss
 * Un-dismiss a client alert.
 * Body: { key: string }
 */
export async function DELETE(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;

  let body: { key?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const key = body.key;
  if (!key || typeof key !== "string") {
    return NextResponse.json({ error: "Invalid alert key" }, { status: 400 });
  }

  const supa = createServiceClient();
  const { error } = await supa.from(TABLE).delete().eq("alert_key", key);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
