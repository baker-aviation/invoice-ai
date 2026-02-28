import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthed, isRateLimited } from "@/lib/api-auth";

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
    if (ALLOWED_PARAMS.has(k)) {
      upstream.searchParams.set(k, v);
    }
  }
  if (!searchParams.has("limit")) upstream.searchParams.set("limit", "200");

  try {
    const res = await fetch(upstream.toString(), { cache: "no-store" });
    const data = await res.json().catch(() => ({}));
    return NextResponse.json(data, { status: res.ok ? 200 : res.status });
  } catch {
    return NextResponse.json({ error: "Upstream unavailable" }, { status: 502 });
  }
}
