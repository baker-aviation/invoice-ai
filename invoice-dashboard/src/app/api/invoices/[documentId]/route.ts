import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthed, isRateLimited } from "@/lib/api-auth";

const INVOICE_BASE = process.env.INVOICE_API_BASE_URL;

const SAFE_ID_RE = /^[a-zA-Z0-9_-]{1,128}$/;

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ documentId: string }> }
) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;

  if (isRateLimited(auth.userId)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  if (!INVOICE_BASE) {
    return NextResponse.json({ error: "Service unavailable" }, { status: 503 });
  }

  const { documentId } = await params;
  if (!SAFE_ID_RE.test(documentId)) {
    return NextResponse.json({ error: "Invalid document ID" }, { status: 400 });
  }

  const base = INVOICE_BASE.replace(/\/$/, "");
  const url = `${base}/api/invoices/${encodeURIComponent(documentId)}/file`;

  // Do NOT auto-follow; we want the Location header
  const res = await fetch(url, { redirect: "manual", cache: "no-store" });

  const location = res.headers.get("location");
  if (res.status >= 300 && res.status < 400 && location) {
    // Only allow redirects to our GCS bucket
    if (location.startsWith("https://storage.googleapis.com/")) {
      return NextResponse.redirect(location, 302);
    }
    return NextResponse.json({ error: "Invalid redirect" }, { status: 502 });
  }

  return new NextResponse("Could not get signed URL", { status: res.status || 502 });
}
