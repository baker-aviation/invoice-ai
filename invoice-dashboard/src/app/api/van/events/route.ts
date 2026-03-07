import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthed } from "@/lib/api-auth";
import { processFlightEvents, getRecentEvents } from "@/lib/flightEvents";

export const dynamic = "force-dynamic";

// GET: fetch recent events, optionally filtered by tail numbers
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;

  const tails = req.nextUrl.searchParams.get("tails")?.split(",").filter(Boolean);

  // Process any unprocessed events first
  const newAlerts = await processFlightEvents();

  // Then fetch recent events for display
  const events = await getRecentEvents(tails);

  return NextResponse.json({
    ok: true,
    events,
    new_alerts: newAlerts,
  });
}
