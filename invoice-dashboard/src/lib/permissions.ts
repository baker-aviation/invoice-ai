/**
 * Dashboard section permissions.
 *
 * Each section maps a key to the route prefix(es) it controls.
 * Admin users bypass all checks. Dashboard users with an empty or missing
 * permissions array get access to everything (backwards compatible).
 */

export const SECTIONS = [
  { key: "ops", label: "Ops", paths: ["/ops"] },
  { key: "invoices", label: "Invoices", paths: ["/invoices"] },
  { key: "alerts", label: "Alerts", paths: ["/alerts"] },
  { key: "fuel-prices", label: "Fuel Prices", paths: ["/fuel-prices"] },
  { key: "jobs", label: "Jobs", paths: ["/jobs"] },
  { key: "maintenance", label: "AOG Vans", paths: ["/maintenance"] },
  { key: "vehicles", label: "Vehicles", paths: ["/vehicles"] },
  { key: "fees", label: "Fees", paths: ["/fees"] },
] as const;

export type SectionKey = (typeof SECTIONS)[number]["key"];

export const ALL_SECTION_KEYS: SectionKey[] = SECTIONS.map((s) => s.key);

/**
 * Check if a user's permissions allow access to a given pathname.
 * Returns true if allowed.
 */
export function hasAccessToPath(
  permissions: string[] | undefined | null,
  pathname: string,
): boolean {
  // No permissions set = full access (backwards compatible)
  if (!permissions || permissions.length === 0) return true;

  // Home page is always accessible
  if (pathname === "/") return true;

  for (const section of SECTIONS) {
    if (section.paths.some((p) => pathname.startsWith(p))) {
      return permissions.includes(section.key);
    }
  }

  // Routes not in SECTIONS (e.g., /api, /login) are allowed
  return true;
}
