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

  // The ops-monitor has a dual auth layer:
  //   1. Cloud Run IAM (OIDC token) — handled by cloudRunFetch
  //   2. App-level SERVICE_AUTH_TOKEN — static Bearer token checked by auth_middleware.py
  // If SERVICE_AUTH_TOKEN is available, use it directly (simpler, avoids OIDC audience issues).
  // Otherwise fall back to OIDC via cloudRunFetch.
  const serviceToken = process.env.SERVICE_AUTH_TOKEN;

  try {
    let res: Response;

    if (serviceToken) {
      // Direct call with static service token — bypasses OIDC complexity
      res = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${serviceToken}` },
        cache: "no-store",
      });
    } else {
      // Fall back to OIDC token for Cloud Run IAM auth
      res = await cloudRunFetch(url, { method: "POST", cache: "no-store" });
    }

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
