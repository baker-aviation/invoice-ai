// Drive time estimates using straight-line (haversine) distance + speed heuristic.
// No external API needed — good enough for crew swap planning.

// ─── Airport coordinates (US airports commonly used by Baker) ────────────────
// ICAO → [lat, lon]. Add more as needed.

const AIRPORT_COORDS: Record<string, [number, number]> = {
  // Texas
  KIAH: [29.9844, -95.3414],   // Houston Intercontinental
  KHOU: [29.6454, -95.2789],   // Houston Hobby
  KDFW: [32.8968, -97.0380],   // Dallas/Fort Worth
  KDAL: [32.8471, -96.8518],   // Dallas Love Field
  KAUS: [30.1945, -97.6699],   // Austin
  KSAT: [29.5337, -98.4698],   // San Antonio
  KELP: [31.8072, -106.3776],  // El Paso

  // Florida
  KMIA: [25.7959, -80.2870],   // Miami International
  KOPF: [25.9068, -80.2784],   // Opa-locka (FBO)
  KFLL: [26.0726, -80.1527],   // Fort Lauderdale
  KPBI: [26.6832, -80.0956],   // Palm Beach
  KTPA: [27.9755, -82.5332],   // Tampa
  KMCO: [28.4294, -81.3090],   // Orlando
  KJAX: [30.4941, -81.6879],   // Jacksonville
  KFXE: [26.1973, -80.1707],   // Fort Lauderdale Executive

  // Northeast
  KTEB: [40.8501, -74.0608],   // Teterboro (FBO)
  KEWR: [40.6925, -74.1687],   // Newark
  KJFK: [40.6413, -73.7781],   // JFK
  KLGA: [40.7769, -73.8740],   // LaGuardia
  KHPN: [41.0670, -73.7076],   // Westchester
  KBDR: [41.1635, -73.1262],   // Bridgeport/Sikorsky
  KPHL: [39.8721, -75.2411],   // Philadelphia
  KBOS: [42.3656, -71.0096],   // Boston Logan
  KBED: [42.4700, -71.2890],   // Bedford/Hanscom

  // California
  KVNY: [34.2098, -118.4897],  // Van Nuys (FBO)
  KBUR: [34.2007, -118.3585],  // Burbank
  KLAX: [33.9425, -118.4081],  // Los Angeles
  KSNA: [33.6757, -117.8683],  // Santa Ana/John Wayne
  KSAN: [32.7336, -117.1897],  // San Diego
  KSFO: [37.6213, -122.3790],  // San Francisco
  KSJC: [37.3626, -121.9291],  // San Jose
  KOAK: [37.7213, -122.2208],  // Oakland

  // Southeast
  KATL: [33.6407, -84.4277],   // Atlanta
  KPDK: [33.8756, -84.3020],   // DeKalb-Peachtree (FBO)
  KCLT: [35.2140, -80.9431],   // Charlotte
  KRDU: [35.8776, -78.7875],   // Raleigh-Durham
  KBNA: [36.1245, -86.6782],   // Nashville
  KMEM: [35.0424, -89.9767],   // Memphis

  // Midwest
  KORD: [41.9742, -87.9073],   // Chicago O'Hare
  KMDW: [41.7868, -87.7416],   // Chicago Midway
  KPWK: [42.1142, -87.9015],   // Chicago Executive (FBO)
  KDTW: [42.2124, -83.3534],   // Detroit
  KMSP: [44.8820, -93.2218],   // Minneapolis
  KIND: [39.7173, -86.2944],   // Indianapolis
  KCVG: [39.0488, -84.6678],   // Cincinnati

  // Mountain/West
  KDEN: [39.8561, -104.6737],  // Denver
  KAPA: [39.5701, -104.8493],  // Centennial (FBO)
  KLAS: [36.0840, -115.1537],  // Las Vegas
  KPHX: [33.4373, -112.0078],  // Phoenix
  KSDL: [33.6229, -111.9105],  // Scottsdale (FBO)
  KSLC: [40.7884, -111.9778],  // Salt Lake City
  KASE: [39.2232, -106.8688],  // Aspen
  KEGE: [39.6426, -106.9159],  // Eagle/Vail

  // DC area
  KIAD: [38.9445, -77.4558],   // Dulles
  KDCA: [38.8512, -77.0402],   // Reagan National
  KBWI: [39.1754, -76.6683],   // Baltimore

  // Other
  KMSY: [29.9934, -90.2580],   // New Orleans
  KSTL: [38.7487, -90.3700],   // St. Louis
  KABQ: [35.0402, -106.6094],  // Albuquerque
  KTUL: [36.1984, -95.8881],   // Tulsa
  KOKC: [35.3931, -97.6007],   // Oklahoma City
};

// ─── Haversine ───────────────────────────────────────────────────────────────

function haversineMiles(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 3959; // Earth radius in miles
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ─── Public API ──────────────────────────────────────────────────────────────

export type DriveEstimate = {
  origin: string;
  destination: string;
  straight_line_miles: number;
  estimated_drive_miles: number;
  estimated_drive_minutes: number;
  feasible: boolean; // < 4 hours (typical crew transport cutoff)
};

/**
 * Estimate drive time between two airports using straight-line distance.
 * Uses 1.3x multiplier for road vs straight-line, 45 mph average speed.
 */
export function estimateDriveTime(originIcao: string, destIcao: string): DriveEstimate | null {
  const orig = AIRPORT_COORDS[originIcao.toUpperCase()];
  const dest = AIRPORT_COORDS[destIcao.toUpperCase()];
  if (!orig || !dest) return null;

  const straightMiles = haversineMiles(orig[0], orig[1], dest[0], dest[1]);
  const driveMiles = straightMiles * 1.3; // road distance multiplier
  const driveMinutes = (driveMiles / 45) * 60; // 45 mph average

  return {
    origin: originIcao.toUpperCase(),
    destination: destIcao.toUpperCase(),
    straight_line_miles: Math.round(straightMiles),
    estimated_drive_miles: Math.round(driveMiles),
    estimated_drive_minutes: Math.round(driveMinutes),
    feasible: driveMinutes <= 240, // 4 hour cutoff
  };
}

/**
 * Check if an airport is in our coordinate database.
 */
export function hasCoords(icao: string): boolean {
  return icao.toUpperCase() in AIRPORT_COORDS;
}

/**
 * Get all known airport codes.
 */
export function knownAirports(): string[] {
  return Object.keys(AIRPORT_COORDS);
}
