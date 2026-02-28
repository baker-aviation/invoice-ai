import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthed, isRateLimited } from "@/lib/api-auth";
import { cloudRunFetch } from "@/lib/cloud-run-fetch";

const BASE = process.env.INVOICE_API_BASE_URL;

const ALLOWED_PARAMS = new Set(["limit", "offset", "q", "status", "slack_status", "vendor"]);

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;

  if (isRateLimited(auth.userId)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  if (!BASE) {
    return NextResponse.json({ error: "Service unavailable" }, { status: 503 });
  }

  const { searchParams } = req.nextUrl;
  const upstream = new URL(`${BASE.replace(/\/$/, "")}/api/alerts`);
  for (const [k, v] of searchParams.entries()) {
    if (!ALLOWED_PARAMS.has(k)) continue;
    if (k === "limit") {
      const n = parseInt(v, 10);
      if (isNaN(n) || n < 1) continue;
      upstream.searchParams.set(k, String(Math.min(n, 500)));
    } else if (k === "offset") {
      const n = parseInt(v, 10);
      if (isNaN(n) || n < 0) continue;
      upstream.searchParams.set(k, String(n));
    } else if (k === "q" && v.length > 200) {
      upstream.searchParams.set(k, v.slice(0, 200));
    } else {
      upstream.searchParams.set(k, v);
    }
  }
  if (!searchParams.has("limit")) upstream.searchParams.set("limit", "200");

  try {
    const res = await cloudRunFetch(upstream.toString(), { cache: "no-store" });
    const data = await res.json().catch(() => ({}));
    return NextResponse.json(data, { status: res.ok ? 200 : res.status });
  } catch {
    return NextResponse.json({ error: "Upstream unavailable" }, { status: 502 });
  }
}
