import "server-only";
import { Storage } from "@google-cloud/storage";
import { createServiceClient } from "@/lib/supabase/service";
import {
  parseCrewIndex,
  parseCrewDocPage,
  parseAircraftDocPage,
  isLoginRedirect,
} from "./parser";
import type {
  CrewEntry,
  DocEntry,
  EntitySyncResult,
  SyncRunResult,
} from "./types";

const BASE_URL = "https://portal.jetinsight.com";
const DELAY_MS = 1000; // Rate limit: 1s between requests
const GCS_PREFIX = "jetinsight-docs";

// ---------------------------------------------------------------------------
// GCS setup
// ---------------------------------------------------------------------------

function getStorage(): Storage {
  const b64 = process.env.GCP_SERVICE_ACCOUNT_KEY;
  if (b64) {
    const json = JSON.parse(Buffer.from(b64, "base64").toString("utf-8"));
    return new Storage({ credentials: json, projectId: json.project_id });
  }
  return new Storage();
}

function getBucket(): string {
  return process.env.GCS_BUCKET || "baker-aviation-invoice-pdfs";
}

// ---------------------------------------------------------------------------
// HTTP — GET-only, cookie-based auth
// ---------------------------------------------------------------------------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Fetch a page from JetInsight portal. GET-only.
 * Throws if session is expired or request fails.
 */
