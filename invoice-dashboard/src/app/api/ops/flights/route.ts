import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthed } from "@/lib/api-auth";
import { fetchFlights } from "@/lib/opsApi";

export const dynamic = "force-dynamic";

/**
 * Lazy-load flights for extended time ranges (Week / Month).
 * The ops page loads today+tomorrow server-side; this endpoint
 * fetches the rest on demand when the user clicks a wider filter.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;

  const lookahead = Math.min(
    Number(req.nextUrl.searchParams.get("lookahead_hours") ?? 168),
    744, // cap at 31 days
  );
  const lookback = Math.min(
    Number(req.nextUrl.searchParams.get("lookback_hours") ?? 48),
    168,
  );

  try {
    const data = await fetchFlights({ lookahead_hours: lookahead, lookback_hours: lookback });
    return NextResponse.json(data);
  } catch (err) {
    console.error("[ops/flights] error:", err);
    return NextResponse.json({ error: "Failed to fetch flights" }, { status: 500 });
  }
}
