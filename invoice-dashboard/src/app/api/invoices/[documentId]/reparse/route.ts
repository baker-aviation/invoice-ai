import { NextRequest, NextResponse } from "next/server";
import { cloudRunFetch } from "@/lib/cloud-run-fetch";
import { createServiceClient } from "@/lib/supabase/service";

/**
 * POST /api/invoices/{documentId}/reparse
 *
 * Clears old parsed data via Supabase, then triggers parse_document
 * on the parser Cloud Run service (which is already deployed).
 */

const PARSER_BASE =
  process.env.PARSER_API_BASE_URL ?? process.env.INVOICE_PARSER_URL;

const SAFE_ID_RE = /^[a-f0-9-]{36}$/;

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ documentId: string }> },
) {
  const { documentId } = await params;
  if (!SAFE_ID_RE.test(documentId)) {
    return NextResponse.json({ error: "Invalid document ID" }, { status: 400 });
  }

  if (!PARSER_BASE) {
    return NextResponse.json(
      { error: "PARSER_API_BASE_URL not configured" },
      { status: 503 },
    );
  }

  try {
    const supa = createServiceClient();

    // Verify document exists
    const { data: doc } = await supa
      .from("documents")
      .select("id")
      .eq("id", documentId)
      .single();

    if (!doc) {
      return NextResponse.json(
        { error: "Document not found" },
        { status: 404 },
      );
    }

    // Clean up old parsed data
    const { data: parsedInvoices } = await supa
      .from("parsed_invoices")
      .select("id")
      .eq("document_id", documentId);

    const piIds = (parsedInvoices ?? []).map((r) => r.id);

    if (piIds.length > 0) {
      for (const piId of piIds) {
        await supa
          .from("parsed_line_items")
          .delete()
          .eq("parsed_invoice_id", piId);
      }
    }

    await supa.from("parsed_invoices").delete().eq("document_id", documentId);
    await supa.from("invoice_alerts").delete().eq("document_id", documentId);

    // Reset document status so parse_document will process it
    await supa
      .from("documents")
      .update({ status: "uploaded", parse_error: null })
      .eq("id", documentId);

    // Call the already-deployed /jobs/parse_document endpoint
    const url = `${PARSER_BASE.replace(/\/$/, "")}/jobs/parse_document?document_id=${encodeURIComponent(documentId)}`;
    const res = await cloudRunFetch(url, {
      method: "POST",
      cache: "no-store",
      signal: AbortSignal.timeout(180_000),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return NextResponse.json(
        { error: `Parser returned ${res.status}`, detail: text },
        { status: 502 },
      );
    }

    const body = await res.json();
    return NextResponse.json({ ok: true, ...body, reparse: true });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("reparse proxy error:", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
