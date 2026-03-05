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

    // Verify alert exists
    const { data: alert } = await supa
      .from("ops_alerts")
      .select("id")
      .eq("id", id)
      .single();

    if (!alert) {
      return NextResponse.json({ error: "Alert not found" }, { status: 404 });
    }

    // Insert per-user dismissal (ignore if already dismissed)
    const { error } = await supa
      .from("ops_alert_dismissals")
      .upsert(
        { alert_id: id, user_id: auth.userId },
        { onConflict: "alert_id,user_id", ignoreDuplicates: true },
      );

    if (error) {
      console.error("[ops/acknowledge] Dismissal insert error:", error);
      return NextResponse.json({ error: "Database error" }, { status: 500 });
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[ops/acknowledge] Database error:", err);
    return NextResponse.json({ error: "Database error" }, { status: 500 });
  }
}
