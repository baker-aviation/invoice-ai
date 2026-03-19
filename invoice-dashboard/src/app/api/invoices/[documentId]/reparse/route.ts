import { NextRequest, NextResponse } from "next/server";
import { cloudRunFetch } from "@/lib/cloud-run-fetch";
import { createServiceClient } from "@/lib/supabase/service";
import { requireAdmin, isRateLimited } from "@/lib/api-auth";

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
  req: NextRequest,
  { params }: { params: Promise<{ documentId: string }> },
) {
  const auth = await requireAdmin(req);
  if ("error" in auth) return auth.error;
  if (await isRateLimited(auth.userId, 10)) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

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

    // Fire-and-forget: trigger the parser without waiting for it to finish.
    // Parsing can take 30-120s (OpenAI extraction + validation) which exceeds
    // Vercel's serverless timeout. The document status goes uploaded → processing
    // → done, and the frontend polls until it completes.
    const url = `${PARSER_BASE.replace(/\/$/, "")}/jobs/parse_document?document_id=${encodeURIComponent(documentId)}`;
    cloudRunFetch(url, {
      method: "POST",
      cache: "no-store",
      signal: AbortSignal.timeout(180_000),
    }).catch((e) =>
      console.error("reparse background call failed:", e),
    );

    return NextResponse.json({ ok: true, reparse: true, status: "started" });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("reparse proxy error:", msg);
    return NextResponse.json({ error: "Reparse failed" }, { status: 500 });
  }
}
