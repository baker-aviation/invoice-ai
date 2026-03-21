import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthed, isRateLimited } from "@/lib/api-auth";
import { getAirportInfo } from "@/lib/airportCoords";
import { detectOverflightsFromIcao } from "@/lib/overflightDetector";
import { createServiceClient } from "@/lib/supabase/service";

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
  let ffRecommendedRoutes: Array<{ routeString: string; source: string }> = [];

  if (process.env.FOREFLIGHT_API_KEY) {
    // First try the recommended routes endpoint (doesn't need a tail number)
    try {
      const routesUrl = `${FF_BASE}/routes/${dep}/${arr}`;
      console.log(`[route-analysis] Fetching recommended routes: ${routesUrl}`);
      const routesRes = await fetch(routesUrl, {
        headers: { "x-api-key": apiKey() },
      });
      console.log(`[route-analysis] Routes response: ${routesRes.status} ${routesRes.statusText}`);
      if (routesRes.ok) {
        const routesData = await routesRes.json();
        console.log(`[route-analysis] Routes raw keys: ${JSON.stringify(Object.keys(routesData))}, data preview: ${JSON.stringify(routesData).slice(0, 300)}`);
        const routes = routesData.routes ?? routesData ?? [];
        if (Array.isArray(routes) && routes.length > 0) {
          // Log first route object keys to understand structure
          console.log(`[route-analysis] First route keys: ${JSON.stringify(Object.keys(routes[0]))}`);
          ffRecommendedRoutes = routes.slice(0, 5).map((r: Record<string, unknown>) => ({
            routeString: (r.routeString ?? r.route ?? r.routeText ?? r.routeOfFlight ?? "") as string,
            source: (r.source ?? r.type ?? "recommended") as string,
          })).filter((r: { routeString: string }) => r.routeString && r.routeString !== "DCT");

          // Use the first recommended route as the primary
          if (ffRecommendedRoutes.length > 0) {
            ffRoute = ffRecommendedRoutes[0].routeString;
          }
        }
        console.log(`[route-analysis] FF routes ${dep}→${arr}: ${ffRecommendedRoutes.length} recommended, best=${ffRoute?.slice(0, 80) ?? "none"}`);
      } else {
        const errText = await routesRes.text();
        console.warn(`[route-analysis] Routes endpoint ${routesRes.status}: ${errText.slice(0, 200)}`);
      }
    } catch (err) {
      console.warn(`[route-analysis] FF routes endpoint failed for ${dep}→${arr}:`, err instanceof Error ? err.message : err);
    }
  }

  if (!ffRoute && tail && process.env.FOREFLIGHT_API_KEY) {
    const acConfig = AIRCRAFT[tail];
    const altitude = acConfig?.altitude ?? 410;

    try {
      // Get cruise profile UUID
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
        // ForeFlight wraps everything in { flight: { ... } }
        const fd = flightData.flight ?? flightData;
        ffFlightId = fd.flightId ?? null;

        // Extract the route string — try multiple known locations
        const routeData = fd.routeToDestination ?? fd.route ?? {};
        ffRoute = routeData.route ?? routeData.routeString ?? fd.routeString ?? null;

        // Check navlog for waypoints if no route string
        const navlog = fd.performance?.navlog ?? fd.navlog;
        if (!ffRoute && navlog && Array.isArray(navlog)) {
          ffRoute = navlog
            .map((wp: Record<string, unknown>) => wp.ident ?? wp.name)
            .filter(Boolean)
            .join(" ");
        }

        // Try flightData sub-object
        if (fd.flightData) {
          const fdd = fd.flightData;
          if (!ffRoute || ffRoute === "DCT") {
            ffRoute = fdd.route ?? fdd.routeString ?? fdd.routeToDestination?.route ?? ffRoute;
          }
        }

        // Extract route from navlog waypoints (most reliable source)
        const navlog = fd.performance?.navlog ?? fd.performance?.waypoints;
        if (navlog && Array.isArray(navlog) && navlog.length > 2) {
          // Log first waypoint to understand structure
          console.log(`[route-analysis] FF ${dep}→${arr}: navlog[0] keys=${Object.keys(navlog[0]).join(",")}`);
          const wpRoute = navlog
            .map((wp: Record<string, unknown>) => wp.ident ?? wp.waypointName ?? wp.name ?? wp.fixName)
            .filter((id: unknown) => id && id !== dep && id !== arr) // exclude dep/arr
            .join(" ");
          if (wpRoute && wpRoute.length > 0) {
            ffRoute = wpRoute;
          }
          console.log(`[route-analysis] FF ${dep}→${arr}: navlog ${navlog.length} waypoints, route=${ffRoute?.slice(0, 120) ?? "null"}`);
        } else {
          // Log performance keys to find navlog
          console.log(`[route-analysis] FF ${dep}→${arr}: perf keys=${fd.performance ? Object.keys(fd.performance).join(",") : "none"}, route=${ffRoute ?? "null"}`);
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

    if (ffError) console.warn(`[route-analysis] ForeFlight error for ${dep}→${arr}:`, ffError);
    if (ffRoute) console.log(`[route-analysis] ForeFlight route ${dep}→${arr}:`, ffRoute);
  }

  const method = ffRoute ? "foreflight+great_circle" : "great_circle";

  // Cache the result for future overflight badge lookups
  try {
    const supa = createServiceClient();
    await supa.from("intl_route_cache").upsert({
      dep_icao: dep,
      arr_icao: arr,
      ff_route: ffRoute,
      overflights: gcOverflights,
      method,
      tail_used: tail ?? null,
      cached_at: new Date().toISOString(),
    }, { onConflict: "dep_icao,arr_icao" });
  } catch {
    // Non-critical — don't fail the response if cache write fails
  }

  return NextResponse.json({
    departure: { icao: dep, name: depInfo.name, lat: depInfo.lat, lon: depInfo.lon },
    arrival: { icao: arr, name: arrInfo.name, lat: arrInfo.lat, lon: arrInfo.lon },
    foreflight: {
      route: ffRoute,
      recommendedRoutes: ffRecommendedRoutes,
      available: !!process.env.FOREFLIGHT_API_KEY,
      error: ffError,
    },
    overflights: gcOverflights,
    method,
  });
}
