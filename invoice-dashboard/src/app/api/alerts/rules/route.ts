import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthed } from "@/lib/api-auth";
import { fetchAlertRules } from "@/lib/invoiceApi";

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;

  try {
    const rules = await fetchAlertRules();
    return NextResponse.json({ ok: true, rules });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "Failed to fetch rules" }, { status: 500 });
  }
}
