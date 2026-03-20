import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthed } from "@/lib/api-auth";
import { getAirportInfo } from "@/lib/airportCoords";
import { detectOverflightsFromIcao } from "@/lib/overflightDetector";
import { createServiceClient } from "@/lib/supabase/service";

/**
 * GET /api/ops/intl/overflights?dep=KOPF&arr=MYNN
 *
 * Returns the list of countries whose airspace would be overflown.
 * Checks the intl_route_cache first (ForeFlight routes); falls back
 * to great-circle detection if no cached route exists.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;

  const dep = req.nextUrl.searchParams.get("dep")?.toUpperCase();
  const arr = req.nextUrl.searchParams.get("arr")?.toUpperCase();

  if (!dep || !arr) {
    return NextResponse.json({ error: "dep and arr ICAO codes required" }, { status: 400 });
  }

  // Check cache first
  const supa = createServiceClient();
  const { data: cached } = await supa
    .from("intl_route_cache")
    .select("overflights, method, ff_route")
    .eq("dep_icao", dep)
    .eq("arr_icao", arr)
    .maybeSingle();

  if (cached && cached.overflights) {
    const depInfo = getAirportInfo(dep) ?? getAirportInfo(dep.replace(/^K/, ""));
    const arrInfo = getAirportInfo(arr) ?? getAirportInfo(arr.replace(/^K/, ""));
    return NextResponse.json({
      departure: depInfo ? { icao: dep, name: depInfo.name, lat: depInfo.lat, lon: depInfo.lon } : { icao: dep },
      arrival: arrInfo ? { icao: arr, name: arrInfo.name, lat: arrInfo.lat, lon: arrInfo.lon } : { icao: arr },
      overflights: cached.overflights,
      method: cached.method,
      cached: true,
    });
  }

  // No cache — fall back to great-circle
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
    method: "great_circle",
    cached: false,
  });
}
