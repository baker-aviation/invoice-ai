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

  try {
    const res = await fetch(`${opsUrl}/jobs/sync_schedule`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    const data = await res.json();
    if (!res.ok) {
      return NextResponse.json({ error: data.detail ?? "Sync failed" }, { status: res.status });
    }
    return NextResponse.json(data);
  } catch (err) {
    return NextResponse.json(
      { error: `Failed to reach ops-monitor: ${err instanceof Error ? err.message : String(err)}` },
      { status: 502 },
    );
  }
}
