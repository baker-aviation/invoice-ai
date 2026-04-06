import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthed } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";
import { getVendorAdapter } from "@/lib/fuelVendors";
import type { VendorId } from "@/lib/fuelVendors";

export const dynamic = "force-dynamic";

/**
 * GET /api/fuel-releases/[id]/status
 *
 * Refresh release status from the vendor API (if supported),
 * then return the current status from the DB.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;

  const { id } = await params;

  const supa = createServiceClient();
  const { data: release, error: fetchErr } = await supa
    .from("fuel_releases")
    .select("*")
    .eq("id", id)
    .single();

  if (fetchErr || !release) {
    return NextResponse.json({ error: "Release not found" }, { status: 404 });
  }

  // Try to refresh from vendor API
  const adapter = getVendorAdapter(release.vendor_id as VendorId);
  if (release.vendor_confirmation && adapter.capabilities.checkReleaseStatus) {
    try {
      const vendorStatus = await adapter.getFuelReleaseStatus(release.vendor_confirmation);
      if (vendorStatus && vendorStatus.status !== release.status) {
        const now = new Date().toISOString();
        const history = [
          ...(release.status_history ?? []),
          { status: vendorStatus.status, at: now, by: "vendor-sync" },
        ];
        await supa
          .from("fuel_releases")
          .update({
            status: vendorStatus.status,
            actual_price: vendorStatus.actualPrice ?? release.actual_price,
            actual_gallons: vendorStatus.actualGallons ?? release.actual_gallons,
            vendor_confirmation: vendorStatus.vendorConfirmation ?? release.vendor_confirmation,
            status_history: history,
            updated_at: now,
          })
          .eq("id", id);

        return NextResponse.json({
          ok: true,
          id,
          status: vendorStatus.status,
          actualPrice: vendorStatus.actualPrice,
          actualGallons: vendorStatus.actualGallons,
          vendorConfirmation: vendorStatus.vendorConfirmation ?? release.vendor_confirmation,
          refreshed: true,
        });
      }
    } catch (err) {
      console.error(`[fuel-release] status refresh error for ${release.vendor_name}:`, err);
    }
  }

  return NextResponse.json({
    ok: true,
    id,
    status: release.status,
    actualPrice: release.actual_price,
    actualGallons: release.actual_gallons,
    vendorConfirmation: release.vendor_confirmation,
    refreshed: false,
  });
}