async function fetchPage(path: string, cookie: string): Promise<string> {
  const url = path.startsWith("http") ? path : `${BASE_URL}${path}`;
  const res = await fetch(url, {
    method: "GET",
    headers: {
      Cookie: cookie,
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Baker-Aviation-Sync/1.0",
      Accept: "text/html,application/xhtml+xml",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(30_000), // 30s timeout per request
  });

  if (!res.ok) {
    throw new Error(`JetInsight fetch failed: ${res.status} ${res.statusText} for ${url}`);
  }

  const html = await res.text();
  if (isLoginRedirect(html)) {
    throw new Error("SESSION_EXPIRED");
  }

  return html;
}

/**
 * Download a file from JetInsight and upload it to GCS. GET-only.
 * Returns the GCS key and file size.
 */
async function downloadToGcs(
  downloadUrl: string,
  cookie: string,
  gcsKey: string,
): Promise<{ gcsKey: string; sizeBytes: number; contentType: string }> {
  const url = downloadUrl.startsWith("http")
    ? downloadUrl
    : `${BASE_URL}${downloadUrl}`;

  const res = await fetch(url, {
    method: "GET",
    headers: {
      Cookie: cookie,
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Baker-Aviation-Sync/1.0",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(30_000), // 30s timeout per request
  });

  if (!res.ok) {
    throw new Error(`Download failed: ${res.status} for ${url}`);
  }

  const buffer = Buffer.from(await res.arrayBuffer());
  const contentType =
    res.headers.get("content-type") || "application/octet-stream";

  const storage = getStorage();
  const bucket = getBucket();
  const blob = storage.bucket(bucket).file(gcsKey);
  await blob.save(buffer, { contentType });

  return { gcsKey, sizeBytes: buffer.length, contentType };
}

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

async function getConfig(
  key: string,
): Promise<string | null> {
  const supa = createServiceClient();
  const { data } = await supa
    .from("jetinsight_config")
    .select("config_value")
    .eq("config_key", key)
    .single();
  return data?.config_value ?? null;
}

// ---------------------------------------------------------------------------
// Sync: Crew Index
// ---------------------------------------------------------------------------

/**
 * Scrape the crew index page and match to pilot_profiles.
 * Updates jetinsight_uuid on matched profiles.
 */
export async function syncCrewIndex(cookie: string): Promise<CrewEntry[]> {
  const html = await fetchPage(
    `/compliance/documents/crew`,
    cookie,
  );
  const crew = parseCrewIndex(html);

  // Match to pilot_profiles and update jetinsight_uuid
  const supa = createServiceClient();
  const { data: profiles } = await supa
    .from("pilot_profiles")
    .select("id, full_name, email, jetinsight_uuid");

  if (profiles) {
    for (const c of crew) {
      // Try matching by existing jetinsight_uuid first
      let matched = profiles.find((p) => p.jetinsight_uuid === c.uuid);

      // Then by email
      if (!matched && c.email) {
        matched = profiles.find(
          (p) => p.email?.toLowerCase() === c.email!.toLowerCase(),
        );
      }

      // Then by name (case-insensitive)
      if (!matched) {
        const normalName = c.name.toLowerCase().replace(/\s+/g, " ");
        matched = profiles.find(
          (p) => p.full_name?.toLowerCase().replace(/\s+/g, " ") === normalName,
        );
      }

      if (matched && matched.jetinsight_uuid !== c.uuid) {
        await supa
          .from("pilot_profiles")
          .update({ jetinsight_uuid: c.uuid })
          .eq("id", matched.id);
      }

      // Auto-create profile for unmatched JI crew so their docs are linkable
      if (!matched) {
        const { data: newProfile } = await supa
          .from("pilot_profiles")
          .insert({
            full_name: c.name,
            email: c.email ?? null,
            jetinsight_uuid: c.uuid,
            role: "PIC",
          })
          .select("id")
          .single();

        if (newProfile) {
          // Also update any existing docs that used the JI UUID as entity_id
          // to point to the new profile ID instead
          await supa
            .from("jetinsight_documents")
            .update({ entity_id: String(newProfile.id) })
            .eq("entity_type", "crew")
            .eq("entity_id", c.uuid);

          profiles.push({ id: newProfile.id, full_name: c.name, email: c.email ?? null, jetinsight_uuid: c.uuid });
        }
      }
    }
  }

  // Save the full crew list so batch syncs can iterate through all 202+ crew
  await supa.from("jetinsight_config").upsert(
    {
      config_key: "crew_list",
      config_value: JSON.stringify(crew),
      updated_at: new Date().toISOString(),
    },
    { onConflict: "config_key" },
  );

  return crew;
}

// ---------------------------------------------------------------------------
// Sync: Single Entity Documents
// ---------------------------------------------------------------------------

/**
 * Sync all documents for a single crew member.
 */
export async function syncCrewDocs(
  pilotProfileId: string,
  jiUuid: string,
  cookie: string,
): Promise<EntitySyncResult> {
  const result: EntitySyncResult = {
    entityType: "crew",
    entityId: pilotProfileId,
    docsDownloaded: 0,
    docsSkipped: 0,
    errors: [],
  };

  let docEntries: DocEntry[];
  try {
    const html = await fetchPage(
      `/compliance/documents/${jiUuid}/crew`,
      cookie,
    );
    docEntries = parseCrewDocPage(html);
  } catch (err) {
    result.errors.push(
      `Failed to fetch doc page: ${err instanceof Error ? err.message : String(err)}`,
    );
    return result;
  }

  const supa = createServiceClient();

  for (const doc of docEntries) {
    // Parse upload date early for dedup comparison
    let uploadedOn: string | null = null;
    if (doc.uploadedOn) {
      const parts = doc.uploadedOn.split("/");
      if (parts.length === 3) {
        uploadedOn = `${parts[2]}-${parts[0].padStart(2, "0")}-${parts[1].padStart(2, "0")}`;
      }
    }

    // Check if already synced (no delay needed for DB check)
    const { data: existing } = await supa
      .from("jetinsight_documents")
      .select("id, uploaded_on")
      .eq("entity_type", "crew")
      .eq("entity_id", pilotProfileId)
      .eq("jetinsight_uuid", doc.checkUuid)
      .maybeSingle();

    // Skip if exists with same or newer upload date
    if (existing && (!uploadedOn || existing.uploaded_on === uploadedOn)) {
      result.docsSkipped++;
      continue;
    }

    // Delete old version if re-uploading
    if (existing) {
      await supa.from("jetinsight_documents").delete().eq("id", existing.id);
    }

    // Rate limit only before actual downloads
    await sleep(DELAY_MS);

    // Download to GCS
    const safeName = doc.filename.replace(/[^a-zA-Z0-9._-]/g, "_");
    const gcsKey = `${GCS_PREFIX}/crew/${pilotProfileId}/${sanitizeCategory(doc.category)}/${Date.now()}-${safeName}`;

    try {
      const gcsResult = await downloadToGcs(doc.downloadUrl, cookie, gcsKey);

      await supa.from("jetinsight_documents").insert({
        entity_type: "crew",
        entity_id: pilotProfileId,
        jetinsight_uuid: doc.checkUuid,
        category: doc.category,
        subcategory: doc.subcategory || null,
        aircraft_type: doc.aircraftType || null,
        document_name: doc.filename,
        uploaded_on: uploadedOn,
        version_label: doc.versionLabel || null,
        gcs_bucket: getBucket(),
        gcs_key: gcsResult.gcsKey,
        size_bytes: gcsResult.sizeBytes,
        content_type: gcsResult.contentType,
        jetinsight_url: doc.downloadUrl,
      });

      result.docsDownloaded++;
    } catch (err) {
      result.errors.push(
        `${doc.filename}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return result;
}

/**
 * Sync company-level documents from /compliance/documents/operator.
 * Same HTML structure as aircraft docs (Bootstrap panels with download links).
 */
export async function syncCompanyDocs(
  cookie: string,
): Promise<EntitySyncResult> {
  const result: EntitySyncResult = {
    entityType: "aircraft", // reused type field
    entityId: "baker_aviation",
    docsDownloaded: 0,
    docsSkipped: 0,
    errors: [],
  };

  let docEntries: DocEntry[];
  try {
    const html = await fetchPage(
      `/compliance/documents/operator`,
      cookie,
    );
    docEntries = parseAircraftDocPage(html);
  } catch (err) {
    result.errors.push(
      `Failed to fetch company doc page: ${err instanceof Error ? err.message : String(err)}`,
    );
    return result;
  }

  const supa = createServiceClient();

  for (const doc of docEntries) {
    let uploadedOn: string | null = null;
    if (doc.uploadedOn) {
      const parts = doc.uploadedOn.split("/");
      if (parts.length === 3) {
        uploadedOn = `${parts[2]}-${parts[0].padStart(2, "0")}-${parts[1].padStart(2, "0")}`;
      }
    }

    const { data: existing } = await supa
      .from("jetinsight_documents")
      .select("id, uploaded_on")
      .eq("entity_type", "company")
      .eq("entity_id", "baker_aviation")
      .eq("jetinsight_uuid", doc.checkUuid)
      .maybeSingle();

    if (existing && (!uploadedOn || existing.uploaded_on === uploadedOn)) {
      result.docsSkipped++;
      continue;
    }

    if (existing) {
      await supa.from("jetinsight_documents").delete().eq("id", existing.id);
    }

    await sleep(DELAY_MS);

    const safeName = doc.filename.replace(/[^a-zA-Z0-9._-]/g, "_");
    const gcsKey = `${GCS_PREFIX}/company/${sanitizeCategory(doc.category)}/${Date.now()}-${safeName}`;

    try {
      const gcsResult = await downloadToGcs(doc.downloadUrl, cookie, gcsKey);

      await supa.from("jetinsight_documents").insert({
        entity_type: "company",
        entity_id: "baker_aviation",
        jetinsight_uuid: doc.checkUuid,
        category: doc.category,
        subcategory: null,
        aircraft_type: null,
        document_name: doc.filename,
        uploaded_on: uploadedOn,
        version_label: doc.versionLabel || null,
        gcs_bucket: getBucket(),
        gcs_key: gcsResult.gcsKey,
        size_bytes: gcsResult.sizeBytes,
        content_type: gcsResult.contentType,
        jetinsight_url: doc.downloadUrl,
      });

      result.docsDownloaded++;
    } catch (err) {
      result.errors.push(
        `${doc.filename}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return result;
}

/**
 * Sync all documents for a single aircraft tail.
 */
export async function syncAircraftDocs(
  tail: string,
  cookie: string,
): Promise<EntitySyncResult> {
  const result: EntitySyncResult = {
    entityType: "aircraft",
    entityId: tail,
    docsDownloaded: 0,
    docsSkipped: 0,
    errors: [],
  };

  let docEntries: DocEntry[];
  try {
    const html = await fetchPage(
      `/compliance/documents/${tail}/aircraft`,
      cookie,
    );
    docEntries = parseAircraftDocPage(html);
  } catch (err) {
    result.errors.push(
      `Failed to fetch doc page: ${err instanceof Error ? err.message : String(err)}`,
    );
    return result;
  }

  const supa = createServiceClient();

  for (const doc of docEntries) {
    // Check if already synced (no delay needed for DB check)
    // Parse upload date early for dedup comparison
    let uploadedOn: string | null = null;
    if (doc.uploadedOn) {
      const parts = doc.uploadedOn.split("/");
      if (parts.length === 3) {
        uploadedOn = `${parts[2]}-${parts[0].padStart(2, "0")}-${parts[1].padStart(2, "0")}`;
      }
    }

    const { data: existing } = await supa
      .from("jetinsight_documents")
      .select("id, uploaded_on")
      .eq("entity_type", "aircraft")
      .eq("entity_id", tail)
      .eq("jetinsight_uuid", doc.checkUuid)
      .maybeSingle();

    if (existing && (!uploadedOn || existing.uploaded_on === uploadedOn)) {
      result.docsSkipped++;
      continue;
    }

    if (existing) {
      await supa.from("jetinsight_documents").delete().eq("id", existing.id);
    }

    await sleep(DELAY_MS);

    const safeName = doc.filename.replace(/[^a-zA-Z0-9._-]/g, "_");
    const gcsKey = `${GCS_PREFIX}/aircraft/${tail}/${sanitizeCategory(doc.category)}/${Date.now()}-${safeName}`;

    try {
      const gcsResult = await downloadToGcs(doc.downloadUrl, cookie, gcsKey);

      await supa.from("jetinsight_documents").insert({
        entity_type: "aircraft",
        entity_id: tail,
        jetinsight_uuid: doc.checkUuid,
        category: doc.category,
        subcategory: null,
        aircraft_type: null,
        document_name: doc.filename,
        uploaded_on: uploadedOn,
        version_label: doc.versionLabel || null,
        gcs_bucket: getBucket(),
        gcs_key: gcsResult.gcsKey,
        size_bytes: gcsResult.sizeBytes,
        content_type: gcsResult.contentType,
        jetinsight_url: doc.downloadUrl,
      });

      result.docsDownloaded++;
    } catch (err) {
      result.errors.push(
        `${doc.filename}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Full Sync
// ---------------------------------------------------------------------------

/**
 * Run a full sync: crew index → crew docs → aircraft docs.
 * Logs everything to jetinsight_sync_runs.
 */
export async function runFullSync(
  triggeredBy?: string,
): Promise<SyncRunResult> {
  const start = Date.now();
  const supa = createServiceClient();

  // Create sync run record
  const { data: run } = await supa
    .from("jetinsight_sync_runs")
    .insert({
      sync_type: "full",
      status: "running",
      triggered_by: triggeredBy || null,
    })
    .select("id")
    .single();

  const runId = run?.id;

  const result: SyncRunResult = {
    syncType: "full",
    status: "ok",
    crewSynced: 0,
    aircraftSynced: 0,
    docsDownloaded: 0,
    docsSkipped: 0,
    errors: [],
    durationMs: 0,
  };

  try {
    const cookie = await getConfig("session_cookie");
    if (!cookie) throw new Error("No session cookie configured");

    // Step 1: Crew index
    const crew = await syncCrewIndex(cookie);
    await sleep(DELAY_MS);

    // Step 2: Crew docs
    const { data: profiles } = await supa
      .from("pilot_profiles")
      .select("id, jetinsight_uuid")
      .not("jetinsight_uuid", "is", null);

    if (profiles) {
      for (const profile of profiles) {
        await sleep(DELAY_MS);
        const entityResult = await syncCrewDocs(
          String(profile.id),
          profile.jetinsight_uuid,
          cookie,
        );
        result.crewSynced++;
        result.docsDownloaded += entityResult.docsDownloaded;
        result.docsSkipped += entityResult.docsSkipped;
        for (const err of entityResult.errors) {
          result.errors.push({ entity: `crew:${profile.id}`, message: err });
        }
      }
    }

    // Also sync crew who aren't matched to profiles yet
    for (const c of crew) {
      const isMatched = profiles?.some(
        (p) => p.jetinsight_uuid === c.uuid,
      );
      if (isMatched) continue;

      await sleep(DELAY_MS);
      const entityResult = await syncCrewDocs(
        c.uuid, // use JI UUID as entity_id for unmatched crew
        c.uuid,
        cookie,
      );
      result.crewSynced++;
      result.docsDownloaded += entityResult.docsDownloaded;
      result.docsSkipped += entityResult.docsSkipped;
      for (const err of entityResult.errors) {
        result.errors.push({
          entity: `crew:${c.name} (unmatched)`,
          message: err,
        });
      }
    }

    // Step 3: Aircraft docs
    const { data: sources } = await supa
      .from("ics_sources")
      .select("label")
      .eq("enabled", true);

    if (sources) {
      for (const src of sources) {
        const tail = src.label;
        if (!tail || !tail.startsWith("N")) continue;

        await sleep(DELAY_MS);
        const entityResult = await syncAircraftDocs(tail, cookie);
        result.aircraftSynced++;
        result.docsDownloaded += entityResult.docsDownloaded;
        result.docsSkipped += entityResult.docsSkipped;
        for (const err of entityResult.errors) {
          result.errors.push({
            entity: `aircraft:${tail}`,
            message: err,
          });
        }
      }
    }

    result.status = result.errors.length > 0 ? "partial" : "ok";
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    result.status = "error";
    result.errors.push({ entity: "system", message: msg });
  }

  result.durationMs = Date.now() - start;

  // Update sync run record
  if (runId) {
    await supa
      .from("jetinsight_sync_runs")
      .update({
        status: result.status,
        crew_synced: result.crewSynced,
        aircraft_synced: result.aircraftSynced,
        docs_downloaded: result.docsDownloaded,
        docs_skipped: result.docsSkipped,
        errors: result.errors,
        duration_ms: result.durationMs,
        completed_at: new Date().toISOString(),
      })
      .eq("id", runId);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sanitizeCategory(category: string): string {
  return category
    .replace(/[^a-zA-Z0-9._\- ]/g, "")
    .replace(/\s+/g, "_")
    .toLowerCase()
    .slice(0, 80);
}
