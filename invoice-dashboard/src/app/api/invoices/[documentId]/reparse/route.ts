import { NextRequest, NextResponse } from "next/server";
import { cloudRunFetch } from "@/lib/cloud-run-fetch";

/**
 * POST /api/invoices/{documentId}/reparse
 *
 * Triggers a re-parse of the invoice by calling the parser Cloud Run service.
 * Clears old parsed data and re-runs extraction with latest prompt/categories.
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
    const url = `${PARSER_BASE.replace(/\/$/, "")}/jobs/reparse?document_id=${encodeURIComponent(documentId)}`;
    const res = await cloudRunFetch(url, {
      method: "POST",
      cache: "no-store",
      signal: AbortSignal.timeout(60_000), // parsing can take a while
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return NextResponse.json(
        { error: `Parser returned ${res.status}`, detail: text },
        { status: 502 },
      );
    }

    const body = await res.json();
    return NextResponse.json({ ok: true, ...body });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("reparse proxy error:", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
