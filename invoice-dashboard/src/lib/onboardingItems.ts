/**
 * Onboarding checklist item definitions for pilot profiles.
 * Items with required_for: "all" apply to both PIC and SIC.
 * Items with required_for: "pic_only" are additional PIC requirements.
 */

export type OnboardingItemDef = {
  key: string;
  label: string;
  required_for: "all" | "pic_only";
};

/** SIC items — required for all pilots */
const SIC_ITEMS: OnboardingItemDef[] = [
  { key: "indoc", label: "INDOC", required_for: "all" },
  { key: "egress", label: "Egress Training", required_for: "all" },
  { key: "cts", label: "CTS Training", required_for: "all" },
  { key: "alcohol", label: "Alcohol Program", required_for: "all" },
  { key: "doc_ids", label: "ID Review", required_for: "all" },
  { key: "doc_passport", label: "Passport Review", required_for: "all" },
  { key: "doc_medical", label: "Medical Review", required_for: "all" },
  { key: "doc_certs", label: "Pilot Certificates Review", required_for: "all" },
];

/** PIC-only items — in addition to all SIC items */
const PIC_ONLY_ITEMS: OnboardingItemDef[] = [
  { key: "item_299", label: "299", required_for: "pic_only" },
  { key: "item_293", label: "293", required_for: "pic_only" },
  { key: "coe_checkout", label: "COE Checkout", required_for: "pic_only" },
];

/** All defined onboarding items */
export const ALL_ONBOARDING_ITEMS: OnboardingItemDef[] = [
  ...SIC_ITEMS,
  ...PIC_ONLY_ITEMS,
];

/** Returns the onboarding items applicable for a given role */
export function getItemsForRole(role: "PIC" | "SIC"): OnboardingItemDef[] {
  if (role === "PIC") return ALL_ONBOARDING_ITEMS;
  return SIC_ITEMS;
}
