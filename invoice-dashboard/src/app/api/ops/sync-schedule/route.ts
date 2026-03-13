import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, isAuthed } from "@/lib/api-auth";

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

  try {
    // Call ops-monitor directly (service allows unauthenticated invocations)
    const res = await fetch(url, { method: "POST", cache: "no-store" });
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
