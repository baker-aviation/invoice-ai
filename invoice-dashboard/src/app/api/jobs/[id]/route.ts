import { NextRequest, NextResponse } from "next/server";

const BASE = process.env.JOB_API_BASE_URL;

function mustBase(): string {
  if (!BASE) throw new Error("Missing JOB_API_BASE_URL");
  return BASE.replace(/\/$/, "");
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const base = mustBase();
  const url = `${base}/api/jobs/${id}`;

  const res = await fetch(url, {
    cache: "no-store",
    headers: { Accept: "application/json" },
  });

  const text = await res.text();

  if (!res.ok) {
    return new NextResponse(text || "Upstream error", { status: res.status });
  }

  // if upstream returned JSON, pass it through
  try {
    return NextResponse.json(JSON.parse(text));
  } catch {
    return new NextResponse(text, { status: 200 });
  }
}