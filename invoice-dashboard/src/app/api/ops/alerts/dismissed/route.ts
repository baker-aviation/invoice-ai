import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthed } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";

/**
 * GET /api/ops/alerts/dismissed
 * Returns recently dismissed (acknowledged) MX_NOTE alerts so admins can restore them.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;

  const supa = createServiceClient();

  // Get MX_NOTE alerts dismissed in the last 30 days
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  const { data, error } = await supa
    .from("ops_alerts")
    .select("id, tail_number, airport_icao, alert_type, body, acknowledged_at, acknowledged_by, created_at, raw_data")
    .eq("alert_type", "MX_NOTE")
    .not("acknowledged_at", "is", null)
    .gte("acknowledged_at", cutoff)
    .order("acknowledged_at", { ascending: false })
    .limit(100);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const notes = (data ?? []).map((row) => {
    let startTime: string | null = null;
    let endTime: string | null = null;
    try {
      const rd = typeof row.raw_data === "string" ? JSON.parse(row.raw_data) : row.raw_data;
      startTime = rd?.start_time ?? null;
      endTime = rd?.end_time ?? null;
    } catch { /* ignore */ }
    return {
      id: row.id,
      tail_number: row.tail_number,
      airport_icao: row.airport_icao,
      body: row.body,
      start_time: startTime,
      end_time: endTime,
      acknowledged_at: row.acknowledged_at,
      created_at: row.created_at,
    };
  });

  return NextResponse.json({ ok: true, notes });
}
