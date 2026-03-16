import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, isAuthed } from "@/lib/api-auth";
import { cloudRunFetch } from "@/lib/cloud-run-fetch";

export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (!isAuthed(auth)) return auth.error;

  const opsUrl = process.env.OPS_MONITOR_URL ?? process.env.OPS_API_BASE_URL;
  if (!opsUrl) {
    return NextResponse.json(
      { error: "OPS_MONITOR_URL not configured — set it in Vercel env vars" },
      { status: 500 },
    );
  }

  const url = `${opsUrl.replace(/\/$/, "")}/jobs/sync_schedule`;
  console.log(`[sync-schedule] Calling ${url}`);
  console.log(`[sync-schedule] GCP_SA_KEY present: ${!!process.env.GCP_SA_KEY}, length: ${(process.env.GCP_SA_KEY ?? "").length}`);

  try {
    // Call ops-monitor with OIDC token (Cloud Run requires IAM auth)
    const res = await cloudRunFetch(url, { method: "POST", cache: "no-store" });
    console.log(`[sync-schedule] Response status: ${res.status}, headers: ${JSON.stringify(Object.fromEntries(res.headers.entries()))}`);
    const text = await res.text();
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(text);
    } catch {
      return NextResponse.json(
        { error: `Unexpected response (${res.status}): ${text.slice(0, 200)}` },
        { status: 502 },
      );
    }
    if (!res.ok) {
      return NextResponse.json({ error: data.detail ?? `Sync failed (${res.status})` }, { status: res.status });
    }
    return NextResponse.json(data);
  } catch (err) {
    return NextResponse.json(
      { error: `Failed to reach ops-monitor: ${err instanceof Error ? err.message : String(err)}` },
      { status: 502 },
    );
  }
}
