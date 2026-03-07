import "server-only";
import type { FlightInfo } from "./flightaware";

/**
 * Shared in-memory cache for FlightAware flight data.
 * Used by both the flights API route and the webhook route.
 */

let cachedResult: { data: FlightInfo[]; ts: number } | null = null;

// 10 min during business hours (7AM–11PM CT), 20 min overnight
export function getCacheTtl(): number {
  const ct = new Date().toLocaleString("en-US", {
    timeZone: "America/Chicago",
    hour: "numeric",
    hour12: false,
  });
  const hour = parseInt(ct, 10);
  return hour >= 7 && hour < 23 ? 600_000 : 1_200_000;
}

export function getCache() {
  return cachedResult;
}

export function setCache(data: FlightInfo[]) {
  cachedResult = { data, ts: Date.now() };
}

export function invalidateCache() {
  cachedResult = null;
}

export function isCacheFresh(): boolean {
  return cachedResult !== null && Date.now() - cachedResult.ts < getCacheTtl();
}
