import { NextResponse } from "next/server";

export async function GET(
  _req: Request,
  { params }: { params: { id: string } }
) {
  const base = process.env.JOB_API_BASE_URL;
  if (!base) {
    return NextResponse.json(
      { ok: false, error: "Missing JOB_API_BASE_URL in .env.local" },
      { status: 500 }
    );
  }

  const id = params?.id;
  if (!id) {
    return NextResponse.json(
      { ok: false, error: "Missing id param" },
      { status: 400 }
    );
  }

  const url = `${base.replace(/\/$/, "")}/api/jobs/${encodeURIComponent(id)}`;

  const upstream = await fetch(url, { cache: "no-store" });
  const text = await upstream.text();

  return new NextResponse(text, {
    status: upstream.status,
    headers: {
      "content-type": upstream.headers.get("content-type") ?? "application/json",
    },
  });
}