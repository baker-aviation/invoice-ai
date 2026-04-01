import * as cheerio from "cheerio";
import type { CrewEntry, DocEntry } from "./types";

const BASE = "https://portal.jetinsight.com";

/**
 * Parse the crew index page at /compliance/documents/{org_uuid}/crew
 * Returns list of crew members with their UUIDs, emails, and phones.
 */
export function parseCrewIndex(html: string): CrewEntry[] {
  const $ = cheerio.load(html);
  const crew: CrewEntry[] = [];

  // The page has a table with columns: Name, Email, Cell, Schedule color
  $("table tr").each((_i, row) => {
    const cells = $(row).find("td");
    if (cells.length < 2) return; // skip header or malformed rows

    const nameLink = cells.eq(0).find("a");
    const name = nameLink.text().trim();
    if (!name) return;

    // Extract UUID from link href: /compliance/documents/{uuid}/crew
    const href = nameLink.attr("href") ?? "";
    const uuidMatch = href.match(
      /\/compliance\/documents\/([0-9a-f-]{36})\/crew/i,
    );
    if (!uuidMatch) return;

    const uuid = uuidMatch[1];
    const email = cells.eq(1).text().trim() || undefined;
    const phone = cells.eq(2).text().trim() || undefined;

    crew.push({ name, uuid, email, phone });
  });

  return crew;
}

/**
 * Parse a crew member's document page at /compliance/documents/{uuid}/crew
 * Returns all documents with their check categories and download links.
 */
export function parseCrewDocPage(html: string, pilotUuid: string): DocEntry[] {
  const $ = cheerio.load(html);
  const docs: DocEntry[] = [];

  // --- Section 1: "Documents from Pilot checks" ---
  // Each check is a row with: "Pilot check: <category link>" header
  // followed by document rows with filename link + "Uploaded on: date" + download icon

  // Find all pilot check category sections
  $("*").each((_i, el) => {
    const text = $(el).text().trim();

    // Match "Pilot check: Category Name" pattern
    const checkMatch = text.match(/^Pilot check:\s*(.+)$/);
    if (!checkMatch) return;

    const rawCategory = checkMatch[1].trim();

    // Parse category into parts
    const { category, subcategory, aircraftType } =
      parsePilotCheckCategory(rawCategory);

    // Look for document links within this section's parent/sibling context
    const container = $(el).closest("div, tr, li, section");

    container.find("a").each((_j, link) => {
      const href = $(link).attr("href") ?? "";
      // Match download links: /compliance/crew_checks/{uuid}/show_doc?...
      const checkUuidMatch = href.match(
        /\/compliance\/crew_checks\/([0-9a-f-]{36})\/show_doc/i,
      );
      if (!checkUuidMatch) return;

      const filename = $(link).text().trim();
      if (!filename) return;

      // Look for uploaded date in siblings
      let uploadedOn: string | undefined;
      const parentRow = $(link).closest("div, tr, li");
      const dateMatch = parentRow
        .text()
        .match(/Uploaded on:\s*(\d{2}\/\d{2}\/\d{4})/);
      if (dateMatch) uploadedOn = dateMatch[1];

      // Build full download URL
      const downloadUrl = href.startsWith("http")
        ? href
        : `${BASE}${href}${href.includes("disposition=download") ? "" : (href.includes("?") ? "&" : "?") + "disposition=download"}`;

      docs.push({
        category,
        subcategory,
        aircraftType,
        checkUuid: checkUuidMatch[1],
        filename,
        downloadUrl,
        uploadedOn,
      });
    });
  });

  // --- Section 2: Top-level document categories (PRD, Passport, etc.) ---
  // These have a different structure — category headers with document rows below

  // Find download links that are NOT pilot checks (different URL pattern)
  // /compliance/documents/{uuid}?...&disposition=download
  $("a").each((_i, link) => {
    const href = $(link).attr("href") ?? "";
    const docUuidMatch = href.match(
      /\/compliance\/documents\/([0-9a-f-]{36})\?/i,
    );
    if (!docUuidMatch) return;

    // Skip if this UUID is the pilot's own UUID (that's the page link, not a doc)
    if (docUuidMatch[1] === pilotUuid) return;

    const filename = $(link).text().trim();
    if (!filename) return;

    // Find the category from the nearest heading/section
    let category = "Other";
    const parentSection = $(link).closest("div, tr, li, section");
    const sectionText = parentSection.parent().find("h3, h4, strong").first().text().trim();
    if (sectionText) category = sectionText;

    let uploadedOn: string | undefined;
    const dateMatch = parentSection
      .text()
      .match(/Uploaded on:\s*(\d{2}\/\d{2}\/\d{4})/);
    if (dateMatch) uploadedOn = dateMatch[1];

    let versionLabel: string | undefined;
    const versionMatch = parentSection
      .text()
      .match(/Version:\s*([^\s]+)/);
    if (versionMatch) versionLabel = versionMatch[1];

    const downloadUrl = href.startsWith("http")
      ? href
      : `${BASE}${href}${href.includes("disposition=download") ? "" : (href.includes("?") ? "&" : "?") + "disposition=download"}`;

    docs.push({
      category,
      checkUuid: docUuidMatch[1],
      filename,
      downloadUrl,
      uploadedOn,
      versionLabel,
    });
  });

  // Deduplicate by checkUuid
  const seen = new Set<string>();
  return docs.filter((d) => {
    if (seen.has(d.checkUuid)) return false;
    seen.add(d.checkUuid);
    return true;
  });
}

