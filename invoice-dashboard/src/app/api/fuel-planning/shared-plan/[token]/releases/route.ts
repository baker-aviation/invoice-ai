import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ token: string }> };

/**
 * GET /api/fuel-planning/shared-plan/[token]/releases
 *
 * Public read-only endpoint that returns release status info for legs in
 * a shared fuel plan. No auth required — uses the plan token to validate.
 *
 * Returns: status, ref code, vendor name, payment method, plus the
 * latest vendor email reply and a trimmed status_history timeline so
 * crews can see correspondence. Deliberately excludes submitter emails
 * and internal notes.
 */
export async function GET(_req: NextRequest, ctx: Ctx) {
  const { token } = await ctx.params;

  const supa = createServiceClient();

  // Validate token + look up plan
  const { data: planLink, error: linkErr } = await supa
    .from("fuel_plan_links")
    .select("token, tail_number, expires_at, plan_data")
    .eq("token", token)
    .single();

  if (linkErr || !planLink) {
    return NextResponse.json({ error: "Plan not found" }, { status: 404 });
  }

  if (new Date(planLink.expires_at) < new Date()) {
    return NextResponse.json({ error: "This plan link has expired" }, { status: 410 });
  }

  // Get all active releases for this tail
  const { data: releases } = await supa
    .from("fuel_releases")
    .select(
      "id, tail_number, airport_code, vendor_name, vendor_id, status, vendor_confirmation, departure_date, gallons_requested, quoted_price, plan_link_token, plan_leg_index, fbo_name, status_history",
    )
    .eq("tail_number", planLink.tail_number)
    .neq("status", "cancelled")
    .order("created_at", { ascending: false });

  // Get vendor metadata for payment methods
  const { data: vendors } = await supa
    .from("fuel_vendors")
    .select("name, slug, release_type, notes")
    .eq("active", true);

  const vendorByName = new Map<string, { release_type: string; notes: string | null }>();
  for (const v of vendors ?? []) {
    vendorByName.set(v.name.toLowerCase(), { release_type: v.release_type, notes: v.notes });
    if (v.slug) vendorByName.set(v.slug.toLowerCase(), { release_type: v.release_type, notes: v.notes });
  }

  type HistoryEntry = { at?: string; status?: string; by?: string; note?: string };

  const publicReleases = (releases ?? []).map((r) => {
    const history: HistoryEntry[] = Array.isArray(r.status_history) ? r.status_history : [];
    const replies = history.filter((h) => h.by === "email-reply");
    return {
      id: r.id,
      airport_code: r.airport_code,
      vendor_name: r.vendor_name,
      vendor_id: r.vendor_id,
      status: r.status,
      vendor_confirmation: r.vendor_confirmation,
      departure_date: r.departure_date,
      gallons_requested: r.gallons_requested,
      quoted_price: r.quoted_price,
      plan_link_token: r.plan_link_token,
      plan_leg_index: r.plan_leg_index,
      fbo_name: r.fbo_name,
      latest_reply: replies.length > 0 ? replies[replies.length - 1] : null,
      timeline: history.map((h) => ({
        at: h.at,
        status: h.status,
        by: h.by,
        note: h.note,
      })),
    };
  });

  return NextResponse.json({
    ok: true,
    releases: publicReleases,
    vendors: Object.fromEntries(vendorByName),
  });
}
