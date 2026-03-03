import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthed, isRateLimited } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";
import { signGcsUrl } from "@/lib/gcs";
import { cloudRunFetch } from "@/lib/cloud-run-fetch";

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

  const { documentId } = await params;
  if (!SAFE_ID_RE.test(documentId)) {
    return NextResponse.json({ error: "Invalid document ID" }, { status: 400 });
  }

  // Strategy 1: Direct GCS signing via service account key
  const supa = createServiceClient();
  const { data: doc } = await supa
    .from("documents")
    .select("gcs_bucket, gcs_path")
    .eq("id", documentId)
    .maybeSingle();

  if (doc?.gcs_bucket && doc?.gcs_path) {
    const signed = await signGcsUrl(doc.gcs_bucket, doc.gcs_path);
    if (signed) {
      return NextResponse.redirect(signed, 302);
    }
  }

  // Strategy 2: Cloud Run proxy
  if (INVOICE_BASE) {
    const base = INVOICE_BASE.replace(/\/$/, "");
    const url = `${base}/api/invoices/${encodeURIComponent(documentId)}/file`;

    const res = await cloudRunFetch(url, { redirect: "manual", cache: "no-store" });

    const location = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && location) {
      if (location.startsWith("https://storage.googleapis.com/")) {
        return NextResponse.redirect(location, 302);
      }
      return NextResponse.json({ error: "Invalid redirect" }, { status: 502 });
    }
  }

  return NextResponse.json({ error: "PDF unavailable — no GCS credentials or backend configured" }, { status: 503 });
}
