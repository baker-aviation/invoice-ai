import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthed, isRateLimited } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** PATCH — assign an alert to someone */
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
  const assignedTo = body.assigned_to ?? null;

  // Validate: must be null (unassign) or a non-empty string
  if (assignedTo !== null && (typeof assignedTo !== "string" || !assignedTo.trim())) {
    return NextResponse.json({ error: "assigned_to must be a non-empty string or null" }, { status: 400 });
  }

  const supa = createServiceClient();
  const { error } = await supa
    .from("invoice_alerts")
    .update({
      assigned_to: assignedTo ? assignedTo.trim() : null,
      assigned_at: assignedTo ? new Date().toISOString() : null,
    })
    .eq("id", id);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
