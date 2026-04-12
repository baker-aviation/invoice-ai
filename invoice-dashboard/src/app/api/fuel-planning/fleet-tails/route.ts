import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthed } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";

export const dynamic = "force-dynamic";

/**
 * GET /api/fuel-planning/fleet-tails
 *
 * Returns all active aircraft tails from ics_sources. Used by the
 * Aircraft Fuel Plans page to show "No flights scheduled" cards for
 * tails that don't appear in the generate results.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;

  const supa = createServiceClient();
  const { data, error } = await supa
    .from("ics_sources")
    .select("label, aircraft_type")
    .eq("enabled", true)
    .order("label", { ascending: true });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const tails = (data ?? [])
    .filter((r) => r.label && /^N\d/.test(r.label))
    .map((r) => ({
      tail: r.label as string,
      aircraftType: r.aircraft_type ?? "unknown",
    }));

  return NextResponse.json({ tails });
}
