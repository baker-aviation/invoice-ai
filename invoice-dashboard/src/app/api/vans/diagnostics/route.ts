import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, isAuthed, isRateLimited } from "@/lib/api-auth";
import { cloudRunFetch } from "@/lib/cloud-run-fetch";

export async function GET(req: NextRequest) {
  // Diagnostics = admin-only
  const auth = await requireAdmin(req);
  if (!isAuthed(auth)) return auth.error;

  if (isRateLimited(auth.userId)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  const base = process.env.OPS_API_BASE_URL?.replace(/\/$/, "");
  if (!base) {
    return NextResponse.json({ error: "Service unavailable" }, { status: 503 });
  }

  try {
    const res = await cloudRunFetch(`${base}/api/vans/diagnostics`, { cache: "no-store" });
    const text = await res.text();
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      const cleaned = text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 300);
      return NextResponse.json(
        { error: `Upstream HTTP ${res.status}: ${cleaned || "(empty body)"}` },
        { status: 502 },
      );
    }
    return NextResponse.json(data, { status: res.ok ? 200 : res.status });
  } catch (err) {
    return NextResponse.json(
      { error: "Upstream unavailable", detail: String(err) },
      { status: 502 },
    );
  }
}
