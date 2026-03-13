import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, isAuthed } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";

export const dynamic = "force-dynamic";

/** PATCH /api/pilots/time-off/[id] — approve or deny a time-off request (admin) */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAdmin(req);
  if (!isAuthed(auth)) return auth.error;

  const { id } = await params;
  const requestId = Number(id);
  if (Number.isNaN(requestId)) {
    return NextResponse.json({ ok: false, error: "Invalid id" }, { status: 400 });
  }

  const body = await req.json();
  const { status, review_notes } = body;

  if (!status || !["approved", "denied"].includes(status)) {
    return NextResponse.json(
      { ok: false, error: "status must be 'approved' or 'denied'" },
      { status: 400 },
    );
  }

  const supa = createServiceClient();
  const { data, error } = await supa
    .from("pilot_time_off_requests")
    .update({
      status,
      reviewed_by: auth.userId,
      reviewed_at: new Date().toISOString(),
      review_notes: review_notes ?? null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", requestId)
    .select()
    .single();

  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, request: data });
}
