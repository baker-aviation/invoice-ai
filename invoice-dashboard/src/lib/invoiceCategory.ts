// Shared invoice category inference — used by both list and detail pages.

export type InvoiceCategory =
  | "FBO/Fuel"
  | "Maintenance/Parts"
  | "Lease/Utilities"
  | "Pilot Operations"
  | "Subscriptions"
  | "Other";

// Direct mapping from backend doc_type values → frontend categories
const DOC_TYPE_MAP: Record<string, InvoiceCategory> = {
  fuel_release: "FBO/Fuel",
  fbo_fee: "FBO/Fuel",
  maintenance: "Maintenance/Parts",
  parts: "Maintenance/Parts",
  lease_utility: "Lease/Utilities",
  pilot_operations: "Pilot Operations",
  subscriptions: "Subscriptions",
};

// Keyword fallback for invoices with doc_type="other" or legacy rows
const FBO_KEYWORDS = ["fbo", "fuel", "avfuel", "signature", "jet aviation", "million air", "atlantic", "sheltair", "wilson air", "world fuel", "avjet", "handling", "gpu", "lav", "de-ice", "catering", "landing fee", "ramp", "jet a", "jet-a", "avgas", "gallons", "fueling", "fsii", "prist", "azorra", "flowage"];
const MAINT_KEYWORDS = ["maintenance", "maint", "avionics", "parts", "repair", "overhaul", "aog", "mx ", "inspection", "mechanic", "technician", "service center", "jet support", "duncan", "standardaero", "west star", "elliott", "turbine", "propeller", "engine shop", "work order", "component", "mro"];
const LEASE_KEYWORDS = ["lease", "rent", "hangar rent", "utilities", "management fee", "charter management", "aircraft management", "insurance", "property"];
const PILOT_OPS_KEYWORDS = ["prod support", "product support", "training", "simulator", "type rating", "jeppesen", "foreflight", "charts", "bombardier", "gulfstream", "dassault", "pilot supplies", "crew supplies", "smart parts"];
const SUBS_KEYWORDS = ["starlink", "subscription", "monthly service", "recurring", "satcom", "internet service", "connectivity", "wifi", "software license"];

// Known FBO/fuel vendor names — checked before keyword fallback so that
// fuel invoices with stray maintenance-like words still classify correctly.
const KNOWN_FBO_VENDORS = ["avfuel", "world fuel", "sheltair", "atlantic aviation", "signature flight", "million air", "jet aviation", "wilson air", "ross aviation", "clay lacy", "cutter aviation", "pentastar", "xjet", "priester", "azorra"];

export function inferCategory(inv: {
  category?: string;
  doc_type?: string | null;
  vendor_name?: string | null;
  line_items?: { description?: string }[];
}): InvoiceCategory {
  // 1. Use explicit category if the DB ever provides one
  if (inv.category) return inv.category as InvoiceCategory;
  // 2. Map from backend doc_type
  const mapped = inv.doc_type ? DOC_TYPE_MAP[inv.doc_type] : undefined;
  if (mapped) return mapped;
  // 3. Known FBO vendor name — takes priority over keyword matching
  const vn = (inv.vendor_name ?? "").toLowerCase();
  if (KNOWN_FBO_VENDORS.some((k) => vn.includes(k))) return "FBO/Fuel";
  // 4. Keyword fallback for doc_type="other" or missing
  const hay = [inv.vendor_name, inv.doc_type, ...(inv.line_items?.map((l) => l.description) ?? [])]
    .join(" ")
    .toLowerCase();
  if (SUBS_KEYWORDS.some((k) => hay.includes(k))) return "Subscriptions";
  if (PILOT_OPS_KEYWORDS.some((k) => hay.includes(k))) return "Pilot Operations";
  if (MAINT_KEYWORDS.some((k) => hay.includes(k))) return "Maintenance/Parts";
  if (LEASE_KEYWORDS.some((k) => hay.includes(k))) return "Lease/Utilities";
  if (FBO_KEYWORDS.some((k) => hay.includes(k))) return "FBO/Fuel";
  return "Other";
}

export const CATEGORY_COLORS: Record<InvoiceCategory, string> = {
  "FBO/Fuel": "bg-blue-100 text-blue-700",
  "Maintenance/Parts": "bg-amber-100 text-amber-700",
  "Lease/Utilities": "bg-purple-100 text-purple-700",
  "Pilot Operations": "bg-teal-100 text-teal-700",
  "Subscriptions": "bg-indigo-100 text-indigo-700",
  "Other": "bg-gray-100 text-gray-600",
};
