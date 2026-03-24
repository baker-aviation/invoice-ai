/**
 * Google Maps Distance Matrix API integration for crew swap drive times.
 * Replaces haversine estimates with real driving distances and durations.
 * Results are cached in Supabase drive_time_cache table.
 */

import { createServiceClient } from "./supabase/service";
import { getAirportCoords } from "./driveTime";

const API_KEY = process.env.GOOGLE_MAPS_API_KEY;

export type DriveTimeResult = {
  origin_icao: string;
  destination_icao: string;
  distance_meters: number;
  duration_seconds: number;
  duration_in_traffic_seconds: number | null;
  origin_address: string;
  destination_address: string;
};

/**
 * Get drive time between two airports using Google Maps Distance Matrix API.
 * Checks Supabase cache first; falls back to API call and caches the result.
 */
export async function getDriveTime(
  originIcao: string,
  destIcao: string,
): Promise<DriveTimeResult | null> {
  if (!API_KEY) {
    console.warn("[GoogleMaps] No GOOGLE_MAPS_API_KEY set — falling back to haversine");
    return null;
  }

  const supa = createServiceClient();

  // Check cache first
  const { data: cached } = await supa
    .from("drive_time_cache")
    .select("*")
    .eq("origin_icao", originIcao)
    .eq("destination_icao", destIcao)
    .limit(1)
    .maybeSingle();

  if (cached) {
    return {
      origin_icao: cached.origin_icao,
      destination_icao: cached.destination_icao,
      distance_meters: cached.distance_meters,
      duration_seconds: cached.duration_seconds,
      duration_in_traffic_seconds: cached.duration_in_traffic_seconds,
      origin_address: cached.origin_address ?? "",
      destination_address: cached.destination_address ?? "",
    };
  }

  // Get airport coordinates for geocoding
  const originCoords = getAirportCoords(originIcao);
  const destCoords = getAirportCoords(destIcao);

  if (!originCoords || !destCoords) {
    console.warn(`[GoogleMaps] No coordinates for ${originIcao} or ${destIcao}`);
    return null;
  }

  // Call Google Maps Distance Matrix API
  const origins = `${originCoords.lat},${originCoords.lon}`;
  const destinations = `${destCoords.lat},${destCoords.lon}`;
  const url = `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${origins}&destinations=${destinations}&units=imperial&key=${API_KEY}`;

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) {
      console.error(`[GoogleMaps] API returned ${res.status}`);
      return null;
    }

    const data = await res.json();
    if (data.status !== "OK" || !data.rows?.[0]?.elements?.[0]) {
      console.error("[GoogleMaps] Bad response:", data.status, data.error_message);
      return null;
    }

    const element = data.rows[0].elements[0];
    if (element.status !== "OK") {
      console.warn(`[GoogleMaps] Route not found: ${originIcao} → ${destIcao} (${element.status})`);
      return null;
    }

    const result: DriveTimeResult = {
      origin_icao: originIcao,
      destination_icao: destIcao,
      distance_meters: element.distance.value,
      duration_seconds: element.duration.value,
      duration_in_traffic_seconds: element.duration_in_traffic?.value ?? null,
      origin_address: data.origin_addresses?.[0] ?? "",
      destination_address: data.destination_addresses?.[0] ?? "",
    };

    // Cache the result
    await supa.from("drive_time_cache").upsert({
      origin_icao: originIcao,
      destination_icao: destIcao,
      distance_meters: result.distance_meters,
      duration_seconds: result.duration_seconds,
      duration_in_traffic_seconds: result.duration_in_traffic_seconds,
      origin_address: result.origin_address,
      destination_address: result.destination_address,
      fetched_at: new Date().toISOString(),
    }, { onConflict: "origin_icao,destination_icao" });

    return result;
  } catch (e) {
    console.error("[GoogleMaps] Fetch error:", e instanceof Error ? e.message : e);
    return null;
  }
}

/**
 * Batch fetch drive times for multiple airport pairs.
 * Google Maps Distance Matrix supports up to 25 origins × 25 destinations per call.
 */
export async function batchGetDriveTimes(
  pairs: { origin: string; destination: string }[],
): Promise<Map<string, DriveTimeResult>> {
  const results = new Map<string, DriveTimeResult>();

  // Process sequentially to respect rate limits (could parallel with small batches)
  for (const { origin, destination } of pairs) {
    const key = `${origin}|${destination}`;
    const result = await getDriveTime(origin, destination);
    if (result) results.set(key, result);
  }

  return results;
}

/**
 * Convert Google Maps duration to minutes (matching driveTime.ts interface).
 */
export function durationToMinutes(durationSeconds: number): number {
  return Math.ceil(durationSeconds / 60);
}

/**
 * Convert Google Maps distance to miles.
 */
export function distanceToMiles(distanceMeters: number): number {
  return Math.round(distanceMeters / 1609.34);
}
