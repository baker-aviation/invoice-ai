/**
 * Fuel vendor API integration layer — core types.
 *
 * Each fuel vendor (EVO, WFS, Avfuel, etc.) gets an adapter that implements
 * FuelVendorAdapter. Vendors with no API fall through to the "manual" adapter
 * which just tracks releases in the DB and sends Slack notifications.
 */

export type VendorId = "evo" | "wfs" | "avfuel" | "manual";

export type ReleaseStatus =
  | "pending"     // submitted, awaiting vendor confirmation
  | "confirmed"   // vendor confirmed the release
  | "rejected"    // vendor rejected
  | "cancelled"   // we cancelled
  | "completed"   // fuel delivered
  | "failed";     // submission error

export interface VendorCapabilities {
  realTimePricing: boolean;
  submitRelease: boolean;
  checkReleaseStatus: boolean;
  cancelRelease: boolean;
}

// ─── Real-time pricing ───────────────────────────────────────────────────────

export interface RealTimePriceRequest {
  airport: string;       // ICAO code
  fbo: string | null;
  gallons: number;
  tailNumber?: string;
  date?: string;         // YYYY-MM-DD
}

export interface RealTimePriceResponse {
  price: number;         // per gallon USD
  vendor: string;
  fbo: string | null;
  validUntil?: string;   // ISO timestamp
  volumeTier?: string;
  raw?: unknown;
}

// ─── Fuel releases ───────────────────────────────────────────────────────────

export interface FuelReleaseRequest {
  airport: string;
  fbo: string;
  tailNumber: string;
  gallons: number;
  requestedPrice?: number;  // expected price/gal from contract
  date: string;             // YYYY-MM-DD
  notes?: string;
  submittedBy: string;
  submittedByEmail?: string;
  planLinkToken?: string;
  planLegIndex?: number;
}

export interface FuelReleaseResponse {
  success: boolean;
  releaseId?: string;
  vendorConfirmation?: string;
  status: ReleaseStatus;
  quotedPrice?: number;
  message?: string;
  raw?: unknown;
}

export interface FuelReleaseStatusResponse {
  status: ReleaseStatus;
  vendorConfirmation?: string;
  actualPrice?: number;
  actualGallons?: number;
  updatedAt: string;
  raw?: unknown;
}

// ─── DB row shape ────────────────────────────────────────────────────────────

export interface FuelReleaseRow {
  id: string;
  created_at: string;
  updated_at: string;
  submitted_by: string;
  submitted_by_email: string | null;
  tail_number: string;
  airport_code: string;
  fbo_name: string | null;
  departure_date: string;
  vendor_id: string;
  vendor_name: string;
  gallons_requested: number;
  quoted_price: number | null;
  actual_price: number | null;
  actual_gallons: number | null;
  status: ReleaseStatus;
  vendor_confirmation: string | null;
  status_history: Array<{ status: string; at: string; by: string; note?: string }>;
  plan_link_token: string | null;
  plan_leg_index: number | null;
  notes: string | null;
  cancellation_reason: string | null;
}

// ─── Adapter interface ───────────────────────────────────────────────────────

export interface FuelVendorAdapter {
  readonly vendorId: VendorId;
  readonly vendorName: string;
  readonly capabilities: VendorCapabilities;

  getRealTimePrice(req: RealTimePriceRequest): Promise<RealTimePriceResponse | null>;
  submitFuelRelease(req: FuelReleaseRequest): Promise<FuelReleaseResponse>;
  getFuelReleaseStatus(vendorConfirmation: string): Promise<FuelReleaseStatusResponse | null>;
  cancelFuelRelease(vendorConfirmation: string): Promise<{ success: boolean; message?: string }>;
}
