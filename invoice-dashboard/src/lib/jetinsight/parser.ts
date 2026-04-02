import * as cheerio from "cheerio";
import type { CrewEntry, DocEntry } from "./types";

const BASE = "https://portal.jetinsight.com";

/**
 * Parse the crew index page at /compliance/documents/crew
 * Returns list of crew members with their UUIDs, emails, and phones.
 */
export function parseCrewIndex(html: string): CrewEntry[] {
  const $ = cheerio.load(html);
  const crew: CrewEntry[] = [];
  const seen = new Set<string>();

  // The page has a table with columns: Name, Email, Cell, Schedule color
  // Each name is a link: /compliance/documents/{uuid}/crew
  $("a").each((_i, link) => {
    const href = $(link).attr("href") ?? "";
    const uuidMatch = href.match(
      /\/compliance\/documents\/([0-9a-f-]{36})\/crew$/i,
    );
    if (!uuidMatch) return;

    const uuid = uuidMatch[1];
    if (seen.has(uuid)) return;
    seen.add(uuid);

    const name = $(link).text().trim();
    if (!name) return;

    // Try to find email and phone in sibling table cells
    const row = $(link).closest("tr");
    let email: string | undefined;
    let phone: string | undefined;

    if (row.length) {
      const cells = row.find("td");
      cells.each((_j, cell) => {
        const text = $(cell).text().trim();
        if (text.includes("@") && !email) email = text;
        else if (text.match(/^\d{3}[-.]?\d{3}[-.]?\d{4}$/) && !phone)
          phone = text;
      });
    }

    crew.push({ name, uuid, email, phone });
  });

  return crew;
}

/**
 * Parse a crew member's document page at /compliance/documents/{uuid}/crew
 * Returns all documents with their check categories and download links.
 *
 * JetInsight uses Bootstrap panels:
 *   <div class="panel panel-default">
 *     <div class="panel-heading">Pilot check: <a>Category Name</a></div>
 *     <div class="panel-body">
 *       <table><tbody><tr>
 *         <td><a href="/compliance/crew_checks/{uuid}/show_doc?user={user_uuid}">Filename</a></td>
 *         <td><i>Uploaded on: MM/DD/YYYY</i></td>
 *         <td><a href="/compliance/crew_checks/{uuid}/show_doc?disposition=download&user={user_uuid}"><i class="fa fa-download"></i></a></td>
 *       </tr></tbody></table>
 *     </div>
 *   </div>
 */
export function parseCrewDocPage(html: string): DocEntry[] {
  const $ = cheerio.load(html);
  const docs: DocEntry[] = [];
  const seen = new Set<string>();

  // Find all panels with "Pilot check:" in the heading
  $(".panel").each((_i, panel) => {
    const heading = $(panel).find(".panel-heading").first();
    const headingText = heading.text().trim();

    // Extract category from "Pilot check: Category Name" or top-level categories
    let rawCategory: string;
    const checkMatch = headingText.match(/^Pilot check:\s*(.+)/);
    if (checkMatch) {
      rawCategory = checkMatch[1].trim();
    } else {
      // Top-level document category (PRD, Passport, etc.)
      rawCategory = headingText.replace(/\s*\(\d+\)\s*$/, "").trim();
      if (!rawCategory || rawCategory === "No documents") return;
    }

    // Check for "for {aircraft_type}" suffix in heading
    const { category, subcategory, aircraftType } =
      parsePilotCheckCategory(rawCategory);

    // Find download links within this panel
    $(panel)
      .find('a[href*="/show_doc"], a[href*="disposition=download"]')
      .each((_j, link) => {
        const href = $(link).attr("href") ?? "";

        // Skip download icon links (they duplicate the file link)
        // We want the one with the filename text, not the <i class="fa fa-download">
        const linkText = $(link).text().trim();
        if (!linkText || linkText.length < 2) return;

        // Extract check UUID from the URL
        const checkUuidMatch = href.match(
          /\/crew_checks\/([0-9a-f-]{36})\/show_doc/i,
        );
        if (!checkUuidMatch) return;

        const checkUuid = checkUuidMatch[1];
        if (seen.has(checkUuid)) return;
        seen.add(checkUuid);

        // Find uploaded date in the same table row
        let uploadedOn: string | undefined;
        const row = $(link).closest("tr");
        const dateMatch = row
          .text()
          .match(/Uploaded on:\s*(\d{2}\/\d{2}\/\d{4})/);
        if (dateMatch) uploadedOn = dateMatch[1];

        // Build download URL (add disposition=download if not present)
        let downloadUrl = href;
        if (!downloadUrl.includes("disposition=download")) {
          downloadUrl +=
            (downloadUrl.includes("?") ? "&" : "?") + "disposition=download";
        }
        if (!downloadUrl.startsWith("http")) {
          downloadUrl = `${BASE}${downloadUrl}`;
        }

        docs.push({
          category,
          subcategory,
          aircraftType,
          checkUuid,
          filename: linkText,
          downloadUrl,
          uploadedOn,
        });
      });

    // Also check for document links (non-crew_checks pattern)
    // These are top-level document categories like PRD, Passport, etc.
    $(panel)
      .find('a[href*="/compliance/documents/"]')
      .each((_j, link) => {
        const href = $(link).attr("href") ?? "";
        const docUuidMatch = href.match(
          /\/compliance\/documents\/([0-9a-f-]{36})\?/i,
        );
        if (!docUuidMatch) return;

        const uuid = docUuidMatch[1];
        if (seen.has(uuid)) return;

        const linkText = $(link).text().trim();
        if (!linkText || linkText.length < 2) return;

        seen.add(uuid);

        let uploadedOn: string | undefined;
        const row = $(link).closest("tr");
        const dateMatch = row
          .text()
          .match(/Uploaded on:\s*(\d{2}\/\d{2}\/\d{4})/);
        if (dateMatch) uploadedOn = dateMatch[1];

        let versionLabel: string | undefined;
        const versionMatch = row.text().match(/Version:\s*([^\s]+)/);
        if (versionMatch) versionLabel = versionMatch[1];

        let downloadUrl = href;
        if (!downloadUrl.includes("disposition=download")) {
          downloadUrl +=
            (downloadUrl.includes("?") ? "&" : "?") + "disposition=download";
        }
        if (!downloadUrl.startsWith("http")) {
          downloadUrl = `${BASE}${downloadUrl}`;
        }

        docs.push({
          category,
          checkUuid: uuid,
          filename: linkText,
          downloadUrl,
          uploadedOn,
          versionLabel,
        });
      });
  });

  return docs;
}

