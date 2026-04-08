import "server-only";
import { createServiceClient } from "@/lib/supabase/service";
import * as cheerio from "cheerio";
import type { EntitySyncResult } from "./types";

const BASE_URL = "https://portal.jetinsight.com";
const DELAY_MS = 1000;
const GCS_PREFIX = "jetinsight-docs";

const TRIP_DOC_TYPES = [
  "us_gen_dec_form",
  "crew",
  "passenger",
  "crew_declarations_form",
  "canpass_form",
  "cargo",
  "flight_pre",
] as const;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Sync documents + passenger names for a single international trip.
 */
export async function syncTripDocs(
  tripId: string,
  cookie: string,
): Promise<EntitySyncResult> {
  const result: EntitySyncResult = {
    entityType: "crew", // reuse type — will be overridden
    entityId: tripId,
    docsDownloaded: 0,
    docsSkipped: 0,
    errors: [],
  };

  const supa = createServiceClient();

  // Download trip document PDFs
  for (const docType of TRIP_DOC_TYPES) {
    // Check if already synced
    const docKey = `${docType}.pdf`;
    const { data: existing } = await supa
      .from("jetinsight_documents")
      .select("id")
      .eq("entity_type", "trip")
      .eq("entity_id", tripId)
      .eq("jetinsight_uuid", docType)
      .maybeSingle();

    if (existing) {
      result.docsSkipped++;
      continue;
    }

    await sleep(DELAY_MS);

    // Build download URL with all segments
    // We include segments 0-9 to cover any trip length
    const segParams = Array.from({ length: 10 }, (_, i) => `segments_to_load[]=${i}`).join("&");
    const url = `${BASE_URL}/trips/${tripId}/docs/${docKey}?exclude_segments_csl=&disposition=download&${segParams}`;

    try {
      const res = await fetch(url, {
        method: "GET",
        headers: {
          Cookie: cookie,
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Baker-Aviation-Sync/1.0",
        },
        signal: AbortSignal.timeout(30_000),
      });

      if (!res.ok) {
        // Some doc types may not exist for every trip (e.g., CANPASS for non-Canada trips)
        if (res.status === 404 || res.status === 422) {
          result.docsSkipped++;
          continue;
        }
        throw new Error(`HTTP ${res.status}`);
      }

      const contentType = res.headers.get("content-type") || "application/pdf";

      // Skip if response is HTML (error page, not a PDF)
      if (contentType.includes("text/html")) {
        result.docsSkipped++;
        continue;
      }

      const buffer = Buffer.from(await res.arrayBuffer());
      if (buffer.length < 100) {
        result.docsSkipped++;
        continue;
      }

      // Upload to GCS
      const { Storage } = await import("@google-cloud/storage");
      let storage: InstanceType<typeof Storage>;
      const b64Key = process.env.GCP_SERVICE_ACCOUNT_KEY;
      if (b64Key) {
        const creds = JSON.parse(Buffer.from(b64Key, "base64").toString("utf-8"));
        storage = new Storage({ credentials: creds, projectId: creds.project_id });
      } else {
        storage = new Storage();
      }

      const bucketName = process.env.GCS_BUCKET || "baker-aviation-invoice-pdfs";
      const gcsKey = `${GCS_PREFIX}/trips/${tripId}/${docType}.pdf`;

      await storage.bucket(bucketName).file(gcsKey).save(buffer, { contentType });

      // Store metadata
      await supa.from("jetinsight_documents").insert({
        entity_type: "trip",
        entity_id: tripId,
        jetinsight_uuid: docType,
        category: formatDocType(docType),
        document_name: `${docType}.pdf`,
        gcs_bucket: bucketName,
        gcs_key: gcsKey,
        size_bytes: buffer.length,
        content_type: contentType,
        jetinsight_url: url,
      });

      result.docsDownloaded++;
    } catch (err) {
      result.errors.push(
        `${docType}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Fetch passenger names
  await sleep(DELAY_MS);
  try {
    const paxRes = await fetch(`${BASE_URL}/trips/${tripId}/passengers`, {
      method: "GET",
      headers: {
        Cookie: cookie,
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Baker-Aviation-Sync/1.0",
      },
      signal: AbortSignal.timeout(30_000),
    });

    if (paxRes.ok) {
      const html = await paxRes.text();
      const names = extractPassengerNames(html);

      for (const name of names) {
        await supa.from("jetinsight_trip_passengers").upsert(
          {
            jetinsight_trip_id: tripId,
            passenger_name: name,
            synced_at: new Date().toISOString(),
          },
          { onConflict: "jetinsight_trip_id,passenger_name" },
        );
      }
    }
  } catch (err) {
    result.errors.push(
      `pax names: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Scrape eAPIS status
  await sleep(DELAY_MS);
  try {
    const eapisStatuses = await scrapeEapisStatus(tripId, cookie);
    if (eapisStatuses.length > 0) {
      // Update intl_trip that has this jetinsight_trip_id
      const { error: eapisErr } = await supa
        .from("intl_trips")
        .update({ eapis_status: eapisStatuses })
        .eq("jetinsight_trip_id", tripId);
      if (eapisErr) {
        result.errors.push(`eapis update: ${eapisErr.message}`);
      }
    }
  } catch (err) {
    result.errors.push(
      `eapis scrape: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return result;
}

// ---------------------------------------------------------------------------
// eAPIS status scraping
// ---------------------------------------------------------------------------

export type EapisLegStatus = {
  dep_icao: string;
  arr_icao: string;
  status: "approved" | "pending" | "not_filed";
  provider: "us" | "caricom";
};

/**
 * Scrape eAPIS status from the JetInsight trip eAPIS page.
 * Returns per-leg status for all segments found on the page.
 */
export async function scrapeEapisStatus(
  tripId: string,
  cookie: string,
): Promise<EapisLegStatus[]> {
  const res = await fetch(`${BASE_URL}/trips/${tripId}/eapis`, {
    method: "GET",
    headers: {
      Cookie: cookie,
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Baker-Aviation-Sync/1.0",
    },
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    if (res.status === 404 || res.status === 422) return [];
    throw new Error(`eAPIS page HTTP ${res.status}`);
  }

  const html = await res.text();
  const $ = cheerio.load(html);
  const legs: EapisLegStatus[] = [];

  // The page contains segments with departure/arrival info and status badges.
  // Look for segment blocks — they typically have departure and arrival airport codes
  // and a status indicator (text-success for approved, text-warning for pending).

  // Strategy 1: Look for segment rows/cards with DEPART/ARRIVE patterns
  // Common patterns: "DEPART OPF" / "ARRIVE TAPA" with status spans
  $("[class*=segment], .card, .panel, tr, .row, .leg, .eapis-leg, div").each((_i, el) => {
    const text = $(el).text();

    // Match "DEPART XXXX" and "ARRIVE XXXX" patterns (3-4 char ICAO/IATA codes)
    const depMatch = text.match(/DEPART\s+([A-Z]{3,4})/i);
    const arrMatch = text.match(/ARRIVE\s+([A-Z]{3,4})/i);

    if (!depMatch || !arrMatch) return;

    const dep_icao = depMatch[1].toUpperCase();
    const arr_icao = arrMatch[1].toUpperCase();

    // Already captured this leg?
    if (legs.some((l) => l.dep_icao === dep_icao && l.arr_icao === arr_icao)) return;

    // Determine status from text/class within this element
    let status: EapisLegStatus["status"] = "not_filed";
    const elHtml = $(el).html() ?? "";

    if (/approved/i.test(text) || /text-success/i.test(elHtml)) {
      status = "approved";
    } else if (/pending/i.test(text) || /text-warning/i.test(elHtml)) {
      status = "pending";
    }

    // Determine provider — CARICOM if mentioned, otherwise US
    let provider: EapisLegStatus["provider"] = "us";
    if (/caricom/i.test(text)) {
      provider = "caricom";
    }
    // Override with explicit provider text
    if (/US:/i.test(text)) provider = "us";
    if (/CARICOM:/i.test(text)) provider = "caricom";

    legs.push({ dep_icao, arr_icao, status, provider });
  });

  // Strategy 2: If no legs found, try parsing from status spans directly
  if (legs.length === 0) {
    // Look for spans/divs with status text like "US: Approved"
    const statusEls = $(".text-success, .text-warning, .text-danger, [class*=status]");
    const segmentTexts: string[] = [];

    // Collect text lines that mention airport route patterns.
    // Split by newline to avoid parent elements bleeding context across routes.
    const allText = $("body").text();
    const lines = allText.split(/\n/).map((l) => l.trim()).filter(Boolean);
    for (const line of lines) {
      if (/[A-Z]{3,4}\s*(?:→|->|to|—)\s*[A-Z]{3,4}/.test(line)) {
        segmentTexts.push(line);
      }
    }

    // Try to pair route patterns with status
    for (const seg of segmentTexts) {
      const routeMatch = seg.match(/([A-Z]{3,4})\s*(?:→|->|to|—)\s*([A-Z]{3,4})/);
      if (!routeMatch) continue;

      const dep_icao = routeMatch[1];
      const arr_icao = routeMatch[2];
      if (legs.some((l) => l.dep_icao === dep_icao && l.arr_icao === arr_icao)) continue;

      let status: EapisLegStatus["status"] = "not_filed";
      if (/approved/i.test(seg)) status = "approved";
      else if (/pending/i.test(seg)) status = "pending";

      let provider: EapisLegStatus["provider"] = "us";
      if (/caricom/i.test(seg)) provider = "caricom";

      legs.push({ dep_icao, arr_icao, status, provider });
    }

    // Strategy 3: If we have status elements but no route parsing worked,
    // check if the whole page has a single global status
    if (legs.length === 0 && statusEls.length > 0) {
      statusEls.each((_i, el) => {
        const statusText = $(el).text().trim();
        console.log(`[eAPIS] Found status element: "${statusText}"`);
      });
    }
  }

  return legs;
}

/**
 * Extract passenger names from the trip passengers page.
 * The page contains embedded JSON: passenger_data = [{name: "...", ...}, ...]
 */
function extractPassengerNames(html: string): string[] {
  const names: string[] = [];

  // Strategy 1: Use customs_docs_data — shows ONLY passengers assigned to flight segments
  const customsMatch = html.match(/customs_docs_data\s*=\s*(\{[\s\S]*?\});/);
  if (customsMatch) {
    try {
      const customsData = JSON.parse(customsMatch[1]) as Record<string, Record<string, unknown>>;
      const paxIds = new Set<string>();
      for (const segment of Object.values(customsData)) {
        for (const paxId of Object.keys(segment)) paxIds.add(paxId);
      }
      if (paxIds.size > 0) {
        const paxMatch = html.match(/passenger_data\s*=\s*(\[[\s\S]*?\]);/);
        if (paxMatch) {
          const paxData = JSON.parse(paxMatch[1]) as Array<{ name: string; id: string }>;
          for (const p of paxData) {
            if (paxIds.has(p.id) && p.name?.trim()) names.push(p.name.trim());
          }
          if (names.length > 0) return [...new Set(names)];
        }
      }
    } catch { /* fall through */ }
  }

  // Strategy 2: Parse passenger_data with is_allocated filter
  const jsonMatch = html.match(/passenger_data\s*=\s*(\[[\s\S]*?\]);/);
  if (jsonMatch) {
    try {
      const paxData = JSON.parse(jsonMatch[1]) as Array<{
        name: string;
        is_allocated: boolean;
      }>;

      const allocated = paxData.filter((p) => p.is_allocated);
      if (allocated.length > 0) {
        for (const p of allocated) {
          if (p.name?.trim()) names.push(p.name.trim());
        }
        return [...new Set(names)];
      }

      if (paxData.length <= 12) {
        for (const p of paxData) {
          if (p.name?.trim()) names.push(p.name.trim());
        }
        return [...new Set(names)];
      }

      return [];
    } catch { /* fall through */ }
  }

  // Fallback: parse HTML table
  const $ = cheerio.load(html);
  $("td").each((_i, el) => {
    const text = $(el).text().trim();
    // Look for cells that look like names (2+ words, no numbers, reasonable length)
    if (
      text.length > 3 &&
      text.length < 60 &&
      text.includes(" ") &&
      !text.match(/\d{2}\/\d{2}/) && // not a date
      !text.match(/^\d/) // not starting with a number
    ) {
      names.push(text);
    }
  });

  return [...new Set(names)];
}

/**
 * Format doc type slug to human-readable category name.
 */
function formatDocType(docType: string): string {
  const map: Record<string, string> = {
    us_gen_dec_form: "US General Declaration",
    crew: "Crew Manifest",
    passenger: "Passenger Manifest",
    crew_declarations_form: "Crew Declarations",
    canpass_form: "CANPASS Form",
    cargo: "Cargo Manifest",
    flight_pre: "Pre-Flight Release",
  };
  return map[docType] ?? docType;
}
