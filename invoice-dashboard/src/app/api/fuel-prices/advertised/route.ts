import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthed } from "@/lib/api-auth";
import { fetchAdvertisedPrices } from "@/lib/invoiceApi";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;

  const weeks = Math.min(Number(req.nextUrl.searchParams.get("weeks") ?? 8), 52);

  try {
    const data = await fetchAdvertisedPrices({ recentWeeks: weeks });
    return NextResponse.json({ prices: data });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
