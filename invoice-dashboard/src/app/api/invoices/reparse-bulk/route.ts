import { NextRequest, NextResponse } from "next/server";
import { cloudRunFetch } from "@/lib/cloud-run-fetch";
import { createServiceClient } from "@/lib/supabase/service";
import { requireAdmin, isRateLimited } from "@/lib/api-auth";

/**
 * POST /api/invoices/reparse-bulk
 *
 * Body: { document_ids: string[] }
 *
 * Clears old parsed data and fires off reparse for each document in parallel.
 * Max 50 documents per request.
 */

const PARSER_BASE =
  process.env.PARSER_API_BASE_URL ?? process.env.INVOICE_PARSER_URL;

const UUID_RE = /^[a-f0-9-]{36}$/;
const MAX_BATCH = 50;

export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if ("error" in auth) return auth.error;
  if (isRateLimited(auth.userId, 3)) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  if (!PARSER_BASE) {
    return NextResponse.json(
      { error: "PARSER_API_BASE_URL not configured" },
      { status: 503 },
    );
  }

  let body: { document_ids: string[] };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const ids = body.document_ids ?? [];
  if (!Array.isArray(ids) || ids.length === 0) {
    return NextResponse.json({ error: "document_ids required" }, { status: 400 });
  }
  if (ids.length > MAX_BATCH) {
    return NextResponse.json({ error: `Max ${MAX_BATCH} documents per batch` }, { status: 400 });
  }

  const validIds = ids.filter((id) => UUID_RE.test(id));
  if (validIds.length === 0) {
    return NextResponse.json({ error: "No valid document IDs" }, { status: 400 });
  }

  const supa = createServiceClient();
  const results: { id: string; status: string }[] = [];

  // Process all documents: clear old data and trigger reparse
  await Promise.all(
    validIds.map(async (documentId) => {
      try {
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

        // Reset document status
        await supa
          .from("documents")
          .update({ status: "uploaded", parse_error: null })
          .eq("id", documentId);

        // Fire-and-forget reparse
        const url = `${PARSER_BASE!.replace(/\/$/, "")}/jobs/parse_document?document_id=${encodeURIComponent(documentId)}`;
        cloudRunFetch(url, {
          method: "POST",
          cache: "no-store",
          signal: AbortSignal.timeout(180_000),
        }).catch(() => {});

        results.push({ id: documentId, status: "started" });
      } catch {
        results.push({ id: documentId, status: "error" });
      }
    }),
  );

  return NextResponse.json({
    ok: true,
    total: results.length,
    started: results.filter((r) => r.status === "started").length,
    results,
  });
}
