import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { cloudRunFetch } from "@/lib/cloud-run-fetch";
import { GoogleAuth } from "google-auth-library";

/**
 * GET /api/invoices/{documentId}/pdf
 *
 * Serves the invoice PDF. Tries multiple strategies:
 * 1. Get a signed URL from invoice-alerts Cloud Run → redirect
 * 2. Direct GCS fetch using service account credentials → stream bytes
 */

const SAFE_ID_RE = /^[a-f0-9-]{36}$/;

/**
 * Resolve the invoice-alerts Cloud Run base URL.
 * Prefers INVOICE_API_BASE_URL; if unset, derives from PARSER_API_BASE_URL
 * (same GCP project → same hash, just swap the service name).
 */
function getAlertsBase(): string | undefined {
  if (process.env.INVOICE_API_BASE_URL) return process.env.INVOICE_API_BASE_URL;
  const parser = process.env.PARSER_API_BASE_URL ?? process.env.INVOICE_PARSER_URL;
  if (parser) return parser.replace(/invoice-parser/, "invoice-alerts");
  return undefined;
}

const ALERTS_BASE = getAlertsBase();

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

  // Look up GCS path from documents table
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

  // Strategy 1: Get signed URL from invoice-alerts Cloud Run service
  if (ALERTS_BASE) {
    try {
      const url = `${ALERTS_BASE.replace(/\/$/, "")}/api/invoices/${documentId}/pdf-url`;
      console.log(`[pdf] Strategy 1: calling ${url}`);
      const res = await cloudRunFetch(url, {
        cache: "no-store",
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) {
        console.warn(`[pdf] Cloud Run returned ${res.status} ${res.statusText}`);
      } else {
        const body = await res.json();
        const signedUrl = body.signed_pdf_url;
        if (!signedUrl) {
          console.warn(`[pdf] Cloud Run returned ok but signed_pdf_url is null`);
        } else {
          const pdfRes = await fetch(signedUrl, { cache: "no-store" });
          if (!pdfRes.ok) {
            console.warn(`[pdf] Signed URL fetch failed: ${pdfRes.status}`);
          } else {
            const pdfBytes = await pdfRes.arrayBuffer();
            const filename = gcs_path.split("/").pop() || "invoice.pdf";
            return new NextResponse(pdfBytes, {
              status: 200,
              headers: {
                "Content-Type": "application/pdf",
                "Content-Disposition": `inline; filename="${filename}"`,
                "Cache-Control": "private, max-age=3600",
              },
            });
          }
        }
      }
    } catch (e) {
      console.warn("[pdf] Strategy 1 error:", e);
    }
  } else {
    console.warn("[pdf] No ALERTS_BASE — INVOICE_API_BASE_URL and PARSER_API_BASE_URL both unset");
  }

  // Strategy 2: Direct GCS fetch using service account
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
        {
          error: `GCS returned ${gcsRes.status}`,
          hint: "Ensure the service account has Storage Object Viewer role on the bucket",
          debug: {
            alerts_base: ALERTS_BASE ?? null,
            has_invoice_api_url: !!process.env.INVOICE_API_BASE_URL,
            has_parser_url: !!(process.env.PARSER_API_BASE_URL ?? process.env.INVOICE_PARSER_URL),
            has_gcp_sa_key: !!process.env.GCP_SA_KEY,
          },
        },
        { status: 502 },
      );
    }

    const pdfBytes = await gcsRes.arrayBuffer();
    const filename = gcs_path.split("/").pop() || "invoice.pdf";

    return new NextResponse(pdfBytes, {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="${filename}"`,
        "Cache-Control": "private, max-age=3600",
      },
    });
  } catch (e) {
    console.error("PDF proxy error:", e);
    return NextResponse.json({ error: "Failed to fetch PDF" }, { status: 500 });
  }
}
