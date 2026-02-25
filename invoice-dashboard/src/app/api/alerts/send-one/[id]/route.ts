import { NextRequest, NextResponse } from "next/server";

const BASE = process.env.INVOICE_API_BASE_URL;

function mustBase(): string {
  if (!BASE) throw new Error("Missing INVOICE_API_BASE_URL");
  return BASE.replace(/\/$/, "");
}

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const base = mustBase();
  const url = `${base}/jobs/send_alert?alert_id=${encodeURIComponent(id)}`;

  const res = await fetch(url, { method: "POST", cache: "no-store" });
  const text = await res.text();

  if (!res.ok) {
    return new NextResponse(text || "Upstream error", { status: res.status });
  }

  try {
    return NextResponse.json(JSON.parse(text));
  } catch {
    return new NextResponse(text, { status: 200 });
  }
}
