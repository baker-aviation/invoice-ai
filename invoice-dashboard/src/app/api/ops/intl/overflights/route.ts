import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthed } from "@/lib/api-auth";
import { getAirportInfo } from "@/lib/airportCoords";
import { detectOverflightsFromIcao } from "@/lib/overflightDetector";

/**
 * GET /api/ops/intl/overflights?dep=KOPF&arr=MYNN
 *
 * Returns the list of countries whose airspace would be overflown
 * on a great-circle route between the two airports.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;

  const dep = req.nextUrl.searchParams.get("dep")?.toUpperCase();
  const arr = req.nextUrl.searchParams.get("arr")?.toUpperCase();

  if (!dep || !arr) {
    return NextResponse.json({ error: "dep and arr ICAO codes required" }, { status: 400 });
  }

  // Strip leading K for ICAO→IATA lookup fallback
  const depInfo = getAirportInfo(dep) ?? getAirportInfo(dep.replace(/^K/, ""));
  const arrInfo = getAirportInfo(arr) ?? getAirportInfo(arr.replace(/^K/, ""));

  if (!depInfo) {
    return NextResponse.json({ error: `Unknown departure airport: ${dep}` }, { status: 400 });
  }
  if (!arrInfo) {
    return NextResponse.json({ error: `Unknown arrival airport: ${arr}` }, { status: 400 });
  }

  const overflights = detectOverflightsFromIcao(
    dep, depInfo.lat, depInfo.lon,
    arr, arrInfo.lat, arrInfo.lon
  );

  return NextResponse.json({
    departure: { icao: dep, name: depInfo.name, lat: depInfo.lat, lon: depInfo.lon },
    arrival: { icao: arr, name: arrInfo.name, lat: arrInfo.lat, lon: arrInfo.lon },
    overflights,
  });
}
