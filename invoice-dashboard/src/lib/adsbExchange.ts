/**
 * ADS-B Exchange globe_history client.
 *
 * Fetches historical ADS-B track data from the free globe_history endpoint.
 * No API key needed — this is publicly broadcast ADS-B data served as static JSON.
 *
 * URL pattern: globe_history/YYYY/MM/DD/traces/{last2hex}/trace_full_{hex}.json
 */

// N-number to ICAO24 hex mapping for Baker Aviation fleet
// Generated via icao-nnumber-converter-us package, verified against ADS-B Exchange
export const FLEET_HEX: Record<string, string> = {
  N102VR: "a00e0d", N106PC: "a01c46", N125DZ: "a066a8", N125TH: "a067f6",
  N187CR: "a15aef", N201HR: "a19679", N301HR: "a323c8", N371DB: "a437cf",
  N416F: "a4eae7", N513JB: "a66d5e", N519FX: "a68371", N51GB: "a65fae",
  N521FX: "a68d38", N526FX: "a69fcb", N541FX: "a6dc36", N552FX: "a7076c",
  N553FX: "a70b23", N554FX: "a70eda", N555FX: "a71291", N700LH: "a95590",
  N703TX: "a96172", N733FL: "a9d6b8", N818CF: "ab274c", N860TX: "abd096",
  N883TR: "ac2ab3", N939TX: "ad08d7", N954JS: "ad445c", N955GH: "ad47d8",
  N957JS: "ad4f81", N971JS: "ad8835", N988TX: "adca9b", N992MG: "addb2b",
  N998CX: "adf0a3",
};

export interface AdsbxPosition {
  t: string;    // ISO timestamp
  alt: number;  // flight level (hundreds of feet)
  gs: number | null;
  lat: number;
  lon: number;
}

/**
 * Fetch ADS-B track for a specific tail on a specific date from ADS-B Exchange.
 * Returns array of flights (split by ground segments).
 * Free, no API key, ~2-3 weeks of history available.
 */
export async function fetchAdsbxTrace(
  tailNumber: string,
  date: string, // YYYY-MM-DD
): Promise<Array<{ positions: AdsbxPosition[]; maxAlt: number | null; totalSec: number | null }>> {
  const hex = FLEET_HEX[tailNumber];
  if (!hex) return [];

  const last2 = hex.slice(-2);
  const dateSlash = date.replace(/-/g, "/");
  const url = `https://globe.adsbexchange.com/globe_history/${dateSlash}/traces/${last2}/trace_full_${hex}.json`;

  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        Referer: `https://globe.adsbexchange.com/?icao=${hex}`,
      },
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) return [];
    const data = await res.json();
    const trace = data.trace as Array<unknown[]>;
    const baseTs = (data.timestamp as number) ?? 0;

    if (!trace || trace.length < 10) return [];

    // Convert to our format
    const allPositions: AdsbxPosition[] = trace.map((t) => {
      const alt = t[3];
      return {
        t: new Date((baseTs + (t[0] as number)) * 1000).toISOString(),
        alt: alt === "ground" || alt == null ? 0 : Math.round((alt as number) / 100),
        gs: t[4] != null ? Math.round(t[4] as number) : null,
        lat: Math.round((t[1] as number) * 10000) / 10000,
        lon: Math.round((t[2] as number) * 10000) / 10000,
      };
    });

    // Split into individual flights by ground segments
    const flights: Array<{ positions: AdsbxPosition[]; maxAlt: number | null; totalSec: number | null }> = [];
    let current: AdsbxPosition[] = [];
    let wasAirborne = false;

    for (const p of allPositions) {
      const airborne = p.alt > 5;
      if (airborne) {
        current.push(p);
        wasAirborne = true;
      } else if (wasAirborne) {
        if (current.length > 15) {
          const alts = current.filter((pt) => pt.alt > 0).map((pt) => pt.alt);
          const t0 = new Date(current[0].t).getTime();
          const t1 = new Date(current[current.length - 1].t).getTime();
          flights.push({
            positions: current,
            maxAlt: alts.length > 0 ? Math.max(...alts) : null,
            totalSec: Math.round((t1 - t0) / 1000),
          });
        }
        current = [];
        wasAirborne = false;
      }
    }
    if (current.length > 15) {
      const alts = current.filter((pt) => pt.alt > 0).map((pt) => pt.alt);
      const t0 = new Date(current[0].t).getTime();
      const t1 = new Date(current[current.length - 1].t).getTime();
      flights.push({
        positions: current,
        maxAlt: alts.length > 0 ? Math.max(...alts) : null,
        totalSec: Math.round((t1 - t0) / 1000),
      });
    }

    return flights;
  } catch {
    return [];
  }
}
