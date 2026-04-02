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

  return result;
}

/**
 * Extract passenger names from the trip passengers page.
 * The page contains embedded JSON: passenger_data = [{name: "...", ...}, ...]
 */
function extractPassengerNames(html: string): string[] {
  const names: string[] = [];

  // Try parsing the embedded passenger_data JSON
  const jsonMatch = html.match(/passenger_data\s*=\s*(\[[\s\S]*?\]);/);
  if (jsonMatch) {
    try {
      const paxData = JSON.parse(jsonMatch[1]) as Array<{ name: string }>;
      for (const p of paxData) {
        if (p.name?.trim()) {
          names.push(p.name.trim());
        }
      }
      return [...new Set(names)]; // deduplicate
    } catch {
      // Fall through to HTML parsing
    }
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
