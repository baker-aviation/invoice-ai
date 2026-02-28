import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, isAuthed, isRateLimited } from "@/lib/api-auth";

const BASE = process.env.INVOICE_API_BASE_URL;

export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (!isAuthed(auth)) return auth.error;

  if (isRateLimited(auth.userId, 5)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  if (!BASE) {
    return NextResponse.json({ error: "Service unavailable" }, { status: 503 });
  }

  const url = `${BASE.replace(/\/$/, "")}/jobs/flush_alerts`;

  try {
    const res = await fetch(url, { method: "POST", cache: "no-store" });
    const data = await res.json().catch(() => ({}));
    return NextResponse.json(data, { status: res.ok ? 200 : res.status });
  } catch {
    return NextResponse.json({ error: "Upstream unavailable" }, { status: 502 });
  }
}
