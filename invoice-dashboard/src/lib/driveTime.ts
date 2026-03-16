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
  KGNV: [29.6900, -82.2718],   // Gainesville (FL)
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
  KMQT: [46.5336, -87.5614],   // Marquette MI (Sawyer Intl)
  KTVC: [44.7414, -85.5822],   // Traverse City MI
  KFSD: [43.5820, -96.7419],   // Sioux Falls SD
  KMSP: [44.8820, -93.2218],   // Minneapolis
  KIND: [39.7173, -86.2944],   // Indianapolis
  KCVG: [39.0488, -84.6678],   // Cincinnati

  // Mountain/West
  KDEN: [39.8561, -104.6737],  // Denver
  KAPA: [39.5701, -104.8493],  // Centennial (FBO)
  KLAS: [36.0840, -115.1537],  // Las Vegas
  KRNO: [39.4991, -119.7681],  // Reno-Tahoe
  KPHX: [33.4373, -112.0078],  // Phoenix
  KSDL: [33.6229, -111.9105],  // Scottsdale (FBO)
  KPSP: [33.8297, -116.5067],  // Palm Springs
  KTRM: [33.6267, -116.1597],  // Thermal/Jacqueline Cochran (FBO, near PSP)
  KSLC: [40.7884, -111.9778],  // Salt Lake City
  KASE: [39.2232, -106.8688],  // Aspen
  KEGE: [39.6426, -106.9159],  // Eagle/Vail
  KCOS: [38.8058, -104.7007],  // Colorado Springs
  KBOI: [43.5644, -116.2228],  // Boise
  KTWF: [42.4818, -114.4877],  // Twin Falls ID

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

  // ── Texas (additional) ──────────────────────────────────────────────────
  KACT: [31.6113, -97.2305],   // Waco
  KADS: [32.9686, -96.8364],   // Addison
  KAFW: [32.9876, -97.3189],   // Fort Worth Alliance
  KCLL: [30.5886, -96.3638],   // College Station
  KEDC: [30.3985, -97.5664],   // Austin Executive
  KFTW: [32.8198, -97.3624],   // Fort Worth Meacham
  KGTU: [30.6788, -97.6794],   // Georgetown
  KSGR: [29.6222, -95.6565],   // Sugar Land
  KTME: [29.8070, -95.8979],   // Houston Executive
  KIKG: [27.5508, -97.7437],   // Kleberg County (Kingsville)
  KGDJ: [32.4444, -97.8169],   // Granbury

  // ── Florida (additional) ─────────────────────────────────────────────────
  KBKV: [28.4736, -82.4554],   // Brooksville
  KDED: [29.0670, -81.2837],   // DeLand
  KECP: [30.3571, -85.7955],   // Panama City (NW Florida Beaches)
  KFMY: [26.5866, -81.8632],   // Fort Myers (Page Field)
  KISM: [28.2898, -81.4371],   // Kissimmee Gateway
  KMKY: [25.9950, -81.6725],   // Marco Island
  KORL: [28.5455, -81.3329],   // Orlando Executive
  KPGD: [26.9202, -81.9905],   // Punta Gorda
  KTIX: [28.5148, -80.7992],   // Titusville/Space Coast
  KVNC: [27.0716, -82.4403],   // Venice
  KVRB: [27.6556, -80.4179],   // Vero Beach
  KCEW: [30.7788, -86.5221],   // Crestview (FL panhandle)
  KDTS: [30.4001, -86.4715],   // Destin (FL panhandle)

  // ── Northeast / Mid-Atlantic (additional) ────────────────────────────────
  KABE: [40.6521, -75.4408],   // Allentown, PA
  KALB: [42.7483, -73.8017],   // Albany, NY
  KMDT: [40.1935, -76.7634],   // Harrisburg PA
  KAVP: [41.3385, -75.7234],   // Wilkes-Barre/Scranton, PA
  KBLM: [40.1868, -74.1249],   // Belmar/Monmouth, NJ
  KFOK: [40.8437, -72.6318],   // Westhampton Beach, NY
  KILG: [39.6787, -75.6065],   // Wilmington, DE
  KIPT: [41.2418, -76.9211],   // Williamsport, PA
  KJYO: [39.0780, -77.5575],   // Leesburg, VA
  KOKV: [39.1435, -78.1444],   // Winchester, VA
  KOXC: [41.4786, -73.1352],   // Oxford, CT
  KPNE: [40.0819, -75.0106],   // Philadelphia NE
  KSHD: [38.2638, -78.8964],   // Staunton/Shenandoah, VA
  KTTN: [40.2767, -74.8135],   // Trenton, NJ
  KFCI: [37.5065, -77.5254],   // Richmond (Chesterfield), VA
  KOFP: [37.7091, -77.4361],   // Hanover County, VA

  // ── Carolinas / Southeast GA (additional) ─────────────────────────────────
  KAUO: [32.6151, -85.4340],   // Auburn, AL
  KANB: [33.5882, -85.8581],   // Anniston, AL
  KBUY: [36.0485, -79.4749],   // Burlington, NC
  KFAY: [34.9912, -78.8803],   // Fayetteville NC
  KCRE: [33.8117, -78.7239],   // Myrtle Beach (Grand Strand)
  KGSO: [36.0978, -79.9373],   // Greensboro, NC
  KHKY: [35.7411, -81.3896],   // Hickory, NC
  KHXD: [32.2244, -80.6975],   // Hilton Head, SC
  KILM: [34.2706, -77.9026],   // Wilmington, NC
  KINT: [36.1337, -80.2220],   // Winston-Salem, NC
  KJQF: [35.3878, -80.7091],   // Concord, NC
  KPGV: [35.6352, -77.3853],   // Greenville, NC
  KSIG: [36.8937, -76.2893],   // Norfolk (Bravo), VA
  KSOP: [35.2374, -79.3913],   // Pinehurst/Southern Pines, NC
  KSSI: [31.1518, -81.3913],   // Brunswick (St. Simons), GA

  // ── Midwest (additional) ──────────────────────────────────────────────────
  KATW: [44.2581, -88.5191],   // Appleton, WI
  KCID: [41.8847, -91.7108],   // Cedar Rapids, IA
  KCMI: [40.0392, -88.2781],   // Champaign, IL
  KDAY: [39.9024, -84.2194],   // Dayton, OH
  KDSM: [41.5340, -93.6631],   // Des Moines, IA
  KFNT: [42.9655, -83.7436],   // Flint, MI
  KGRB: [44.4851, -88.1296],   // Green Bay, WI
  KGYY: [41.6163, -87.4128],   // Gary, IN
  KICT: [37.6499, -97.4331],   // Wichita, KS
  KIXD: [38.8309, -94.8903],   // Olathe (New Century), KS
  KMCI: [39.2976, -94.7139],   // Kansas City, MO
  KMKC: [39.1232, -94.5928],   // Kansas City Downtown, MO
  KOSU: [40.0798, -83.0730],   // Columbus (OSU), OH
  KSGF: [37.2457, -93.3886],   // Springfield, MO
  KSUS: [38.6621, -90.6521],   // Spirit of St. Louis, MO
  KUES: [43.0411, -88.2370],   // Waukesha, WI
  KAMW: [41.9921, -93.6218],   // Ames, IA

  // ── South Central (additional) ────────────────────────────────────────────
  KBTR: [30.5332, -91.1496],   // Baton Rouge, LA
  KBVO: [36.7625, -96.0112],   // Bartlesville, OK
  KHCR: [35.5114, -91.5656],   // Heber Springs, AR
  KSHV: [32.4466, -93.8256],   // Shreveport, LA

  // ── Mountain / West (additional) ──────────────────────────────────────────
  KAVQ: [32.4096, -111.2185],  // Tucson/Marana, AZ
  KBJC: [39.9088, -105.1172],  // Broomfield/Rocky Mtn Metro, CO
  KBZN: [45.7775, -111.1530],  // Bozeman, MT
  KCEZ: [37.3030, -108.6281],  // Cortez, CO
  KGPI: [48.3105, -114.2560],  // Glacier Park (Kalispell), MT
  KHDN: [40.4812, -107.2178],  // Hayden/Steamboat Springs, CO
  KHII: [34.5711, -114.3583],  // Lake Havasu, AZ
  KIWA: [33.3078, -111.6551],  // Phoenix-Mesa Gateway, AZ
  KJAC: [43.6073, -110.7377],  // Jackson Hole, WY
  KSUN: [43.5044, -114.2962],  // Sun Valley (Hailey), ID

  // ── Pacific (additional) ──────────────────────────────────────────────────
  KAPC: [38.2132, -122.2807],  // Napa, CA
  KBFI: [47.5300, -122.3019],  // Boeing Field (Seattle), WA
  KBVS: [48.4709, -122.4209],  // Burlington (Skagit), WA
  KCCR: [37.9897, -122.0569],  // Concord, CA
  KCMA: [34.2137, -119.0943],  // Camarillo, CA
  KCRQ: [33.1283, -117.2803],  // Carlsbad (McClellan-Palomar), CA
  KLGB: [33.8177, -118.1516],  // Long Beach, CA
  KONT: [34.0560, -117.6012],  // Ontario, CA
  KPDX: [45.5887, -122.5975],  // Portland, OR
  KSBA: [34.4262, -119.8404],  // Santa Barbara, CA
  KSBD: [34.0954, -117.2349],  // San Bernardino, CA
  KSEA: [47.4502, -122.3088],  // Seattle-Tacoma, WA
  KUDD: [33.7484, -116.2748],  // Bermuda Dunes, CA
  KMCC: [38.6676, -121.4008],  // McClellan, CA
  KHWD: [37.6592, -122.1217],  // Hayward, CA
  KNUQ: [37.4161, -122.0490],  // Moffett Field, CA

  // ── Alaska / Hawaii / Territories ─────────────────────────────────────────
  PANC: [61.1744, -149.9964],  // Anchorage, AK
  PHNL: [21.3187, -157.9225],  // Honolulu, HI
  KSJU: [18.4394, -66.0018],   // San Juan, PR
  KSTT: [18.3373, -64.9734],   // St. Thomas, USVI
  TJSJ: [18.4394, -66.0018],   // San Juan (ICAO), PR

  // ── Canada (additional) ───────────────────────────────────────────────────
  CYEG: [53.3097, -113.5800],  // Edmonton, AB
  CYWG: [49.9100, -97.2399],   // Winnipeg, MB
  CYHZ: [44.8808, -63.5086],   // Halifax, NS
  CYQB: [46.7911, -71.3933],   // Quebec City, QC
  CYYT: [47.6186, -52.7519],   // St. John's, NL

  // ── Mexico ────────────────────────────────────────────────────────────────
  MMMX: [19.4363, -99.0721],   // Mexico City
  MMUN: [21.0365, -86.8771],   // Cancun
  MMMY: [25.7785, -100.1069],  // Monterrey
  MMGL: [20.5218, -103.3111],  // Guadalajara
  MMSD: [23.1518, -109.7215],  // Los Cabos (San Jose del Cabo)
  MMPR: [20.6801, -105.2544],  // Puerto Vallarta
  MMTO: [19.3371, -99.5660],   // Toluca
  MMSL: [22.2543, -100.9308],  // San Luis Potosi

  // ── Caribbean / Central America ───────────────────────────────────────────
  MBPV: [21.7736, -72.2659],   // Providenciales, Turks & Caicos
  MYNN: [25.0390, -77.4662],   // Nassau, Bahamas
  MYAM: [26.5114, -77.0836],   // Marsh Harbour, Bahamas
  MYEH: [25.4749, -76.6831],   // Eleuthera, Bahamas
  MYGF: [26.5587, -78.6956],   // Freeport, Bahamas
  MKJP: [17.9357, -76.7875],   // Kingston, Jamaica
  MDPC: [18.5674, -68.3634],   // Punta Cana, DR
  MWCR: [19.2928, -81.3577],   // Grand Cayman
  TNCM: [18.0410, -63.1089],   // St. Maarten
  TQPF: [18.2048, -63.0551],   // Anguilla
  TBPB: [13.0746, -59.4925],   // Barbados
  TVSA: [13.1444, -61.2110],   // St. Vincent
  MROC: [9.9939, -84.2088],    // San Jose, Costa Rica
  MRLB: [10.5933, -85.5444],   // Liberia, Costa Rica
  MPTO: [9.0714, -79.3835],    // Panama City (Tocumen)
  MHTG: [14.0609, -87.2172],   // Tegucigalpa, Honduras
  MGGT: [14.5833, -90.5275],   // Guatemala City
  TXKF: [32.3640, -64.6787],   // Bermuda
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
 * Uses distance-dependent road multiplier (1.2x highway / 1.3x city) and 55 mph avg.
 * All drive times rounded UP to nearest 15 minutes.
 */
