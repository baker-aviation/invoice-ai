import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { GoogleAuth } from "google-auth-library";

/**
 * Direct PDF proxy — fetches from GCS using service account credentials.
 * Bypasses Cloud Run entirely so PDFs work even if invoice-alerts is down.
 *
 * GET /api/invoices/{documentId}/pdf
 */

const SAFE_ID_RE = /^[a-f0-9-]{36}$/;

let _auth: GoogleAuth | null = null;

function getAuth(): GoogleAuth {
  if (_auth) return _auth;

  const raw = process.env.GCP_SA_KEY;
  if (raw) {
    const json = raw.trimStart().startsWith("{")
      ? raw
      : Buffer.from(raw, "base64").toString("utf-8");
    const credentials = JSON.parse(json);
    _auth = new GoogleAuth({
      credentials,
      scopes: ["https://www.googleapis.com/auth/devstorage.read_only"],
    });
  } else {
    _auth = new GoogleAuth({
      scopes: ["https://www.googleapis.com/auth/devstorage.read_only"],
    });
  }
  return _auth;
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ documentId: string }> },
) {
  const { documentId } = await params;
  if (!SAFE_ID_RE.test(documentId)) {
    return NextResponse.json({ error: "Invalid document ID" }, { status: 400 });
  }

  // 1. Look up GCS path from documents table
  const supa = createServiceClient();
  const { data: doc, error } = await supa
    .from("documents")
    .select("gcs_bucket, gcs_path")
    .eq("id", documentId)
    .maybeSingle();

  if (error || !doc) {
    return NextResponse.json({ error: "Document not found" }, { status: 404 });
  }

  const { gcs_bucket, gcs_path } = doc;
  if (!gcs_bucket || !gcs_path) {
    return NextResponse.json({ error: "No GCS path for document" }, { status: 404 });
  }

  // 2. Fetch PDF from GCS using service account
  try {
    const auth = getAuth();
    const client = await auth.getClient();
    const tokenRes = await client.getAccessToken();
    const token = tokenRes?.token;

    if (!token) {
      return NextResponse.json({ error: "Could not get GCS credentials" }, { status: 500 });
    }

    const gcsUrl = `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(gcs_bucket)}/o/${encodeURIComponent(gcs_path)}?alt=media`;

    const gcsRes = await fetch(gcsUrl, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    });

    if (!gcsRes.ok) {
      return NextResponse.json(
        { error: `GCS returned ${gcsRes.status}` },
        { status: 502 },
      );
    }

    const pdfBytes = await gcsRes.arrayBuffer();

    return new NextResponse(pdfBytes, {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": 'inline; filename="invoice.pdf"',
        "Cache-Control": "private, max-age=3600",
      },
    });
  } catch (e) {
    console.error("PDF proxy error:", e);
    return NextResponse.json({ error: "Failed to fetch PDF" }, { status: 500 });
  }
}
