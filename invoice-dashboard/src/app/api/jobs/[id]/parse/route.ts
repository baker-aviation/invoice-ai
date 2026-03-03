import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, isAuthed, isRateLimited } from "@/lib/api-auth";
import { cloudRunFetch } from "@/lib/cloud-run-fetch";

const BASE = process.env.JOB_API_BASE_URL;

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAdmin(req);
  if (!isAuthed(auth)) return auth.error;

  if (isRateLimited(auth.userId)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  if (!BASE) {
    return NextResponse.json({ error: "JOB_API_BASE_URL not configured" }, { status: 503 });
  }

  const { id } = await params;
  const applicationId = parseInt(id, 10);
  if (isNaN(applicationId) || applicationId <= 0) {
    return NextResponse.json({ error: "Invalid application ID" }, { status: 400 });
  }

  const base = BASE.replace(/\/$/, "");
  const url = `${base}/jobs/parse_application?application_id=${applicationId}`;

  try {
    const res = await cloudRunFetch(url, {
      method: "POST",
      cache: "no-store",
      headers: { Accept: "application/json" },
    });

    const text = await res.text();

    if (!res.ok) {
      console.error(`[jobs/${id}/parse] Cloud Run error: HTTP ${res.status} — ${text.slice(0, 500)}`);
      return NextResponse.json(
        { error: `Parse service error: ${res.status}`, detail: text.slice(0, 500) },
        { status: res.status >= 400 && res.status < 500 ? res.status : 502 },
      );
    }

    try {
      return NextResponse.json({ ok: true, ...JSON.parse(text) });
    } catch {
      return NextResponse.json({ ok: true, raw: text });
    }
  } catch (err) {
    console.error(`[jobs/${id}/parse] fetch failed:`, err);
    return NextResponse.json({ error: "Parse service unreachable" }, { status: 502 });
  }
}
