import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthed, isRateLimited } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";
import { signGcsUrl } from "@/lib/gcs";
import { cloudRunFetch } from "@/lib/cloud-run-fetch";
import { ALL_CATEGORIES } from "@/lib/invoiceCategory";

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

// ---------------------------------------------------------------------------
// PATCH — Update category override for all invoices in a document
// ---------------------------------------------------------------------------

const VALID_CATEGORIES = new Set([...ALL_CATEGORIES, ""]);

export async function PATCH(
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

  let body: { category_override: string; invoice_id?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const override = body.category_override ?? "";
  if (!VALID_CATEGORIES.has(override)) {
    return NextResponse.json({ error: "Invalid category" }, { status: 400 });
  }

  const supa = createServiceClient();
  const value = override || null; // empty string → null (clear override)

  // If invoice_id provided, update just that one; otherwise update all in the document
  let query = supa
    .from("parsed_invoices")
    .update({ category_override: value })
    .eq("document_id", documentId);

  if (body.invoice_id) {
    query = query.eq("id", body.invoice_id);
  }

  const { error } = await query;
  if (error) {
    console.error("[invoices/PATCH] Update error:", error);
    return NextResponse.json({ error: "Database error" }, { status: 500 });
  }

  // Learn: upsert vendor → category rule so future invoices from this vendor
  // automatically get this category (unless the user clears the override).
  if (value) {
    // Look up vendor_name from the invoice
    const invoiceQuery = body.invoice_id
      ? supa.from("parsed_invoices").select("vendor_name").eq("id", body.invoice_id).maybeSingle()
      : supa.from("parsed_invoices").select("vendor_name").eq("document_id", documentId).limit(1).maybeSingle();

    const { data: inv } = await invoiceQuery;
    const vendorName = inv?.vendor_name as string | null;

    if (vendorName) {
      const vendorNormalized = vendorName.trim().toLowerCase();
      await supa.from("category_rules").upsert(
        {
          vendor_normalized: vendorNormalized,
          vendor_display: vendorName.trim(),
          category: value,
          updated_by: auth.userId,
        },
        { onConflict: "vendor_normalized" },
      );
    }
  }

  return NextResponse.json({ ok: true, category_override: value });
}
