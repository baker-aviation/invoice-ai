import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthed, isRateLimited } from "@/lib/api-auth";
import { getAirportInfo } from "@/lib/airportCoords";
import { detectOverflightsFromIcao } from "@/lib/overflightDetector";

export const dynamic = "force-dynamic";

const FF_BASE = "https://public-api.foreflight.com/public/api";

/** Aircraft config — registration → default cruise profile MACH */
const AIRCRAFT: Record<string, { mach: string; altitude: number }> = {
  N106PC: { mach: ".85", altitude: 430 },
  N520FX: { mach: ".78", altitude: 410 },
};

function apiKey(): string {
  const key = process.env.FOREFLIGHT_API_KEY;
  if (!key) throw new Error("FOREFLIGHT_API_KEY not set");
  return key;
}

/**
 * GET /api/ops/intl/route-analysis?dep=KOPF&arr=MYNN&tail=N520FX
 *
 * 1. Calls ForeFlight to get the recommended route between two airports
 * 2. Runs great-circle overflight detection as baseline
 * 3. Returns the ForeFlight route string + overflown countries
 *
 * If ForeFlight is unavailable or no tail specified, falls back to great-circle only.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;
  if (await isRateLimited(auth.userId, 10)) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const dep = req.nextUrl.searchParams.get("dep")?.toUpperCase();
  const arr = req.nextUrl.searchParams.get("arr")?.toUpperCase();
  const tail = req.nextUrl.searchParams.get("tail")?.toUpperCase();

  if (!dep || !arr) {
    return NextResponse.json({ error: "dep and arr ICAO codes required" }, { status: 400 });
  }

  const depInfo = getAirportInfo(dep) ?? getAirportInfo(dep.replace(/^K/, ""));
  const arrInfo = getAirportInfo(arr) ?? getAirportInfo(arr.replace(/^K/, ""));

  if (!depInfo || !arrInfo) {
    return NextResponse.json({ error: `Unknown airport: ${!depInfo ? dep : arr}` }, { status: 400 });
  }

  // Great-circle overflight detection (always runs)
  const gcOverflights = detectOverflightsFromIcao(
    dep, depInfo.lat, depInfo.lon,
    arr, arrInfo.lat, arrInfo.lon
  );

  // Try ForeFlight route if we have a tail number and API key
  let ffRoute: string | null = null;
  let ffFlightId: string | null = null;
  let ffError: string | null = null;

  if (tail && process.env.FOREFLIGHT_API_KEY) {
    const acConfig = AIRCRAFT[tail];
    const altitude = acConfig?.altitude ?? 410;

    try {
      // First get cruise profile UUID
      const acRes = await fetch(`${FF_BASE}/aircraft`, {
        headers: { "x-api-key": apiKey() },
      });
      const acData = await acRes.json();
      const acList = Array.isArray(acData) ? acData : acData?.aircraft ?? [];
      const aircraft = acList.find(
        (a: Record<string, unknown>) => (a.aircraftRegistration as string)?.toUpperCase() === tail
      );
      const cruiseUUID = aircraft?.cruiseProfiles?.[0]?.uuid;

      // Create flight plan — let ForeFlight auto-route
      const flightReq = {
        flight: {
          departure: dep,
          destination: arr,
          aircraftRegistration: tail,
          scheduledTimeOfDeparture: new Date(Date.now() + 3600_000).toISOString(),
          ...(cruiseUUID && { cruiseProfileUUID: cruiseUUID }),
          routeToDestination: {
            altitude: { altitude, unit: "FL" },
          },
          windOptions: { windModel: "Forecasted" },
        },
      };

      const flightRes = await fetch(`${FF_BASE}/Flights`, {
        method: "POST",
        headers: { "x-api-key": apiKey(), "Content-Type": "application/json" },
        body: JSON.stringify(flightReq),
      });

      if (flightRes.ok) {
        const flightData = await flightRes.json();
        ffFlightId = flightData.flightId ?? null;

        // Extract the route string from the response
        // ForeFlight returns the auto-computed route in routeToDestination.route
        const routeData = flightData.routeToDestination ?? flightData.route ?? {};
        ffRoute = routeData.route ?? routeData.routeString ?? null;

        // Also check nested performance.navlog for waypoints
        const navlog = flightData.performance?.navlog ?? flightData.navlog;
        if (!ffRoute && navlog && Array.isArray(navlog)) {
          // Build route from navlog waypoint names
          ffRoute = navlog
            .map((wp: Record<string, unknown>) => wp.ident ?? wp.name)
            .filter(Boolean)
            .join(" ");
        }

        // Clean up the flight plan from ForeFlight dispatch
        if (ffFlightId) {
          fetch(`${FF_BASE}/Flights/${encodeURIComponent(ffFlightId)}`, {
            method: "DELETE",
            headers: { "x-api-key": apiKey() },
          }).catch(() => {});
        }
      } else {
        const errText = await flightRes.text();
        ffError = `ForeFlight ${flightRes.status}: ${errText.slice(0, 200)}`;
      }
    } catch (err) {
      ffError = err instanceof Error ? err.message : String(err);
    }
  }

  return NextResponse.json({
    departure: { icao: dep, name: depInfo.name, lat: depInfo.lat, lon: depInfo.lon },
    arrival: { icao: arr, name: arrInfo.name, lat: arrInfo.lat, lon: arrInfo.lon },
    foreflight: {
      route: ffRoute,
      available: !!process.env.FOREFLIGHT_API_KEY,
      error: ffError,
    },
    overflights: gcOverflights,
    method: ffRoute ? "foreflight+great_circle" : "great_circle",
  });
}
