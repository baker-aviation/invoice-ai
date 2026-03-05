import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, isRateLimited } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";

/**
 * DELETE /api/pilot/training/assignments/[assignmentId] — remove assignment (admin only)
 */
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ assignmentId: string }> },
) {
  const auth = await requireAdmin(req);
  if ("error" in auth) return auth.error;

  if (isRateLimited(auth.userId, 10)) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const { assignmentId } = await params;
  const id = Number(assignmentId);
  if (!id || isNaN(id)) {
    return NextResponse.json({ error: "Invalid assignment ID" }, { status: 400 });
  }

  const supa = createServiceClient();
  const { error } = await supa.from("lms_assignments").delete().eq("id", id);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
