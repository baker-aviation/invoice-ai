import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthed, isRateLimited } from "@/lib/api-auth";
import { fetchFuelPrices } from "@/lib/invoiceApi";

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;
  if (isRateLimited(auth.userId)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  const { searchParams } = req.nextUrl;
  const limit = Math.min(Number(searchParams.get("limit") ?? 200), 3000);
  const airport = searchParams.get("airport") ?? undefined;
  const vendor = searchParams.get("vendor") ?? undefined;
  const q = searchParams.get("q") ?? undefined;

  try {
    const data = await fetchFuelPrices({ limit, airport, vendor, q });
    return NextResponse.json(data);
  } catch {
    return NextResponse.json({ error: "Failed to fetch fuel prices" }, { status: 502 });
  }
}