/**
 * Parse an aircraft document page at /compliance/documents/{tail}/aircraft
 * Returns all documents with their categories and download links.
 *
 * Similar panel structure to crew docs but with different URL patterns:
 *   <a href="/compliance/documents/{uuid}?base_item_id={tail}&category=aircraft&disposition=download">
 */
export function parseAircraftDocPage(html: string): DocEntry[] {
  const $ = cheerio.load(html);
  const docs: DocEntry[] = [];
  const seen = new Set<string>();

  $(".panel").each((_i, panel) => {
    const heading = $(panel).find(".panel-heading").first();
    const headingText = heading.text().trim();

    // Get category name (strip count like "(2)")
    let category = headingText
      .replace(/\s*\(\d+\)\s*$/, "")
      .replace(/No documents.*$/, "")
      .trim();
    if (!category) category = "Other";

    // Find download links
    $(panel)
      .find("a")
      .each((_j, link) => {
        const href = $(link).attr("href") ?? "";
        const linkText = $(link).text().trim();

        // Match document UUID links
        const docUuidMatch = href.match(
          /\/compliance\/documents\/([0-9a-f-]{36})\?/i,
        );
        if (!docUuidMatch) return;

        const uuid = docUuidMatch[1];
        if (seen.has(uuid)) return;
        if (!linkText || linkText.length < 2) return;

        seen.add(uuid);

        // Clean up filename — strip "Edit all versions Category: " prefix from JetInsight UI
        const cleanedFilename = linkText
          .replace(/^Edit all versions\s*/i, "")
          .replace(/^[^:]+:\s*/, "")
          .trim() || linkText;

        let uploadedOn: string | undefined;
        const row = $(link).closest("tr");
        const dateMatch = row
          .text()
          .match(/Uploaded on:\s*(\d{2}\/\d{2}\/\d{4})/);
        if (dateMatch) uploadedOn = dateMatch[1];

        let versionLabel: string | undefined;
        const versionMatch = row.text().match(/Version:\s*([^\s]+)/);
        if (versionMatch) versionLabel = versionMatch[1];

        let downloadUrl = href;
        if (!downloadUrl.includes("disposition=download")) {
          downloadUrl +=
            (downloadUrl.includes("?") ? "&" : "?") + "disposition=download";
        }
        if (!downloadUrl.startsWith("http")) {
          downloadUrl = `${BASE}${downloadUrl}`;
        }

        docs.push({
          category,
          checkUuid: uuid,
          filename: cleanedFilename,
          downloadUrl,
          uploadedOn,
          versionLabel,
        });
      });
  });

  return docs;
}

/**
 * Parse a pilot check category string into structured parts.
 * Examples:
 *   "Medical - 1st class (under 40)" → { category: "Medical", subcategory: "1st class (under 40)" }
 *   "Simulator / checkride - 135.293(b) for CL-30" → { category: "Simulator / checkride - 135.293(b)", aircraftType: "CL-30" }
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
  const medicalMatch = raw.match(/^(Medical)\s*-\s*(.+)$/i);
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
  return (
    html.includes("sign_in") &&
    (html.includes("Forgot your password") || html.includes("recaptcha"))
  );
}
