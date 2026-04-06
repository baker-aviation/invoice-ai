/**
 * Avfuel adapter — stub.
 * Delegates to manual adapter until we get Avfuel API access.
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
import { ManualAdapter } from "./manual";

const manual = new ManualAdapter();

export class AvfuelAdapter implements FuelVendorAdapter {
  readonly vendorId = "avfuel" as const;
  readonly vendorName = "Avfuel";
  readonly capabilities: VendorCapabilities = {
    realTimePricing: false,
    submitRelease: false,
    checkReleaseStatus: false,
    cancelRelease: false,
  };

  async getRealTimePrice(_req: RealTimePriceRequest): Promise<RealTimePriceResponse | null> {
    return null;
  }

  async submitFuelRelease(req: FuelReleaseRequest): Promise<FuelReleaseResponse> {
    return manual.submitFuelRelease(req);
  }

  async getFuelReleaseStatus(vendorConfirmation: string): Promise<FuelReleaseStatusResponse | null> {
    return manual.getFuelReleaseStatus(vendorConfirmation);
  }

  async cancelFuelRelease(vendorConfirmation: string): Promise<{ success: boolean; message?: string }> {
    return manual.cancelFuelRelease(vendorConfirmation);
  }
}
