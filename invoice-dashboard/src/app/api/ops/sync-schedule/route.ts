import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, isAuthed } from "@/lib/api-auth";
import { GoogleAuth } from "google-auth-library";

/**
 * POST /api/ops/sync-schedule
 * Triggers the ops-sync-schedule Cloud Scheduler job to run immediately.
 * This avoids OIDC audience issues with direct Cloud Run calls —
 * the scheduler already has the correct auth configured.
 */
export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (!isAuthed(auth)) return auth.error;

  const PROJECT = "invoice-ai-487621";
  const LOCATION = "us-central1";
  const JOB_NAME = "ops-sync-schedule";

  try {
    const raw = process.env.GCP_SA_KEY ?? process.env.GCP_SERVICE_ACCOUNT_KEY;
    if (!raw) {
      return NextResponse.json({ error: "GCP_SA_KEY not configured" }, { status: 500 });
    }
    const json = raw.trimStart().startsWith("{") ? raw : Buffer.from(raw, "base64").toString("utf-8");
    const credentials = JSON.parse(json);
    const gauth = new GoogleAuth({
      credentials,
      scopes: ["https://www.googleapis.com/auth/cloud-scheduler"],
    });
    const client = await gauth.getClient();
    const tokenResponse = await client.getAccessToken();
    const token = tokenResponse.token;

    // Trigger the scheduler job to run now
    const url = `https://cloudscheduler.googleapis.com/v1/projects/${PROJECT}/locations/${LOCATION}/jobs/${JOB_NAME}:run`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    });

    if (!res.ok) {
      const text = await res.text();
      return NextResponse.json(
        { error: `Scheduler trigger failed (${res.status}): ${text.slice(0, 200)}` },
        { status: 502 },
      );
    }

    return NextResponse.json({ ok: true, message: "Sync triggered — schedule will refresh in ~30 seconds" });
  } catch (err) {
    return NextResponse.json(
      { error: `Failed to trigger sync: ${err instanceof Error ? err.message : String(err)}` },
      { status: 502 },
    );
  }
}