export function estimateDriveTime(originIcao: string, destIcao: string): DriveEstimate | null {
  const orig = AIRPORT_COORDS[originIcao.toUpperCase()];
  const dest = AIRPORT_COORDS[destIcao.toUpperCase()];
  if (!orig || !dest) return null;

  const straightMiles = haversineMiles(orig[0], orig[1], dest[0], dest[1]);
  // Short distances (<50mi) use 1.3x (city driving is windier)
  // Longer distances use 1.2x (highways are straighter)
  const roadMultiplier = straightMiles > 50 ? 1.2 : 1.3;
  const driveMiles = straightMiles * roadMultiplier;
  const rawMinutes = (driveMiles / 55) * 60; // 55 mph average
  const driveMinutes = Math.ceil(rawMinutes / 15) * 15; // round UP to nearest 15 min

  return {
    origin: originIcao.toUpperCase(),
    destination: destIcao.toUpperCase(),
    straight_line_miles: Math.round(straightMiles),
    estimated_drive_miles: Math.round(driveMiles),
    estimated_drive_minutes: driveMinutes,
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
  "KASE", "KEGE", "KCOS", "KGRR", "KMQT", "KTVC", "KFSD",
  "KICT", "KFAY", "KMDT", "KTWF", "KECP", "KMLB", "KGNV",
  "KMCI", "KDSM", "KGRB", "KSGF",
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
