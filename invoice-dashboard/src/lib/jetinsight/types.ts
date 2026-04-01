/** Crew member discovered from JetInsight crew index page */
export interface CrewEntry {
  name: string;
  uuid: string;
  email?: string;
  phone?: string;
}

/** Document discovered on a crew or aircraft doc page */
export interface DocEntry {
  /** "Pilot check" category or aircraft doc category */
  category: string;
  /** e.g. "1st class (under 40)" for medical subcategories */
  subcategory?: string;
  /** For type-specific checks, e.g. "CL-30" */
  aircraftType?: string;
  /** JetInsight UUID from the download link */
  checkUuid: string;
  /** Original filename shown on the page */
  filename: string;
  /** Full download URL path */
  downloadUrl: string;
  /** "Uploaded on: MM/DD/YYYY" parsed from the page */
  uploadedOn?: string;
  /** Version label if present */
  versionLabel?: string;
}

/** Result of syncing one entity (crew member or aircraft) */
export interface EntitySyncResult {
  entityType: "crew" | "aircraft";
  entityId: string;
  docsDownloaded: number;
  docsSkipped: number;
  errors: string[];
}

/** Result of a full sync run */
export interface SyncRunResult {
  syncType: string;
  status: "ok" | "error" | "partial";
  crewSynced: number;
  aircraftSynced: number;
  docsDownloaded: number;
  docsSkipped: number;
  errors: Array<{ entity: string; message: string }>;
  durationMs: number;
}

/** Row from jetinsight_documents table */
export interface JetInsightDocument {
  id: number;
  entity_type: "crew" | "aircraft";
  entity_id: string;
  jetinsight_uuid: string | null;
  category: string;
  subcategory: string | null;
  aircraft_type: string | null;
  document_name: string;
  uploaded_on: string | null;
  version_label: string | null;
  gcs_bucket: string;
  gcs_key: string;
  size_bytes: number | null;
  content_type: string | null;
  jetinsight_url: string | null;
  synced_at: string;
  created_at: string;
  /** Added client-side after signing */
  signed_url?: string | null;
}

/** Row from jetinsight_sync_runs table */
export interface JetInsightSyncRun {
  id: number;
  sync_type: string;
  status: string;
  crew_synced: number;
  aircraft_synced: number;
  docs_downloaded: number;
  docs_skipped: number;
  errors: Array<{ entity: string; message: string }>;
  triggered_by: string | null;
  duration_ms: number | null;
  started_at: string;
  completed_at: string | null;
}
