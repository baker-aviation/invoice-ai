// Drive time estimates using straight-line (haversine) distance + speed heuristic.
// No external API needed — good enough for crew swap planning.

// ─── Airport coordinates (US airports commonly used by Baker) ────────────────
// ICAO → [lat, lon]. Add more as needed.

const AIRPORT_COORDS: Record<string, [number, number]> = {
  // Texas
  KIAH: [29.9844, -95.3414],   // Houston Intercontinental
  KHOU: [29.6454, -95.2789],   // Houston Hobby
  KDWH: [30.0618, -95.5528],   // David Wayne Hooks (FBO, near IAH)
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
  KGRR: [42.8808, -85.5228],   // Grand Rapids
  KESC: [45.7227, -87.0937],   // Escanaba MI
  KMSP: [44.8820, -93.2218],   // Minneapolis
  KIND: [39.7173, -86.2944],   // Indianapolis
  KCVG: [39.0488, -84.6678],   // Cincinnati

  // Mountain/West
  KDEN: [39.8561, -104.6737],  // Denver
  KAPA: [39.5701, -104.8493],  // Centennial (FBO)
  KLAS: [36.0840, -115.1537],  // Las Vegas
  KPHX: [33.4373, -112.0078],  // Phoenix
  KSDL: [33.6229, -111.9105],  // Scottsdale (FBO)
  KPSP: [33.8297, -116.5067],  // Palm Springs
  KTRM: [33.6267, -116.1597],  // Thermal/Jacqueline Cochran (FBO, near PSP)
  KSLC: [40.7884, -111.9778],  // Salt Lake City
  KASE: [39.2232, -106.8688],  // Aspen
  KEGE: [39.6426, -106.9159],  // Eagle/Vail
  KCOS: [38.8058, -104.7007],  // Colorado Springs
  KBOI: [43.5644, -116.2228],  // Boise

  // DC area
  KIAD: [38.9445, -77.4558],   // Dulles
  KDCA: [38.8512, -77.0402],   // Reagan National
  KBWI: [39.1754, -76.6683],   // Baltimore

  // Canada
  CYYZ: [43.6777, -79.6248],   // Toronto Pearson
  CYUL: [45.4706, -73.7408],   // Montreal Trudeau
  CYVR: [49.1947, -123.1839],  // Vancouver
  CYOW: [45.3225, -75.6692],   // Ottawa
  CYYC: [51.1215, -114.0076],  // Calgary

  // New England / Northeast GA
  KASH: [42.7817, -71.5148],   // Nashua/Boire (NH)
  KPWM: [43.6462, -70.3093],   // Portland (ME)
  KBTV: [44.4720, -73.1533],   // Burlington (VT)
  KBDL: [41.9389, -72.6832],   // Hartford/Bradley
  KSWF: [41.5041, -74.1048],   // Stewart/Newburgh
  KISP: [40.7952, -73.1002],   // Long Island/Islip
  KFRG: [40.7288, -73.4134],   // Farmingdale/Republic
  KMHT: [42.9326, -71.4357],   // Manchester (NH)
  KPVD: [41.7267, -71.4204],   // Providence

  // Southeast GA / FBOs
  KSUA: [27.1817, -80.2211],   // Stuart/Witham (FL)
  KSDM: [32.5723, -116.9803],  // San Diego/Brown
  KTMB: [25.6479, -80.4328],   // Miami/Tamiami
  KBCT: [26.3785, -80.1077],   // Boca Raton
  KAPF: [26.1526, -81.7753],   // Naples (FL)
  KRSW: [26.5362, -81.7552],   // Fort Myers
  KSRQ: [27.3954, -82.5544],   // Sarasota
  KPIE: [27.9102, -82.6874],   // St. Pete/Clearwater

  // Mid-Atlantic
  KACY: [39.4576, -74.5772],   // Atlantic City
  KMMU: [40.7994, -74.4149],   // Morristown (NJ)
  KCDW: [40.8752, -74.2814],   // Caldwell/Essex (NJ)

  // Other
  KMSY: [29.9934, -90.2580],   // New Orleans
  KSTL: [38.7487, -90.3700],   // St. Louis
  KABQ: [35.0402, -106.6094],  // Albuquerque
  KTUL: [36.1984, -95.8881],   // Tulsa
  KOKC: [35.3931, -97.6007],   // Oklahoma City
  KLIT: [34.7294, -92.2243],   // Little Rock
  KJAN: [32.3112, -90.0759],   // Jackson (MS)
  KBHM: [33.5629, -86.7535],   // Birmingham (AL)
  KHSV: [34.6372, -86.7751],   // Huntsville (AL)
  KCHS: [32.8986, -80.0405],   // Charleston (SC)
  KSAV: [32.1276, -81.2021],   // Savannah (GA)
  KRIC: [37.5052, -77.3197],   // Richmond (VA)
  KORF: [36.8946, -76.2012],   // Norfolk (VA)
  KPIT: [40.4915, -80.2329],   // Pittsburgh
  KCLE: [41.4117, -81.8498],   // Cleveland
  KCMH: [39.9980, -82.8919],   // Columbus (OH)
  KMKE: [42.9472, -87.8966],   // Milwaukee
  KDAB: [29.1799, -81.0581],   // Daytona Beach
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

// Major commercial airports — these have scheduled airline service.
// Used by findNearbyCommercialAirports to filter results.
const COMMERCIAL_AIRPORTS = new Set([
  "KATL", "KBOS", "KBWI", "KCLT", "KCLE", "KCMH", "KCVG",
  "KDAL", "KDCA", "KDEN", "KDFW", "KDTW", "KELP",
  "KEWR", "KFLL", "KHOU", "KIAH", "KIND", "KJAX", "KJFK",
  "KLAS", "KLAX", "KLGA", "KLIT", "KMCO", "KMDW", "KMEM",
  "KMIA", "KMKE", "KMSP", "KMSY", "KOAK", "KOKC", "KORD",
  "KORF", "KPBI", "KPHL", "KPHX", "KPIT", "KPSP", "KPVD",
  "KRDU", "KRIC", "KRSW", "KSAN", "KSAT", "KSAV", "KSDL",
  "KSFO", "KSJC", "KSLC", "KSNA", "KSRQ", "KSTL", "KTPA",
  "KTUL", "KAUS", "KBDL", "KBNA", "KBHM", "KBOI", "KBUR",
  "KABQ", "KACY", "KCHS", "KDAB", "KHSV", "KJAN", "KPIE",
  "KASE", "KEGE", "KCOS",
  "CYYZ", "CYUL", "CYVR", "CYOW", "CYYC",
]);

/**
 * Find commercial airports within a given radius of an airport.
 * Returns ICAO codes sorted by distance (nearest first).
 */
export function findNearbyCommercialAirports(
  icao: string,
  radiusMiles: number = 30,
): { icao: string; distanceMiles: number }[] {
  const origin = AIRPORT_COORDS[icao.toUpperCase()];
  if (!origin) return [];

  const results: { icao: string; distanceMiles: number }[] = [];

  for (const code of COMMERCIAL_AIRPORTS) {
    if (code === icao.toUpperCase()) continue;
    const coords = AIRPORT_COORDS[code];
    if (!coords) continue;

    const dist = haversineMiles(origin[0], origin[1], coords[0], coords[1]);
    if (dist <= radiusMiles) {
      results.push({ icao: code, distanceMiles: Math.round(dist) });
    }
  }

  results.sort((a, b) => a.distanceMiles - b.distanceMiles);
  return results;
}
