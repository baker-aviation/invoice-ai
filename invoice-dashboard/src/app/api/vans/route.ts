import { NextResponse } from "next/server";

export async function GET() {
  const base = process.env.OPS_API_BASE_URL?.replace(/\/$/, "");
  if (!base) {
    return NextResponse.json({ ok: false, error: "OPS_API_BASE_URL not set" }, { status: 503 });
  }

  try {
    const res = await fetch(`${base}/api/vans`, { cache: "no-store" });
    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch (err: unknown) {
    return NextResponse.json({ ok: false, error: String(err) }, { status: 502 });
  }
}
