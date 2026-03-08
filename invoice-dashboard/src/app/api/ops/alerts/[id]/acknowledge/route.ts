import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthed, isRateLimited } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;

  if (isRateLimited(auth.userId)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  const { id } = await params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: "Invalid alert ID" }, { status: 400 });
  }

  try {
    const supa = createServiceClient();

    // Global acknowledgment: set acknowledged_at + acknowledged_by on the alert itself.
    // Only update if not already acknowledged (avoid overwriting original acker).
    const { data, error } = await supa
      .from("ops_alerts")
      .update({
        acknowledged_at: new Date().toISOString(),
        acknowledged_by: auth.userId,
      })
      .eq("id", id)
      .is("acknowledged_at", null)
      .select("id")
      .single();

    if (error && error.code !== "PGRST116") {
      // PGRST116 = no rows matched (already acknowledged) — that's fine
      console.error("[ops/acknowledge] Update error:", error);
      return NextResponse.json({ error: "Database error" }, { status: 500 });
    }

    return NextResponse.json({ ok: true, already_acked: !data });
  } catch (err) {
    console.error("[ops/acknowledge] Database error:", err);
    return NextResponse.json({ error: "Database error" }, { status: 500 });
  }
}
