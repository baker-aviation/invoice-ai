import { NextRequest, NextResponse } from "next/server";
import { verifyCronSecret } from "@/lib/api-auth";
import { detectNewAirports } from "@/lib/hasdataCache";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * GET /api/cron/airport-gap-detection
 *
 * Runs every 6 hours. Scans upcoming flights (14 days) for airports with no
 * FBO→commercial alias. Auto-aliases FBOs within 80mi of a commercial airport.
 * Slack-DMs Charlie for airports with no coordinates at all.
 */
export async function GET(req: NextRequest) {
  if (!verifyCronSecret(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await detectNewAirports({ lookAheadDays: 14 });

    return NextResponse.json({
      ok: true,
      total_flight_airports: result.total_flight_airports,
      commercial: result.commercial,
      already_aliased: result.already_aliased,
      auto_aliased: result.auto_aliased.length,
      new_airports: result.new_airports.length,
      new_airport_codes: result.new_airports.map((a) => a.icao),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[cron/airport-gap-detection] error:", msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
