/**
 * Google Sheets API integration for reading _CREW INFO 2026 directly.
 * Uses the service account from GCP_SERVICE_ACCOUNT_KEY env var.
 * No extra npm packages needed — uses google-auth-library + fetch.
 */

import { GoogleAuth } from "google-auth-library";

const CREW_INFO_SHEET_ID = "16xYT4JvQGsSQXeoqn50TetqCzs8bOtJKuZvvbgu993w";
const SHEETS_API = "https://sheets.googleapis.com/v4/spreadsheets";
const SCOPES = [
  "https://www.googleapis.com/auth/spreadsheets.readonly",
  "https://www.googleapis.com/auth/drive.readonly",
];

let _auth: GoogleAuth | null = null;

function getAuth(): GoogleAuth {
  if (_auth) return _auth;

  const keyJson = process.env.GCP_SERVICE_ACCOUNT_KEY;
  if (!keyJson) throw new Error("GCP_SERVICE_ACCOUNT_KEY not set");

  // Handle both raw JSON and base64-encoded JSON
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(keyJson);
  } catch {
    // Try base64 decode
    const decoded = Buffer.from(keyJson, "base64").toString("utf8");
    parsed = JSON.parse(decoded);
  }

  _auth = new GoogleAuth({ credentials: parsed, scopes: SCOPES });
  return _auth;
}

async function getAccessToken(): Promise<string> {
  const auth = getAuth();
  const client = await auth.getClient();
  const token = await client.getAccessToken();
  if (!token.token) throw new Error("Failed to get access token");
  return token.token;
}

/**
 * Fetch all sheet names from the spreadsheet.
 */
export async function listSheets(): Promise<{ title: string; sheetId: number; index: number }[]> {
  const token = await getAccessToken();
  const res = await fetch(`${SHEETS_API}/${CREW_INFO_SHEET_ID}?fields=sheets.properties`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Sheets API error: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return (data.sheets ?? []).map((s: { properties: { title: string; sheetId: number; index: number } }) => ({
    title: s.properties.title,
    sheetId: s.properties.sheetId,
    index: s.properties.index,
  }));
}

/**
 * Fetch a specific sheet's data as a 2D array (like XLSX.utils.sheet_to_json with header: 1).
 */
export async function getSheetData(sheetName: string): Promise<unknown[][]> {
  const token = await getAccessToken();
  const encoded = encodeURIComponent(sheetName);
  const res = await fetch(
    `${SHEETS_API}/${CREW_INFO_SHEET_ID}/values/${encoded}?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=FORMATTED_STRING`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Sheets API error for "${sheetName}": ${res.status} ${text}`);
  }
  const data = await res.json();
  return data.values ?? [];
}

/**
 * Fetch multiple sheets at once (parallel).
 */
export async function getMultipleSheets(sheetNames: string[]): Promise<Map<string, unknown[][]>> {
  const results = new Map<string, unknown[][]>();
  const settled = await Promise.allSettled(
    sheetNames.map(async (name) => {
      const data = await getSheetData(name);
      return { name, data };
    }),
  );
  for (const r of settled) {
    if (r.status === "fulfilled") {
      results.set(r.value.name, r.value.data);
    }
  }
  return results;
}

/**
 * Download the entire spreadsheet as an xlsx buffer (for the existing parser).
 * Uses the Google Drive API export endpoint (works with service accounts).
 */
export async function downloadAsXlsx(): Promise<Buffer> {
  const token = await getAccessToken();
  // Drive API export — works with service account auth (unlike docs.google.com/export)
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files/${CREW_INFO_SHEET_ID}/export?mimeType=application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Drive export error: ${res.status} ${text.slice(0, 200)}`);
  }
  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

/**
 * List weekly swap sheet tabs (e.g., "MAR 25-APR 1 (A)").
 */
export async function listWeeklySheets(): Promise<string[]> {
  const sheets = await listSheets();
  return sheets
    .map(s => s.title)
    .filter(n => /[A-Z]{3}\s+\d+-[A-Z]{3}\s+\d+\s*\([AB]\)/i.test(n));
}

export { CREW_INFO_SHEET_ID };
