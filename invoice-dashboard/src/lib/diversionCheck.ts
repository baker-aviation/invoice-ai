import "server-only";
import { createServiceClient } from "@/lib/supabase/service";
import { getAirportInfo, distNm } from "@/lib/airportCoords";

// ---------------------------------------------------------------------------
// Distance sanity check
// ---------------------------------------------------------------------------

export type DistanceCheckResult = {
  reasonable: boolean;
  distanceNm: number | null;
  reason: string;
};

/**
 * Check whether a reported diversion destination makes geographic sense.
 *
 * A real diversion goes to an airport near the route corridor (alternate,
 * nearby field, etc.). False positives from FlightAware often report
 * airports hundreds of miles off the route (e.g. CYWE / Wemindji for a
 * flight to CYFJ / Mont-Tremblant).
 */
export function isDiversionDistanceReasonable(params: {
  origin_icao: string;
  destination_icao: string | null;   // original planned destination
  diverted_to_icao: string | null;   // where FA says it diverted to
}): DistanceCheckResult {
  const { origin_icao, destination_icao, diverted_to_icao } = params;

  // Can't check without a diversion airport
  if (!diverted_to_icao) {
    return { reasonable: true, distanceNm: null, reason: "no diversion ICAO to check" };
  }

  // Same as original destination — not really a diversion, but not unreasonable
  if (destination_icao && diverted_to_icao === destination_icao) {
    return { reasonable: true, distanceNm: 0, reason: "diversion airport matches original destination" };
  }

  const originInfo = getAirportInfo(origin_icao);
  const destInfo = destination_icao ? getAirportInfo(destination_icao) : null;
  const divInfo = getAirportInfo(diverted_to_icao);

  // If we can't look up coordinates, don't suppress — let the 5-min verify catch it
  if (!originInfo || !divInfo) {
    return { reasonable: true, distanceNm: null, reason: "missing coordinate data — skipping distance check" };
  }

  const dOrigDiv = distNm(originInfo.lat, originInfo.lon, divInfo.lat, divInfo.lon);

  // Same-airport check: diversion airport is essentially the origin (<30nm)
  if (dOrigDiv < 30) {
    // Return-to-field is technically possible but rare — let it go to pending verification
    return { reasonable: true, distanceNm: dOrigDiv, reason: "near-origin return-to-field" };
  }

  // If we have the original destination, do route corridor check
  if (destInfo) {
    const dOrigDest = distNm(originInfo.lat, originInfo.lon, destInfo.lat, destInfo.lon);
    const dDestDiv = distNm(destInfo.lat, destInfo.lon, divInfo.lat, divInfo.lon);

    // Route corridor: orig→div + div→dest should be at most 2x the direct route.
    // A real diversion to a nearby alternate adds maybe 10-30% detour.
    // A bogus diversion to an airport 800nm off course will blow past 2x.
    const detourRatio = dOrigDest > 0 ? (dOrigDiv + dDestDiv) / dOrigDest : Infinity;

    if (detourRatio > 2.0) {
      return {
        reasonable: false,
        distanceNm: dDestDiv,
        reason: `diversion airport ${diverted_to_icao} is ${Math.round(dDestDiv)}nm from destination, detour ratio ${detourRatio.toFixed(1)}x (>2.0x threshold)`,
      };
    }

    // Absolute cap: diversion airport shouldn't be 500nm+ past the destination
    if (dOrigDiv > dOrigDest + 500) {
      return {
        reasonable: false,
        distanceNm: dOrigDiv,
        reason: `diversion airport ${diverted_to_icao} is ${Math.round(dOrigDiv - dOrigDest)}nm beyond destination (>500nm threshold)`,
      };
    }
  }

  return { reasonable: true, distanceNm: dOrigDiv, reason: "within route corridor" };
}

// ---------------------------------------------------------------------------
// Pending diversion management
// ---------------------------------------------------------------------------

/**
 * Insert a pending diversion record instead of firing the alert immediately.
 * Returns true if inserted, false if a record already exists (dedup).
 */
export async function createPendingDiversion(params: {
  fa_flight_id: string;
  registration: string;
  origin_icao: string | null;
  destination_icao: string | null;
  original_destination: string | null;
  flight_id: string;
  message: string;
  source: "webhook" | "run-checks";
  distance_suspect?: boolean;
}): Promise<boolean> {
  const supa = createServiceClient();

  const { error } = await supa.from("pending_diversions").upsert(
    {
      fa_flight_id: params.fa_flight_id,
      registration: params.registration,
      origin_icao: params.origin_icao,
      destination_icao: params.destination_icao,
      original_destination: params.original_destination,
      flight_id: params.flight_id,
      diversion_message: params.message,
      source: params.source,
      distance_suspect: params.distance_suspect ?? false,
      status: "pending",
    },
    { onConflict: "fa_flight_id,flight_id" },
  );

  if (error) {
    console.error("[diversionCheck] createPendingDiversion error:", error.message);
    return false;
  }
  return true;
}

/**
 * Check if a pending diversion already exists for a given flight.
 */
export async function hasPendingDiversion(
  faFlightId: string,
  flightId: string,
): Promise<boolean> {
  const supa = createServiceClient();
  const { count } = await supa
    .from("pending_diversions")
    .select("id", { count: "exact", head: true })
    .eq("fa_flight_id", faFlightId)
    .eq("flight_id", flightId)
    .eq("status", "pending");
  return (count ?? 0) > 0;
}
