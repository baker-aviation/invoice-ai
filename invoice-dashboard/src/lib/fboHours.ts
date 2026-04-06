/**
 * FBO hours lookup & parsing.
 * Queries fbo_handling_fees for hours data and determines
 * whether an FBO is open at a given time.
 */

export interface FboHoursEntry {
  airport_code: string;
  fbo_name: string;
  hours: string;
  phone: string;
  is_24hr: boolean;
}

export interface FboHoursInfo {
  name: string;
  hours: string;       // raw string e.g. "06:00 - 22:00"
  phone: string;
  is24hr: boolean;
  openMinutes: number | null;   // minutes from midnight (local), e.g. 360 = 6:00
  closeMinutes: number | null;  // e.g. 1320 = 22:00
}

// ---------------------------------------------------------------------------
// Hours string parser
// ---------------------------------------------------------------------------

/**
 * Parse FBO hours string into open/close minutes from midnight.
 * Handles formats like:
 *   "05:00 - 22:00"
 *   "0600-2200"
 *   "0600ET-2200ET"
 *   "6AM TO 10PM"
 *   "06:30 - 19:00"
 *   "24 hours" / "24/7" → returns null (use is_24hr flag)
 */
export function parseHoursString(hours: string): { open: number | null; close: number | null } {
  if (!hours || /24\s*h|24\/7|always\s*open/i.test(hours)) {
    return { open: null, close: null };
  }

  // Try HH:MM - HH:MM or HHMM-HHMM (with optional timezone suffix like "ET")
  const militaryMatch = hours.match(
    /(\d{1,2}):?(\d{2})\s*(?:[A-Z]{2,4})?\s*[-–—to]+\s*(\d{1,2}):?(\d{2})\s*(?:[A-Z]{2,4})?/i
  );
  if (militaryMatch) {
    const open = parseInt(militaryMatch[1]) * 60 + parseInt(militaryMatch[2]);
    const close = parseInt(militaryMatch[3]) * 60 + parseInt(militaryMatch[4]);
    return { open, close };
  }

  // Try 6AM TO 10PM style
  const ampmMatch = hours.match(
    /(\d{1,2})(?::(\d{2}))?\s*(AM|PM)\s*(?:TO|[-–—])\s*(\d{1,2})(?::(\d{2}))?\s*(AM|PM)/i
  );
  if (ampmMatch) {
    let openH = parseInt(ampmMatch[1]);
    const openM = parseInt(ampmMatch[2] || "0");
    const openP = ampmMatch[3].toUpperCase();
    let closeH = parseInt(ampmMatch[4]);
    const closeM = parseInt(ampmMatch[5] || "0");
    const closeP = ampmMatch[6].toUpperCase();

    if (openP === "PM" && openH !== 12) openH += 12;
    if (openP === "AM" && openH === 12) openH = 0;
    if (closeP === "PM" && closeH !== 12) closeH += 12;
    if (closeP === "AM" && closeH === 12) closeH = 0;

    return { open: openH * 60 + openM, close: closeH * 60 + closeM };
  }

  return { open: null, close: null };
}

/**
 * Check if an FBO is open at a given minute-of-day (local time).
 * Returns true if open, false if closed, null if unknown.
 */
export function isFboOpenAt(info: FboHoursInfo, minuteOfDay: number): boolean | null {
  if (info.is24hr) return true;
  if (info.openMinutes == null || info.closeMinutes == null) return null;

  // Handle overnight hours (e.g. open=600, close=30 means 6AM-12:30AM)
  if (info.closeMinutes <= info.openMinutes) {
    // Overnight: open if after open OR before close
    return minuteOfDay >= info.openMinutes || minuteOfDay < info.closeMinutes;
  }

  return minuteOfDay >= info.openMinutes && minuteOfDay < info.closeMinutes;
}

/**
 * Format minutes-of-day as readable time (e.g. 360 → "6:00 AM")
 */
export function fmtMinutes(m: number): string {
  const h = Math.floor(m / 60);
  const min = m % 60;
  const ampm = h >= 12 ? "PM" : "AM";
  const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return `${h12}:${min.toString().padStart(2, "0")} ${ampm}`;
}

// ---------------------------------------------------------------------------
// DB loader (server-side only)
// ---------------------------------------------------------------------------

let hoursCache: Map<string, FboHoursInfo[]> | null = null;

/**
 * Load FBO hours from DB. Keyed by airport_code (FAA).
 * Returns all FBOs at that airport with hours data.
 */
export async function loadFboHours(): Promise<Map<string, FboHoursInfo[]>> {
  if (hoursCache) return hoursCache;

  const { createServiceClient } = await import("@/lib/supabase/service");
  const supa = createServiceClient();

  const { data } = await supa
    .from("fbo_handling_fees")
    .select("airport_code, fbo_name, hours, phone, is_24hr")
    .not("hours", "is", null)
    .neq("hours", "");

  hoursCache = new Map();
  const seen = new Set<string>(); // dedup by airport+fbo

  for (const row of data ?? []) {
    const key = row.airport_code.toUpperCase();
    const dedupKey = `${key}|${row.fbo_name}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);

    if (!hoursCache.has(key)) hoursCache.set(key, []);
    const { open, close } = parseHoursString(row.hours);
    hoursCache.get(key)!.push({
      name: row.fbo_name,
      hours: row.hours,
      phone: row.phone ?? "",
      is24hr: row.is_24hr ?? false,
      openMinutes: open,
      closeMinutes: close,
    });
  }

  return hoursCache;
}

/**
 * Look up FBO hours for a specific FBO at an airport.
 * Fuzzy matches the fboName against the DB entries.
 */
export function findFboHours(
  hoursMap: Map<string, FboHoursInfo[]>,
  airportCode: string,
  fboName: string,
): FboHoursInfo | null {
  const ap = airportCode.toUpperCase().replace(/^K/, "");
  const entries = hoursMap.get(ap);
  if (!entries || !fboName) return null;

  const fboLower = fboName.toLowerCase();

  // Exact match first
  const exact = entries.find(e => e.name.toLowerCase() === fboLower);
  if (exact) return exact;

  // Partial match — first word or contains
  const match = entries.find(e => {
    const eLower = e.name.toLowerCase();
    return eLower.includes(fboLower) || fboLower.includes(eLower)
      || eLower.split(/\s+/)[0] === fboLower.split(/\s+/)[0];
  });

  return match ?? null;
}

/**
 * Build a serializable fboHoursMap for passing to client components.
 * Key: "TAIL:ICAO" → { hours, is24hr, phone, openMinutes, closeMinutes }
 */
export async function buildFboHoursMap(
  fboMap: Record<string, string>,
): Promise<Record<string, { hours: string; is24hr: boolean; phone: string; openMinutes: number | null; closeMinutes: number | null }>> {
  const hoursDb = await loadFboHours();
  const result: Record<string, { hours: string; is24hr: boolean; phone: string; openMinutes: number | null; closeMinutes: number | null }> = {};

  for (const [key, fboName] of Object.entries(fboMap)) {
    // key is "TAIL:ICAO"
    const icao = key.split(":")[1];
    if (!icao) continue;
    const airport = icao.replace(/^K/, "");
    const info = findFboHours(hoursDb, airport, fboName);
    if (info) {
      result[key] = {
        hours: info.hours,
        is24hr: info.is24hr,
        phone: info.phone,
        openMinutes: info.openMinutes,
        closeMinutes: info.closeMinutes,
      };
    }
  }

  return result;
}
