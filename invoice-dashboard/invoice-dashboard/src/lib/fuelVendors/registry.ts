/**
 * Vendor adapter registry.
 *
 * Maps vendor names (from VENDOR_ALIASES in fuelParsers.ts and from
 * trip_fuel_choices / advertised_prices tables) to the appropriate adapter.
 */

import type { FuelVendorAdapter, VendorId } from "./types";
import { EvoAdapter } from "./adapters/evo";
import { WfsAdapter } from "./adapters/wfs";
import { AvfuelAdapter } from "./adapters/avfuel";
import { EmailAdapter } from "./adapters/email";
import { ManualAdapter } from "./adapters/manual";

const adapters = new Map<VendorId, FuelVendorAdapter>();

function createAdapter(id: VendorId): FuelVendorAdapter {
  switch (id) {
    case "evo":    return new EvoAdapter();
    case "wfs":    return new WfsAdapter();
    case "avfuel": return new AvfuelAdapter();
    case "email":  return new EmailAdapter();
    case "manual": return new ManualAdapter();
  }
}

/** Get the adapter for a vendor ID. Adapters are singletons per process. */
export function getVendorAdapter(vendorId: VendorId): FuelVendorAdapter {
  let adapter = adapters.get(vendorId);
  if (!adapter) {
    adapter = createAdapter(vendorId);
    adapters.set(vendorId, adapter);
  }
  return adapter;
}

/**
 * Map a vendor name string (from CSV parsers, trip notes, or advertised prices)
 * to a VendorId. Falls back to "manual" for unknown vendors.
 *
 * When a release_type is provided from the fuel_vendors DB, use that to route
 * to the email adapter instead of the vendor-specific API stubs.
 */
export function resolveVendorId(vendorName: string, releaseType?: string): VendorId {
  // If we know the release type from the DB, route accordingly
  if (releaseType === "email") return "email";
  if (releaseType === "card") return "manual";

  // Legacy name-based resolution (for existing code paths)
  const lower = (vendorName ?? "").toLowerCase().trim();
  if (lower.includes("evo")) return "evo";
  if (lower.includes("world fuel") || lower === "wfs") return "wfs";
  if (lower.includes("avfuel")) return "avfuel";
  return "manual";
}