/**
 * Parse an aircraft document page at /compliance/documents/{tail}/aircraft
 * Returns all documents with their categories and download links.
 */
export function parseAircraftDocPage(html: string): DocEntry[] {
  const $ = cheerio.load(html);
  const docs: DocEntry[] = [];
  const seen = new Set<string>();

  // Aircraft docs have category sections (Airworthiness certificate, Insurance, etc.)
  // with document rows containing download links

  // Find all download links
  $("a").each((_i, link) => {
    const href = $(link).attr("href") ?? "";

    // Match: /compliance/documents/{uuid}?base_item_id=...&category=aircraft&disposition=download
    const docUuidMatch = href.match(
      /\/compliance\/documents\/([0-9a-f-]{36})\?/i,
    );
    if (!docUuidMatch) return;
    if (!href.includes("category=aircraft") && !href.includes("disposition=download")) return;

    const uuid = docUuidMatch[1];
    if (seen.has(uuid)) return;
    seen.add(uuid);

    const filename = $(link).text().trim();
    if (!filename) return;

    // Find category from nearest section heading
    let category = "Other";
    const parentRow = $(link).closest("div, tr, li, section");

    // Walk up to find the category heading
    let prev = parentRow.prev();
    while (prev.length) {
      const heading = prev.find("h3, h4, strong").text().trim() || prev.text().trim();
      if (heading && !heading.includes("Uploaded on") && !heading.includes("Version")) {
        // Check if this looks like a category name (not a document name)
        if (heading.match(/\(\d+\)/) || heading.match(/certificate|insurance|manual|checklist|other/i)) {
          category = heading.replace(/\s*\(\d+\)\s*$/, "").trim();
          break;
        }
      }
      prev = prev.prev();
    }

    let uploadedOn: string | undefined;
    const dateMatch = parentRow
      .text()
      .match(/Uploaded on:\s*(\d{2}\/\d{2}\/\d{4})/);
    if (dateMatch) uploadedOn = dateMatch[1];

    let versionLabel: string | undefined;
    const versionMatch = parentRow
      .text()
      .match(/Version:\s*([^\s]+)/);
    if (versionMatch) versionLabel = versionMatch[1];

    const downloadUrl = href.startsWith("http")
      ? href
      : `${BASE}${href}`;

    docs.push({
      category,
      checkUuid: uuid,
      filename,
      downloadUrl,
      uploadedOn,
      versionLabel,
    });
  });

  return docs;
}

/**
 * Parse a pilot check category string into structured parts.
 * Examples:
 *   "Medical - 1st class (under 40)" → { category: "Medical", subcategory: "1st class (under 40)" }
 *   "Simulator / checkride - 135.293(b) for CL-30" → { category: "Simulator / checkride - 135.293(b)", aircraftType: "CL-30" }
 *   "Ground / oral, aircraft specific - 135.293(a)(2-3) for CL-30" → { category: "Ground / oral, aircraft specific - 135.293(a)(2-3)", aircraftType: "CL-30" }
 */
function parsePilotCheckCategory(raw: string): {
  category: string;
  subcategory?: string;
  aircraftType?: string;
} {
  // Check for "for {aircraft_type}" suffix
  let aircraftType: string | undefined;
  const forMatch = raw.match(/\s+for\s+(.+)$/i);
  if (forMatch) {
    aircraftType = forMatch[1].trim();
    raw = raw.replace(/\s+for\s+.+$/i, "").trim();
  }

  // Check for medical subcategories: "Medical - 1st class (under 40)"
  const medicalMatch = raw.match(
    /^(Medical)\s*-\s*(.+)$/i,
  );
  if (medicalMatch) {
    return {
      category: medicalMatch[1],
      subcategory: medicalMatch[2].trim(),
      aircraftType,
    };
  }

  return { category: raw, aircraftType };
}

/**
 * Check if an HTML response is a login redirect (session expired).
 */
export function isLoginRedirect(html: string): boolean {
  // JetInsight redirects to login page with sign_in form
  return (
    html.includes("sign_in") ||
    html.includes("Forgot your password") ||
    html.includes("recaptcha")
  );
}
