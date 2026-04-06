import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthed } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";
import { getVendorAdapter } from "@/lib/fuelVendors";
import type { VendorId, ReleaseStatus } from "@/lib/fuelVendors";
import { postSlackMessage } from "@/lib/slack";

export const dynamic = "force-dynamic";

/**
 * POST /api/fuel-releases/[id]/cancel
 *
 * Cancel a pending or confirmed fuel release.
 * Body: { reason?: string }
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;

  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const reason = (body.reason as string) ?? "";

  const supa = createServiceClient();
  const { data: release, error: fetchErr } = await supa
    .from("fuel_releases")
    .select("*")
    .eq("id", id)
    .single();

  if (fetchErr || !release) {
    return NextResponse.json({ error: "Release not found" }, { status: 404 });
  }

  const cancellable: ReleaseStatus[] = ["pending", "confirmed"];
  if (!cancellable.includes(release.status)) {
    return NextResponse.json(
      { error: `Cannot cancel a release with status "${release.status}"` },
      { status: 400 },
    );
  }

  // Try vendor cancellation if there's a confirmation number
  const adapter = getVendorAdapter(release.vendor_id as VendorId);
  if (release.vendor_confirmation && adapter.capabilities.cancelRelease) {
    try {
      await adapter.cancelFuelRelease(release.vendor_confirmation);
    } catch (err) {
      console.error(`[fuel-release] cancel error for ${release.vendor_name}:`, err);
    }
  }

  // Update DB
  const now = new Date().toISOString();
  const history = [...(release.status_history ?? []), { status: "cancelled", at: now, by: auth.userId, note: reason || undefined }];

  const { error: updateErr } = await supa
    .from("fuel_releases")
    .update({
      status: "cancelled",
      cancellation_reason: reason || null,
      status_history: history,
      updated_at: now,
    })
    .eq("id", id);

  if (updateErr) {
    console.error("[fuel-release] cancel update error:", updateErr.message);
    return NextResponse.json({ error: "Failed to cancel" }, { status: 500 });
  }

  // Slack notification
  const strip = (c: string) => c.length === 4 && c.startsWith("K") ? c.slice(1) : c;
  const { data: src } = await supa
    .from("ics_sources")
    .select("slack_channel_id")
    .eq("label", release.tail_number.toUpperCase())
    .single();

  await postSlackMessage({
    channel: src?.slack_channel_id || "C0ANTTQ6R96",
    text: `Fuel release cancelled: ${release.tail_number} at ${strip(release.airport_code)}`,
    blocks: [{
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Fuel Release Cancelled*\n*Tail:* ${release.tail_number}  *Airport:* ${strip(release.airport_code)}\n*Vendor:* ${release.vendor_name}  *Gallons:* ${Number(release.gallons_requested).toLocaleString()}${reason ? `\n*Reason:* ${reason}` : ""}`,
      },
    }],
  });

  return NextResponse.json({ ok: true, status: "cancelled" });
}
