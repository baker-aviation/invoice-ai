import { NextResponse } from "next/server";

const BASE = process.env.OPS_API_BASE_URL;

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!BASE) {
    return NextResponse.json({ error: "Missing OPS_API_BASE_URL" }, { status: 500 });
  }

  const { id } = await params;
  const url = `${BASE.replace(/\/$/, "")}/api/ops-alerts/${id}/acknowledge`;

  try {
    const res = await fetch(url, { method: "POST", cache: "no-store" });
    const data = await res.json().catch(() => ({}));
    return NextResponse.json(data, { status: res.ok ? 200 : res.status });
  } catch (e: unknown) {
    return NextResponse.json({ error: String((e as Error)?.message ?? e) }, { status: 502 });
  }
}
