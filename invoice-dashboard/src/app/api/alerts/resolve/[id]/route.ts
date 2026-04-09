import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthed, isRateLimited } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";
import { ALERT_RESOLUTIONS } from "@/lib/types";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const RESOLVED_STATUSES = new Set(["refund_received", "credit_applied", "disputed", "no_action"]);

/** PATCH — update resolution status on an alert */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;
  if (await isRateLimited(auth.userId, 30)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  const { id } = await params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: "Invalid alert ID" }, { status: 400 });
  }

  const body = await req.json().catch(() => ({}));
  const resolution = body.resolution;
  const resolutionNote = body.resolution_note ?? null;

  if (!resolution || !ALERT_RESOLUTIONS.includes(resolution)) {
    return NextResponse.json(
      { error: `resolution must be one of: ${ALERT_RESOLUTIONS.join(", ")}` },
      { status: 400 },
    );
  }

  if (resolutionNote !== null && typeof resolutionNote !== "string") {
    return NextResponse.json({ error: "resolution_note must be a string or null" }, { status: 400 });
  }

  const isResolved = RESOLVED_STATUSES.has(resolution);

  const supa = createServiceClient();
  const { error } = await supa
    .from("invoice_alerts")
    .update({
      resolution,
      resolution_note: resolutionNote ? resolutionNote.trim().slice(0, 2000) : null,
      resolved_at: isResolved ? new Date().toISOString() : null,
      resolved_by: isResolved ? (auth.email ?? auth.userId) : null,
    })
    .eq("id", id);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
