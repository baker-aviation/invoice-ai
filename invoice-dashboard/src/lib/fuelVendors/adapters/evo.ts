/**
 * EVO Fuels adapter.
 *
 * Stub — real API integration will be wired in once we get the API key and docs
 * from EVO. For now delegates everything to the manual flow.
 *
 * ENV: EVO_API_KEY, EVO_API_BASE_URL
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

export class EvoAdapter implements FuelVendorAdapter {
  readonly vendorId = "evo" as const;
  readonly vendorName = "EVO";

  // Flip these to true once API integration is live
  readonly capabilities: VendorCapabilities = {
    realTimePricing: false,
    submitRelease: false,
    checkReleaseStatus: false,
    cancelRelease: false,
  };

  private get apiKey(): string | undefined {
    return process.env.EVO_API_KEY;
  }

  private get baseUrl(): string {
    return process.env.EVO_API_BASE_URL ?? "https://api.flyevo.com";
  }

  async getRealTimePrice(_req: RealTimePriceRequest): Promise<RealTimePriceResponse | null> {
    if (!this.apiKey) return null;
    // TODO: implement real EVO pricing API call
    // const res = await fetch(`${this.baseUrl}/pricing`, { ... });
    return null;
  }

  async submitFuelRelease(req: FuelReleaseRequest): Promise<FuelReleaseResponse> {
    if (!this.apiKey) return manual.submitFuelRelease(req);
    // TODO: implement real EVO fuel release API call
    return manual.submitFuelRelease(req);
  }

  async getFuelReleaseStatus(vendorConfirmation: string): Promise<FuelReleaseStatusResponse | null> {
    if (!this.apiKey) return null;
    // TODO: implement real EVO status check
    return manual.getFuelReleaseStatus(vendorConfirmation);
  }

  async cancelFuelRelease(vendorConfirmation: string): Promise<{ success: boolean; message?: string }> {
    if (!this.apiKey) return manual.cancelFuelRelease(vendorConfirmation);
    // TODO: implement real EVO cancellation
    return manual.cancelFuelRelease(vendorConfirmation);
  }
}
