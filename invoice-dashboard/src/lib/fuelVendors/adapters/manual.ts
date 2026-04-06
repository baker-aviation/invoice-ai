/**
 * Manual / fallback fuel vendor adapter.
 *
 * Used when a vendor has no API. Creates the DB record and sends a Slack
 * notification so dispatch can handle the release manually (phone/email/portal).
 */

import type {
  FuelVendorAdapter,
  VendorCapabilities,
  RealTimePriceRequest,
  RealTimePriceResponse,
  FuelReleaseRequest,
  FuelReleaseResponse,
  FuelReleaseStatusResponse,
} from "../types";

export class ManualAdapter implements FuelVendorAdapter {
  readonly vendorId = "manual" as const;
  readonly vendorName = "Manual";
  readonly capabilities: VendorCapabilities = {
    realTimePricing: false,
    submitRelease: false, // we handle it at the route level, not via vendor API
    checkReleaseStatus: false,
    cancelRelease: false,
  };

  async getRealTimePrice(_req: RealTimePriceRequest): Promise<RealTimePriceResponse | null> {
    return null;
  }

  async submitFuelRelease(req: FuelReleaseRequest): Promise<FuelReleaseResponse> {
    // The manual adapter always "succeeds" — the actual release is done by a human.
    // DB insert + Slack notification happen in the API route layer.
    return {
      success: true,
      status: "pending",
      message: `Manual release requested for ${req.tailNumber} at ${req.airport}`,
    };
  }

  async getFuelReleaseStatus(_vendorConfirmation: string): Promise<FuelReleaseStatusResponse | null> {
    return null; // manual releases are updated by hand
  }

  async cancelFuelRelease(_vendorConfirmation: string): Promise<{ success: boolean; message?: string }> {
    return { success: true, message: "Manual release marked as cancelled" };
  }
}
