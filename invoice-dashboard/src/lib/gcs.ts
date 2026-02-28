import "server-only";
import { Storage } from "@google-cloud/storage";

let _storage: Storage | null = null;

/**
 * Initialise a GCS client from the GCP_SERVICE_ACCOUNT_KEY env var
 * (base64-encoded JSON key) or from Application Default Credentials.
 */
function getStorage(): Storage | null {
  if (_storage) return _storage;

  const b64 = process.env.GCP_SERVICE_ACCOUNT_KEY;
  if (b64) {
    try {
      const json = JSON.parse(Buffer.from(b64, "base64").toString("utf-8"));
      _storage = new Storage({ credentials: json, projectId: json.project_id });
      return _storage;
    } catch {
      // fall through
    }
  }

  // Try Application Default Credentials (works on GCP, local w/ gcloud auth)
  try {
    _storage = new Storage();
    return _storage;
  } catch {
    return null;
  }
}

/**
 * Generate a V4 signed URL for a GCS object.
 * Returns null if credentials are unavailable or signing fails.
 */
export async function signGcsUrl(
  bucket: string,
  path: string,
  expiresMinutes = 120,
): Promise<string | null> {
  const storage = getStorage();
  if (!storage) return null;

  try {
    const [url] = await storage.bucket(bucket).file(path).getSignedUrl({
      version: "v4",
      action: "read",
      expires: Date.now() + expiresMinutes * 60 * 1000,
      responseType: "application/pdf",
      responseDisposition: 'inline; filename="invoice.pdf"',
    });
    return url;
  } catch {
    return null;
  }
}
