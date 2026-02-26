import { NextRequest, NextResponse } from "next/server";

const BASE = process.env.INVOICE_API_BASE_URL;

export async function GET(req: NextRequest) {
  if (!BASE) {
    return NextResponse.json({ error: "Missing INVOICE_API_BASE_URL" }, { status: 500 });
  }

  const { searchParams } = req.nextUrl;
  const upstream = new URL(`${BASE.replace(/\/$/, "")}/api/alerts`);
  for (const [k, v] of searchParams.entries()) {
    upstream.searchParams.set(k, v);
  }
  if (!searchParams.has("limit")) upstream.searchParams.set("limit", "200");

  try {
    const res = await fetch(upstream.toString(), { cache: "no-store" });
    const data = await res.json().catch(() => ({}));
    return NextResponse.json(data, { status: res.ok ? 200 : res.status });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 502 });
  }
}
