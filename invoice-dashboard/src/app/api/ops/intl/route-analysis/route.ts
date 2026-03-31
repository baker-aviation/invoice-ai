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

  // ForeFlight flight-plan based overflight detection
  // Creates a temp flight, fetches full detail (with real overflown countries), then deletes it
  let ffOverflights: Array<{ country_name: string; country_iso: string; fir_id?: string }> = [];
  let ffFirs: Array<Record<string, unknown>> = [];

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
        const createData = await flightRes.json();
        ffFlightId = createData.flightId ?? null;

        // GET the full flight detail — this has the real overflown countries/FIRs
        if (ffFlightId) {
          const detailRes = await fetch(`${FF_BASE}/Flights/${encodeURIComponent(ffFlightId)}`, {
            headers: { "x-api-key": apiKey() },
          });

          if (detailRes.ok) {
            const detail = await detailRes.json();
            const perf = detail.performance;
            const routeInfo = perf?.destinationRouteInformation;
            const fd = detail.flightData;

            // Extract route string
            ffRoute = fd?.routeToDestination?.route ?? null;
            if (!ffRoute || ffRoute === "DCT") {
              // Build from waypoints
              const wps = routeInfo?.waypoints as Array<Record<string, unknown>> | undefined;
              if (wps && wps.length > 2) {
                ffRoute = wps
                  .map((wp) => wp.identifier as string)
                  .filter((id) => id && id !== dep && id !== arr && id !== "-TOC-" && id !== "-TOD-")
                  .join(" ");
              }
            }

            // Extract overflown countries (the real deal — based on actual routing)
            const rawCountries = routeInfo?.overflownCountries as Array<{ name: string; isoCode: string }> | undefined;
            if (rawCountries && rawCountries.length > 0) {
              // Deduplicate and exclude departure/arrival countries
              const seen = new Set<string>();
              ffOverflights = rawCountries
                .filter((c) => {
                  if (seen.has(c.isoCode)) return false;
                  seen.add(c.isoCode);
                  return true;
                })
                .map((c) => ({
                  country_name: c.name,
                  country_iso: c.isoCode,
                }));
              console.log(`[route-analysis] FF overflights ${dep}→${arr}: ${ffOverflights.map(c => c.country_iso).join(", ")}`);
            }

            // Extract FIRs
            const rawFirs = routeInfo?.overflownFirs as Array<Record<string, unknown>> | undefined;
            if (rawFirs && rawFirs.length > 0) {
              ffFirs = rawFirs.map((f) => ({
                identifier: f.identifier,
                name: f.name,
                airspaceType: f.airspaceType,
                entryTime: f.entryTime,
                exitTime: f.exitTime,
              }));
            }

            console.log(`[route-analysis] FF ${dep}→${arr}: route=${ffRoute?.slice(0, 120) ?? "null"}, countries=${ffOverflights.length}, firs=${ffFirs.length}`);
          }

          // Clean up the flight plan from ForeFlight dispatch
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
  }

  // Use ForeFlight overflights if available, otherwise fall back to great-circle
  const overflights = ffOverflights.length > 0 ? ffOverflights : gcOverflights;
  const method = ffOverflights.length > 0 ? "foreflight" : ffRoute ? "foreflight+great_circle" : "great_circle";

  // Cache the result for future overflight badge lookups
  try {
    const supa = createServiceClient();
    await supa.from("intl_route_cache").upsert({
      dep_icao: dep,
      arr_icao: arr,
      ff_route: ffRoute,
      overflights,
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
      overflownCountries: ffOverflights,
      overflownFirs: ffFirs,
      available: !!process.env.FOREFLIGHT_API_KEY,
      error: ffError,
    },
    overflights,
    greatCircleOverflights: gcOverflights,
    method,
  });
}
