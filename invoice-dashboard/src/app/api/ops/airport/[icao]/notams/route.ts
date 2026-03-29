import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { requireAuth, isAuthed } from "@/lib/api-auth";
import { filterRunwayClosureNotams } from "@/lib/runwayData";

export const dynamic = "force-dynamic";

// Priority order for NOTAM types (lower = higher priority in sort)
const TYPE_PRIORITY: Record<string, number> = {
  NOTAM_RUNWAY: 0,
  NOTAM_AERODROME: 1,
  NOTAM_AD_RESTRICTED: 1,
  NOTAM_PPR: 2,
  NOTAM_TFR: 3,
  NOTAM_OTHER: 10,
};

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ icao: string }> },
) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;

  const { icao } = await params;
  const upper = icao.toUpperCase();

  const supa = createServiceClient();

  // Fetch all NOTAMs for this airport (both acknowledged and not, last 30 days)
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  const { data, error } = await supa
    .from("ops_alerts")
    .select("id, alert_type, severity, airport_icao, subject, body, created_at, acknowledged_at, acknowledged_by, raw_data")
    .eq("airport_icao", upper)
    .like("alert_type", "NOTAM_%")
    .gte("created_at", cutoff)
    .order("created_at", { ascending: false })
    .limit(200);

  if (error) {
    return NextResponse.json({ error: "Failed to fetch NOTAMs" }, { status: 500 });
  }

  // Filter out runway closure NOTAMs when airport still has a 5000+ ft paved runway open
  const withDates = (data ?? []).map((d) => {
    let notam_dates: Record<string, string | null> | null = null;
    try {
      const rd = typeof d.raw_data === "string" ? JSON.parse(d.raw_data) : d.raw_data;
      const nd = rd?.notam_dates;
      if (nd) notam_dates = nd;
    } catch { /* ignore */ }
    return { ...d, airport_icao: d.airport_icao ?? upper, notam_dates };
  });
  const filtered = filterRunwayClosureNotams(withDates);

  // Sort: priority types first (RWY, AD, PPR, TFR), then by date
  const sorted = filtered.sort((a, b) => {
    const pa = TYPE_PRIORITY[a.alert_type] ?? 99;
    const pb = TYPE_PRIORITY[b.alert_type] ?? 99;
    if (pa !== pb) return pa - pb;
    return b.created_at.localeCompare(a.created_at);
  });

  return NextResponse.json({ icao: upper, notams: sorted, count: sorted.length });
}
