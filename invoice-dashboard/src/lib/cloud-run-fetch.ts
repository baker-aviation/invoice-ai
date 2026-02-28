import "server-only";
import { GoogleAuth } from "google-auth-library";

/**
 * Authenticated fetch for Cloud Run services that require IAM auth.
 *
 * Uses a GCP service account to generate an OIDC ID token, then sends
 * it as a Bearer token in the Authorization header.
 *
 * Env vars (pick one):
 *   GCP_SA_KEY — base64-encoded OR raw JSON key for the service account
 *               (omit if running on GCP with default credentials)
 */

let _auth: GoogleAuth | null = null;

function getAuth(): GoogleAuth {
  if (_auth) return _auth;

  const raw = process.env.GCP_SA_KEY;
  if (raw) {
    // Accept both raw JSON (starts with "{") and base64-encoded JSON
    const json = raw.trimStart().startsWith("{")
      ? raw
      : Buffer.from(raw, "base64").toString("utf-8");
    const credentials = JSON.parse(json);
    _auth = new GoogleAuth({ credentials });
  } else {
    // Fall back to application default credentials (works on GCP)
    _auth = new GoogleAuth();
  }
  return _auth;
}

/**
 * Fetch a Cloud Run URL with an OIDC identity token.
 * Drop-in replacement for fetch() — same signature.
 */
export async function cloudRunFetch(
  url: string | URL,
  init?: RequestInit,
): Promise<Response> {
  const targetUrl = url.toString();
  const targetAudience = new URL(targetUrl).origin;

  const auth = getAuth();
  const client = await auth.getIdTokenClient(targetAudience);
  const headers = await client.getRequestHeaders();

  return fetch(targetUrl, {
    ...init,
    headers: {
      ...headers,
      ...(init?.headers as Record<string, string>),
    },
  });
}
