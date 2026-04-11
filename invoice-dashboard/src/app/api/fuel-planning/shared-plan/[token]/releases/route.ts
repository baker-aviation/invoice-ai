import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";

export const dynamic = "force-dynamic";

/**
 * GET /api/fuel-planning/shared-plan/[token]/releases
 *
 * Public (token-gated) endpoint that returns fuel release status + the
 * email reply thread for the tokenized plan link. Used by the crew-
 * facing /tanker/plan/[token] page to display status and correspondence
 * without needing a Supabase login.
 *
 * Returned fields are deliberately scoped — no submitter email, no
 * internal notes. Just status, confirmation, vendor reply text, and a
 * trimmed status_history timeline.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  if (!token) return NextResponse.json({ error: "token required" }, { status: 400 });

  const supa = createServiceClient();

  // Validate the token exists and is unexpired before returning release data.
  const { data: link } = await supa
    .from("fuel_plan_links")
    .select("token, expires_at")
    .eq("token", token)
    .maybeSingle();
  if (!link) return NextResponse.json({ error: "Plan link not found" }, { status: 404 });
  if (new Date(link.expires_at) < new Date()) {
    return NextResponse.json({ error: "Plan link expired" }, { status: 410 });
  }

  const { data: rows, error } = await supa
    .from("fuel_releases")
    .select(
      "id, status, vendor_name, fbo_name, gallons_requested, quoted_price, departure_date, vendor_confirmation, status_history, plan_leg_index",
    )
    .eq("plan_link_token", token)
    .order("created_at", { ascending: true });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  type HistoryEntry = { at?: string; status?: string; by?: string; note?: string };
  const releases = (rows ?? []).map((r) => {
    const history: HistoryEntry[] = Array.isArray(r.status_history) ? r.status_history : [];
    const replies = history.filter((h) => h.by === "email-reply");
    return {
      id: r.id,
      status: r.status,
      vendor_name: r.vendor_name,
      fbo_name: r.fbo_name,
      gallons_requested: r.gallons_requested,
      quoted_price: r.quoted_price,
      departure_date: r.departure_date,
      vendor_confirmation: r.vendor_confirmation,
      plan_leg_index: r.plan_leg_index,
      latest_reply: replies.length > 0 ? replies[replies.length - 1] : null,
      timeline: history.map((h) => ({
        at: h.at,
        status: h.status,
        by: h.by,
        note: h.note,
      })),
    };
  });

  return NextResponse.json({ releases });
}
