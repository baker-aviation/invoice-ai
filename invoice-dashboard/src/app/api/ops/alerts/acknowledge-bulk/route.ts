import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthed, isRateLimited } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";

/**
 * POST /api/ops/alerts/acknowledge-bulk
 * Acknowledge all alerts for a given flight_id.
 * Body: { flight_id: string }
 * Tags each alert with the user who acknowledged it.
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;

  if (isRateLimited(auth.userId)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  const { flight_id } = await req.json();
  if (!flight_id || typeof flight_id !== "string") {
    return NextResponse.json({ error: "flight_id required" }, { status: 400 });
  }

  try {
    const supa = createServiceClient();
    const now = new Date().toISOString();

    const { data, error } = await supa
      .from("ops_alerts")
      .update({
        acknowledged_at: now,
        acknowledged_by: auth.userId,
      })
      .eq("flight_id", flight_id)
      .is("acknowledged_at", null)
      .select("id");

    if (error) {
      console.error("[ops/acknowledge-bulk] Update error:", error);
      return NextResponse.json({ error: "Database error" }, { status: 500 });
    }

    const count = data?.length ?? 0;
    return NextResponse.json({ ok: true, acknowledged: count });
  } catch (err) {
    console.error("[ops/acknowledge-bulk] Error:", err);
    return NextResponse.json({ error: "Database error" }, { status: 500 });
  }
}
