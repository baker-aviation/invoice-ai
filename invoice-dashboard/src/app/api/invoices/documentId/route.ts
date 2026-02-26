// src/app/api/invoices/[documentId]/file/route.ts
import { NextResponse } from "next/server";

const INVOICE_BASE = process.env.INVOICE_API_BASE_URL;

function mustBase() {
  if (!INVOICE_BASE) throw new Error("Missing INVOICE_API_BASE_URL");
  return INVOICE_BASE.replace(/\/$/, "");
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ documentId: string }> }
) {
  const { documentId } = await params;

  const base = mustBase();

  // Cloud Run endpoint that returns a 302 to signed GCS URL
  const url = `${base}/api/invoices/${encodeURIComponent(documentId)}/file`;

  // Do NOT auto-follow; we want the Location header
  const res = await fetch(url, { redirect: "manual", cache: "no-store" });

  const location = res.headers.get("location");
  if (res.status >= 300 && res.status < 400 && location) {
    return NextResponse.redirect(location, 302);
  }

  const text = await res.text().catch(() => "");
  return new NextResponse(text || "Could not get signed URL", { status: res.status || 502 });
}