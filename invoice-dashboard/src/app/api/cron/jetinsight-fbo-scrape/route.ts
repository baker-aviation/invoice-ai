import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api-auth";
import { scrapeFboAirports } from "@/lib/jetinsight/fbo-airport-scrape";

export const maxDuration = 300; // 5 min — could be a lot of airports

/**
 * One-time FBO fee scraper from JetInsight /airports/{ICAO} pages.
 *
 * GET /api/jetinsight/scrape-fbos?airports=KTEB,KVNY&dryRun=true
 *   - airports: comma-separated FAA or ICAO codes (optional — defaults to all from flights table)
 *   - dryRun: if "true", returns data without writing to DB
 *   - limit: max airports to scrape (for testing)
 *
 * Auth: cron secret via query param or admin session cookie.
 * In dev, no auth required.
 */
function checkAuth(req: NextRequest): NextResponse | null {
  if (process.env.NODE_ENV !== "production") return null;
  const secret = req.nextUrl.searchParams.get("secret");
  if (secret && secret === process.env.CRON_SECRET) return null;
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}

export async function GET(req: NextRequest) {
  const authErr = checkAuth(req);
  if (authErr) return authErr;

  const params = req.nextUrl.searchParams;
  const airportsParam = params.get("airports");
  const dryRun = params.get("dryRun") === "true";
  const includeDetails = params.get("includeDetails") !== "false"; // default true
  const limit = params.get("limit") ? parseInt(params.get("limit")!, 10) : undefined;
  const offset = params.get("offset") ? parseInt(params.get("offset")!, 10) : undefined;

  const airports = airportsParam
    ? airportsParam.split(",").map((s) => s.trim()).filter(Boolean)
    : undefined;

  try {
    const result = await scrapeFboAirports({ airports, dryRun, limit, offset, includeDetails });
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if ("error" in auth) return auth.error;

  const body = await req.json();
  const { airports, dryRun, limit, offset, includeDetails = true } = body;

  try {
    const result = await scrapeFboAirports({ airports, dryRun, limit, offset, includeDetails });
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
