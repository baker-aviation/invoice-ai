import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthed, isRateLimited } from "@/lib/api-auth";
import { cloudRunFetch } from "@/lib/cloud-run-fetch";

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;

  if (isRateLimited(auth.userId)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  const base = process.env.OPS_API_BASE_URL?.replace(/\/$/, "");
  if (!base) {
    return NextResponse.json({ error: "Service unavailable" }, { status: 503 });
  }

  try {
    const res = await cloudRunFetch(`${base}/api/vans`, { cache: "no-store" });
    const text = await res.text();
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      // Cloud Run returned non-JSON (HTML error page, container crash, etc.)
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
