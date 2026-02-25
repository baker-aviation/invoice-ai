import { NextResponse } from "next/server";

const BASE = process.env.INVOICE_API_BASE_URL;

export async function POST() {
  if (!BASE) {
    return NextResponse.json({ error: "Missing INVOICE_API_BASE_URL" }, { status: 500 });
  }

  const url = `${BASE.replace(/\/$/, "")}/jobs/flush_alerts`;

  try {
    const res = await fetch(url, { method: "POST", cache: "no-store" });
    const data = await res.json().catch(() => ({}));
    return NextResponse.json(data, { status: res.ok ? 200 : res.status });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 502 });
  }
}
