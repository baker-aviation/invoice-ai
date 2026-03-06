import { NextRequest, NextResponse } from "next/server";
import { fetchInvoices } from "@/lib/invoiceApi";
import { requireAuth, isAuthed } from "@/lib/api-auth";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;

  const sp = req.nextUrl.searchParams;
  try {
    const data = await fetchInvoices({
      limit: Number(sp.get("limit") ?? 200),
      q: sp.get("q") || undefined,
      vendor: sp.get("vendor") || undefined,
      doc_type: sp.get("doc_type") || undefined,
      airport: sp.get("airport") || undefined,
      tail: sp.get("tail") || undefined,
    });
    return NextResponse.json(data);
  } catch {
    return NextResponse.json({ ok: false, error: "Failed to fetch invoices" }, { status: 500 });
  }
}
