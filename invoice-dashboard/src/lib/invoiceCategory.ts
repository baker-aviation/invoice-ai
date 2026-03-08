// Shared invoice category inference — used by both list and detail pages.

export type InvoiceCategory =
  | "FBO"
  | "Fuel Contract"
  | "Electronic Funds Transfer"
  | "Maintenance/Parts"
  | "Lease/Utilities"
  | "Plane Lease"
  | "Pilot Operations"
  | "Training"
  | "Subscriptions"
  | "Not an Invoice"
  | "Other";

export const ALL_CATEGORIES: InvoiceCategory[] = [
  "FBO",
  "Fuel Contract",
  "Electronic Funds Transfer",
  "Maintenance/Parts",
  "Lease/Utilities",
  "Plane Lease",
  "Pilot Operations",
  "Training",
  "Subscriptions",
  "Not an Invoice",
  "Other",
];

// Direct mapping from backend doc_type values → frontend categories
const DOC_TYPE_MAP: Record<string, InvoiceCategory> = {
  fbo_fee: "FBO",
  fuel_release: "Fuel Contract",
  fuel_contract: "Fuel Contract",
  maintenance: "Maintenance/Parts",
  parts: "Maintenance/Parts",
  lease_utility: "Lease/Utilities",
  plane_lease: "Plane Lease",
  pilot_operations: "Pilot Operations",
  training: "Training",
  subscriptions: "Subscriptions",
  eft: "Electronic Funds Transfer",
  eft_prenotification: "Electronic Funds Transfer",
  not_invoice: "Not an Invoice",
};

// Known fuel contract vendors — bulk/contract fuel pricing invoices
const KNOWN_FUEL_VENDORS = [
  "avfuel", "world fuel", "everest fuel", "epic aviation", "titan aviation fuels",
  "avflight",
];

// Known FBO vendor names — handling fees, ramp, GPU, landing fees etc.
const KNOWN_FBO_VENDORS = [
  "sheltair", "atlantic aviation", "signature flight", "million air",
  "jet aviation", "wilson air", "ross aviation", "clay lacy", "cutter aviation",
  "pentastar", "xjet", "priester", "azorra",
];

// Keyword lists for fallback classification
const FUEL_KEYWORDS = ["fuel", "avfuel", "jet a", "jet-a", "avgas", "gallons", "fueling", "fsii", "prist", "flowage", "fuel purchase", "fuel release"];
const FBO_KEYWORDS = ["fbo", "handling", "gpu", "lav", "de-ice", "catering", "landing fee", "ramp", "after hours", "overtime", "customs", "parking", "hangar fee", "towing", "ground power"];
const MAINT_KEYWORDS = ["maintenance", "maint", "avionics", "parts", "repair", "overhaul", "aog", "mx ", "inspection", "mechanic", "technician", "service center", "jet support", "duncan", "standardaero", "west star", "elliott", "turbine", "propeller", "engine shop", "work order", "component", "mro"];
const LEASE_KEYWORDS = ["lease", "rent", "hangar rent", "utilities", "management fee", "charter management", "aircraft management", "insurance", "property"];
const PLANE_LEASE_KEYWORDS = ["aircraft lease", "plane lease", "dry lease", "wet lease", "aircraft rental", "monthly lease", "lease agreement"];
const PILOT_OPS_KEYWORDS = ["prod support", "product support", "jeppesen", "foreflight", "charts", "bombardier", "gulfstream", "dassault", "pilot supplies", "crew supplies", "smart parts"];
const TRAINING_KEYWORDS = ["training", "simulator", "type rating", "flightsafety", "flight safety", "simcom", "cae", "recurrent", "initial training", "ground school"];
const SUBS_KEYWORDS = ["starlink", "subscription", "monthly service", "recurring", "satcom", "internet service", "connectivity", "wifi", "software license"];
const EFT_KEYWORDS = ["electronic funds transfer", "eft prenotification", "eft transfer", "funds transfer", "payment to be transferred", "prenotification only"];
const NOT_INVOICE_KEYWORDS = ["noise violation", "curfew violation", "noise abatement", "noise complaint", "voluntary nighttime"];

export function inferCategory(inv: {
  category_override?: string | null;
  category?: string;
  doc_type?: string | null;
  vendor_name?: string | null;
  line_items?: { description?: string }[];
  learned_category?: string | null;
}): InvoiceCategory {
  // 0. Use explicit user override (highest priority)
  if (inv.category_override) return inv.category_override as InvoiceCategory;
  // 1. Use learned category from vendor rules (user taught the system)
  if (inv.learned_category) return inv.learned_category as InvoiceCategory;
  // 2. Use explicit category if the DB ever provides one
  if (inv.category) return inv.category as InvoiceCategory;
  // 3. Map from backend doc_type
  const mapped = inv.doc_type ? DOC_TYPE_MAP[inv.doc_type] : undefined;
  if (mapped) return mapped;
  // 4. EFT check — must come before vendor name checks because fuel vendors
  //    like Avfuel send both regular invoices and EFT prenotifications
  const hay = [inv.vendor_name, inv.doc_type, ...(inv.line_items?.map((l) => l.description) ?? [])]
    .join(" ")
    .toLowerCase();
  if (EFT_KEYWORDS.some((k) => hay.includes(k))) return "Electronic Funds Transfer";
  // 5. Known vendor name checks — fuel vendors first, then FBO
  const vn = (inv.vendor_name ?? "").toLowerCase();
  if (KNOWN_FUEL_VENDORS.some((k) => vn.includes(k))) return "Fuel Contract";
  if (KNOWN_FBO_VENDORS.some((k) => vn.includes(k))) return "FBO";
  // 6. Keyword fallback for doc_type="other" or missing
  if (NOT_INVOICE_KEYWORDS.some((k) => hay.includes(k))) return "Not an Invoice";
  if (SUBS_KEYWORDS.some((k) => hay.includes(k))) return "Subscriptions";
  if (TRAINING_KEYWORDS.some((k) => hay.includes(k))) return "Training";
  if (PILOT_OPS_KEYWORDS.some((k) => hay.includes(k))) return "Pilot Operations";
  if (MAINT_KEYWORDS.some((k) => hay.includes(k))) return "Maintenance/Parts";
  if (PLANE_LEASE_KEYWORDS.some((k) => hay.includes(k))) return "Plane Lease";
  if (LEASE_KEYWORDS.some((k) => hay.includes(k))) return "Lease/Utilities";
  if (FUEL_KEYWORDS.some((k) => hay.includes(k))) return "Fuel Contract";
  if (FBO_KEYWORDS.some((k) => hay.includes(k))) return "FBO";
  return "Other";
}

export const CATEGORY_COLORS: Record<InvoiceCategory, string> = {
  "FBO": "bg-blue-100 text-blue-700",
  "Fuel Contract": "bg-sky-100 text-sky-700",
  "Electronic Funds Transfer": "bg-emerald-100 text-emerald-700",
  "Maintenance/Parts": "bg-amber-100 text-amber-700",
  "Lease/Utilities": "bg-purple-100 text-purple-700",
  "Plane Lease": "bg-violet-100 text-violet-700",
  "Pilot Operations": "bg-teal-100 text-teal-700",
  "Training": "bg-cyan-100 text-cyan-700",
  "Subscriptions": "bg-indigo-100 text-indigo-700",
  "Not an Invoice": "bg-red-100 text-red-600",
  "Other": "bg-gray-100 text-gray-600",
};
