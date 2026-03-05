import { NextRequest, NextResponse } from "next/server";
import { fetchInvoices } from "@/lib/invoiceApi";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
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
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e.message }, { status: 500 });
  }
}
