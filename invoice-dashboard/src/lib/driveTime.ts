// Drive time estimates — OSRM for real road routing, haversine as fallback.
// OSRM results cached in Supabase `drive_time_cache` and in-memory Map.

import { createServiceClient } from "@/lib/supabase/service";
import { DEFAULT_AIRPORT_ALIASES } from "@/lib/airportAliases";

// ─── In-memory OSRM cache (populated by loadDriveTimeCache / fetchOSRMDriveTime) ──
// Key: "ORIG|DEST", Value: { minutes, miles, source }
const driveCache = new Map<string, { minutes: number; miles: number; source: string }>();

function cacheKey(a: string, b: string): string {
  return `${a.toUpperCase()}|${b.toUpperCase()}`;
}

// ─── Airport coordinates (US airports commonly used by Baker) ────────────────
// ICAO → [lat, lon]. Add more as needed.

const AIRPORT_COORDS: Record<string, [number, number]> = {
  // Texas
  KCXO: [30.3518, -95.4145],   // Conroe-North Houston Regional
  KDAL: [32.8471, -96.8518],   // Dallas Love Field
  KDFW: [32.8968, -97.0380],   // Dallas/Fort Worth
  KDWH: [30.0618, -95.5528],   // David Wayne Hooks (FBO, near IAH)
  KELP: [31.8072, -106.3776],  // El Paso
  KGRK: [31.0672, -97.8289],   // Robert Gray AAF/Killeen
  KHOU: [29.6454, -95.2789],   // Houston Hobby
  KIAH: [29.9844, -95.3414],   // Houston Intercontinental
  KAUS: [30.1945, -97.6699],   // Austin
  KSAT: [29.5337, -98.4698],   // San Antonio
  KTKI: [33.1779, -96.5905],   // McKinney National

  // Florida
  KFLL: [26.0726, -80.1527],   // Fort Lauderdale
  KFXE: [26.1973, -80.1707],   // Fort Lauderdale Executive
  KGNV: [29.6900, -82.2718],   // Gainesville (FL)
  KJAX: [30.4941, -81.6879],   // Jacksonville
  KMCO: [28.4294, -81.3090],   // Orlando
  KMIA: [25.7959, -80.2870],   // Miami International
  KMLB: [28.1028, -80.6453],   // Melbourne Orlando Intl
  KOPF: [25.9068, -80.2784],   // Opa-locka (FBO)
  KPBI: [26.6832, -80.0956],   // Palm Beach
  KPNS: [30.4734, -87.1866],   // Pensacola Intl
  KSFB: [28.7776, -81.2375],   // Orlando Sanford Intl
  KSGJ: [29.9592, -81.3397],   // NE Florida Regional (St. Augustine)
  KSPG: [27.7651, -82.6270],   // Albert Whitted (St. Pete)
  KTPA: [27.9755, -82.5332],   // Tampa
  KVDF: [27.9765, -82.3453],   // Tampa Executive
  KVPS: [30.4832, -86.5254],   // Destin-Fort Walton Beach

  // Northeast
  KBDR: [41.1635, -73.1262],   // Bridgeport/Sikorsky
  KBED: [42.4700, -71.2890],   // Bedford/Hanscom
  KBOS: [42.3656, -71.0096],   // Boston Logan
  KEWR: [40.6925, -74.1687],   // Newark
  KHPN: [41.0670, -73.7076],   // Westchester
  KJFK: [40.6413, -73.7781],   // JFK
  KLGA: [40.7769, -73.8740],   // LaGuardia
  KPHL: [39.8721, -75.2411],   // Philadelphia
  KTEB: [40.8501, -74.0608],   // Teterboro (FBO)

  // California
  KBUR: [34.2007, -118.3585],  // Burbank
  KLAX: [33.9425, -118.4081],  // Los Angeles
  KLVK: [37.6934, -121.8204],  // Livermore Municipal, CA
  KOAK: [37.7213, -122.2208],  // Oakland
  KPAO: [37.4611, -122.1150],  // Palo Alto
  KSAN: [32.7336, -117.1897],  // San Diego
  KSFO: [37.6213, -122.3790],  // San Francisco
  KSJC: [37.3626, -121.9291],  // San Jose
  KSMO: [34.0158, -118.4513],  // Santa Monica
  KSNA: [33.6757, -117.8683],  // Santa Ana/John Wayne
  KVNY: [34.2098, -118.4897],  // Van Nuys (FBO)

  // Southeast
  KAGS: [33.3700, -81.9645],   // Augusta Regional, GA
  KATL: [33.6407, -84.4277],   // Atlanta
  KBNA: [36.1245, -86.6782],   // Nashville
  KCAE: [33.9388, -81.1195],   // Columbia Metropolitan, SC
  KCLT: [35.2140, -80.9431],   // Charlotte
  KDHN: [31.3214, -85.4496],   // Dothan Regional, AL
  KGSP: [34.8957, -82.2189],   // Greenville-Spartanburg Intl, SC
  KMEM: [35.0424, -89.9767],   // Memphis
  KMGM: [32.3006, -86.3940],   // Montgomery Regional, AL
  KMOB: [30.6912, -88.2428],   // Mobile Regional, AL
  KPDK: [33.8756, -84.3020],   // DeKalb-Peachtree (FBO)
  KRDU: [35.8776, -78.7875],   // Raleigh-Durham
  KRYY: [34.0132, -84.5971],   // McCollum Field, Kennesaw GA

  // Midwest
  KCVG: [39.0488, -84.6678],   // Cincinnati
  KDPA: [41.9078, -88.2486],   // DuPage Airport, IL
  KDTW: [42.2124, -83.3534],   // Detroit
  KESC: [45.7227, -87.0937],   // Escanaba MI
  KFCM: [44.8272, -93.4572],   // Flying Cloud, MN
  KFSD: [43.5820, -96.7419],   // Sioux Falls SD
  KGRR: [42.8808, -85.5228],   // Grand Rapids
  KIND: [39.7173, -86.2944],   // Indianapolis
  KMDW: [41.7868, -87.7416],   // Chicago Midway
  KMQT: [46.5336, -87.5614],   // Marquette MI (Sawyer Intl)
  KMSP: [44.8820, -93.2218],   // Minneapolis
  KORD: [41.9742, -87.9073],   // Chicago O'Hare
  KPWK: [42.1142, -87.9015],   // Chicago Executive (FBO)
  KTVC: [44.7414, -85.5822],   // Traverse City MI

  // Mountain/West
  KAPA: [39.5701, -104.8493],  // Centennial (FBO)
  KASE: [39.2232, -106.8688],  // Aspen
  KTEX: [37.9538, -107.9085],  // Telluride
  KBOI: [43.5644, -116.2228],  // Boise
  KCOS: [38.8058, -104.7007],  // Colorado Springs
  KDEN: [39.8561, -104.6737],  // Denver
  KDVT: [33.6883, -112.0833],  // Deer Valley, Phoenix AZ
  KEGE: [39.6426, -106.9159],  // Eagle/Vail
  KFFZ: [33.4608, -111.7281],  // Falcon Field, Mesa AZ
  KGJT: [39.1224, -108.5267],  // Grand Junction Regional, CO
  KLAS: [36.0840, -115.1537],  // Las Vegas
  KPHX: [33.4373, -112.0078],  // Phoenix
  KPSP: [33.8297, -116.5067],  // Palm Springs
  KRNO: [39.4991, -119.7681],  // Reno-Tahoe
  KSDL: [33.6229, -111.9105],  // Scottsdale (FBO)
  KSGU: [37.0364, -113.5103],  // St George Regional, UT
  KSLC: [40.7884, -111.9778],  // Salt Lake City
  KSLK: [44.3853, -74.2062],  // Adirondack Regional, Saranac Lake, NY
  KTRM: [33.6267, -116.1597],  // Thermal/Jacqueline Cochran (FBO, near PSP)
  KTWF: [42.4818, -114.4877],  // Twin Falls ID

  // DC area
  KBWI: [39.1754, -76.6683],   // Baltimore
  KCHO: [38.1386, -78.4529],   // Charlottesville-Albemarle, VA
  KDCA: [38.8512, -77.0402],   // Reagan National
  KGAI: [39.1683, -77.1660],   // Montgomery County Airpark, MD
  KHEF: [38.7214, -77.5155],   // Manassas Regional, VA
  KIAD: [38.9445, -77.4558],   // Dulles
  KLYH: [37.3267, -79.2004],   // Lynchburg Regional, VA

  // Canada
  CYYZ: [43.6777, -79.6248],   // Toronto Pearson
  CYUL: [45.4706, -73.7408],   // Montreal Trudeau
  CYVR: [49.1947, -123.1839],  // Vancouver
  CYOW: [45.3225, -75.6692],   // Ottawa
  CYYC: [51.1215, -114.0076],  // Calgary

  // New England / Northeast GA
  KASH: [42.7817, -71.5148],   // Nashua/Boire (NH)
  KLCI: [43.5727, -71.4189],   // Laconia Municipal, NH
  KPWM: [43.6462, -70.3093],   // Portland (ME)
  KBTV: [44.4720, -73.1533],   // Burlington (VT)
  KBUF: [42.9405, -78.7322],   // Buffalo NY
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
  KABQ: [35.0402, -106.6094],  // Albuquerque
  KBHM: [33.5629, -86.7535],   // Birmingham (AL)
  KCHS: [32.8986, -80.0405],   // Charleston (SC)
  KCLE: [41.4117, -81.8498],   // Cleveland
  KCMH: [39.9980, -82.8919],   // Columbus (OH)
  KDAB: [29.1799, -81.0581],   // Daytona Beach
  KHSV: [34.6372, -86.7751],   // Huntsville (AL)
  KJAN: [32.3112, -90.0759],   // Jackson (MS)
  KLIT: [34.7294, -92.2243],   // Little Rock
  KMKE: [42.9472, -87.8966],   // Milwaukee
  KMSY: [29.9934, -90.2580],   // New Orleans
  KOKC: [35.3931, -97.6007],   // Oklahoma City
  KORF: [36.8946, -76.2012],   // Norfolk (VA)
  KPIT: [40.4915, -80.2329],   // Pittsburgh
  KRIC: [37.5052, -77.3197],   // Richmond (VA)
  KSAV: [32.1276, -81.2021],   // Savannah (GA)
  KSDF: [38.1744, -85.7360],   // Louisville Muhammad Ali Intl, KY
  KSTL: [38.7487, -90.3700],   // St. Louis
  KTUL: [36.1984, -95.8881],   // Tulsa

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
  KAVP: [41.3385, -75.7234],   // Wilkes-Barre/Scranton, PA
  KBLM: [40.1868, -74.1249],   // Belmar/Monmouth, NJ
  KFCI: [37.5065, -77.5254],   // Richmond (Chesterfield), VA
  KFKL: [41.3779, -79.8604],   // Venango Regional, Franklin PA
  KFOK: [40.8437, -72.6318],   // Westhampton Beach, NY
  KILG: [39.6787, -75.6065],   // Wilmington, DE
  KIPT: [41.2418, -76.9211],   // Williamsport, PA
  KJYO: [39.0780, -77.5575],   // Leesburg, VA
  KMDT: [40.1935, -76.7634],   // Harrisburg PA
  KOFP: [37.7091, -77.4361],   // Hanover County, VA
  KOKV: [39.1435, -78.1444],   // Winchester, VA
  KOXC: [41.4786, -73.1352],   // Oxford, CT
  KPNE: [40.0819, -75.0106],   // Philadelphia NE
  KROA: [37.3255, -79.9754],   // Roanoke-Blacksburg Regional, VA
  KSHD: [38.2638, -78.8964],   // Staunton/Shenandoah, VA
  KTTN: [40.2767, -74.8135],   // Trenton, NJ

  // ── Carolinas / Southeast GA (additional) ─────────────────────────────────
  KANB: [33.5882, -85.8581],   // Anniston, AL
  KAUO: [32.6151, -85.4340],   // Auburn, AL
  KBUY: [36.0485, -79.4749],   // Burlington, NC
  KCRE: [33.8117, -78.7239],   // Myrtle Beach (Grand Strand)
  KFAY: [34.9912, -78.8803],   // Fayetteville NC
  KGSO: [36.0978, -79.9373],   // Greensboro, NC
  KHKY: [35.7411, -81.3896],   // Hickory, NC
  KHXD: [32.2244, -80.6975],   // Hilton Head, SC
  KILM: [34.2706, -77.9026],   // Wilmington, NC
  KINT: [36.1337, -80.2220],   // Winston-Salem, NC
  KJQF: [35.3878, -80.7091],   // Concord, NC
  KOAJ: [34.8292, -77.6121],   // Albert J Ellis, Jacksonville NC
  KPGV: [35.6352, -77.3853],   // Greenville, NC
  KSIG: [36.8937, -76.2893],   // Norfolk (Bravo), VA
  KSOP: [35.2374, -79.3913],   // Pinehurst/Southern Pines, NC
  KSSI: [31.1518, -81.3913],   // Brunswick (St. Simons), GA

  // ── Midwest (additional) ──────────────────────────────────────────────────
  KAMW: [41.9921, -93.6218],   // Ames, IA
  KATW: [44.2581, -88.5191],   // Appleton, WI
  KCID: [41.8847, -91.7108],   // Cedar Rapids, IA
  KCMI: [40.0392, -88.2781],   // Champaign, IL
  KDAY: [39.9024, -84.2194],   // Dayton, OH
  KDSM: [41.5340, -93.6631],   // Des Moines, IA
  KENW: [42.5957, -87.9278],   // Kenosha Regional, WI
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
  KYNG: [41.2607, -80.6791],   // Youngstown-Warren Regional, OH

  // ── South Central (additional) ────────────────────────────────────────────
  KBTR: [30.5332, -91.1496],   // Baton Rouge, LA
  KBVO: [36.7625, -96.0112],   // Bartlesville, OK
  KHCR: [35.5114, -91.5656],   // Heber Springs, AR
  KLFT: [30.2053, -91.9876],   // Lafayette Regional, LA
  KSHV: [32.4466, -93.8256],   // Shreveport, LA
  KXNA: [36.2819, -94.3068],   // Northwest Arkansas Regional

  // ── Mountain / West (additional) ──────────────────────────────────────────
  KAVQ: [32.4096, -111.2185],  // Tucson/Marana, AZ
  KBJC: [39.9088, -105.1172],  // Broomfield/Rocky Mtn Metro, CO
  KDRO: [37.1515, -107.7538],  // Durango-La Plata County, CO
  KBZN: [45.7775, -111.1530],  // Bozeman, MT
  KCEZ: [37.3030, -108.6281],  // Cortez, CO
  KFCA: [48.3105, -114.2560],  // Glacier Park Intl (Kalispell), MT
  KGPI: [48.3105, -114.2560],  // Glacier Park (Kalispell), MT
  KHDN: [40.4812, -107.2178],  // Hayden/Steamboat Springs, CO
  KHII: [34.5711, -114.3583],  // Lake Havasu, AZ
  KIWA: [33.3078, -111.6551],  // Phoenix-Mesa Gateway, AZ
  KJAC: [43.6073, -110.7377],  // Jackson Hole, WY
  KMSO: [46.9163, -114.0906],  // Missoula Montana Airport
  KSUN: [43.5044, -114.2962],  // Sun Valley (Hailey), ID

  // ── Pacific (additional) ──────────────────────────────────────────────────
  KAPC: [38.2132, -122.2807],  // Napa, CA
  KBFI: [47.5300, -122.3019],  // Boeing Field (Seattle), WA
  KBVS: [48.4709, -122.4209],  // Burlington (Skagit), WA
  KCCR: [37.9897, -122.0569],  // Concord, CA
  KCMA: [34.2137, -119.0943],  // Camarillo, CA
  KCRQ: [33.1283, -117.2803],  // Carlsbad (McClellan-Palomar), CA
  KHWD: [37.6592, -122.1217],  // Hayward, CA
  KLGB: [33.8177, -118.1516],  // Long Beach, CA
  KMCC: [38.6676, -121.4008],  // McClellan, CA
  KNUQ: [37.4161, -122.0490],  // Moffett Field, CA
  KONT: [34.0560, -117.6012],  // Ontario, CA
  KPDX: [45.5887, -122.5975],  // Portland, OR
  KSBA: [34.4262, -119.8404],  // Santa Barbara, CA
  KSBD: [34.0954, -117.2349],  // San Bernardino, CA
  KSEA: [47.4502, -122.3088],  // Seattle-Tacoma, WA
  KSTS: [38.5090, -122.8129],  // Charles M Schulz/Sonoma County, CA
  KUDD: [33.7484, -116.2748],  // Bermuda Dunes, CA

  // ── Northeast / Mid-Atlantic (more) ──────────────────────────────────────
  KAGC: [40.3544, -79.9302],   // Allegheny County (Pittsburgh area), PA
  KBGR: [44.8074, -68.8281],   // Bangor, ME
  KMTN: [39.3257, -76.4138],   // Martin State (Baltimore area), MD
  KPOU: [41.6266, -73.8842],   // Dutchess County, NY
  KPSM: [43.0779, -70.8233],   // Portsmouth/Pease, NH
  KROC: [43.1189, -77.6724],   // Rochester, NY

  // ── Midwest (more) ─────────────────────────────────────────────────────────
  KCAK: [40.9161, -81.4422],   // Akron-Canton, OH
  KEVV: [38.0370, -87.5324],   // Evansville Regional, IN
  KLAN: [42.7787, -84.5874],   // Lansing (Capital Region), MI
  KOMA: [41.3032, -95.8941],   // Omaha (Eppley Airfield), NE
  KPTK: [42.6655, -83.4185],   // Oakland County (Pontiac), MI
  KSBN: [41.7087, -86.3173],   // South Bend, IN
  KYIP: [42.2379, -83.5304],   // Willow Run (Ypsilanti), MI

  // ── South / Southeast (more) ───────────────────────────────────────────────
  KMYR: [33.6797, -78.9283],   // Myrtle Beach, SC

  // ── Texas (more) ───────────────────────────────────────────────────────────
  KLRD: [27.5438, -99.4616],   // Laredo Intl, TX
  KMAF: [31.9425, -102.2019],  // Midland-Odessa, TX
  T82:  [30.2469, -98.9099],   // Gillespie County (Fredericksburg), TX
  KT82: [30.2469, -98.9099],   // Gillespie County (Fredericksburg), TX (K-prefix alias)
  KMFE: [26.1758, -98.2386],   // McAllen, TX

  // ── Mountain / West (more) ─────────────────────────────────────────────────
  KFAT: [36.7762, -119.7181],  // Fresno, CA
  KMHR: [38.5539, -121.2977],  // Sacramento Mather, CA
  KMRY: [36.5870, -121.8430],  // Monterey, CA

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
  TIST: [18.3373, -64.9734],   // Cyril E. King (St. Thomas, USVI)
  TNCM: [18.0410, -63.1089],   // St. Maarten
  TQPF: [18.2048, -63.0551],   // Anguilla
  TBPB: [13.0746, -59.4925],   // Barbados
  TVSA: [13.1444, -61.2110],   // St. Vincent
  TVSM: [12.5884, -61.1502],   // Mustique (St. Vincent & Grenadines)
  TXKF: [32.3640, -64.6787],   // L.F. Wade Intl, Bermuda
  MROC: [9.9939, -84.2088],    // San Jose, Costa Rica
  MRLB: [10.5933, -85.5444],   // Liberia, Costa Rica
  MPTO: [9.0714, -79.3835],    // Panama City (Tocumen)
  MHTG: [14.0609, -87.2172],   // Tegucigalpa, Honduras
  MGGT: [14.5833, -90.5275],   // Guatemala City
  TXKF: [32.3640, -64.6787],   // Bermuda
  // Added 2026-04-06 — gap detection coverage
  KFDK: [39.4178, -77.3744],   // Frederick Municipal, MD (near IAD/DCA/BWI)
  KBIS: [46.7727, -100.7468],  // Bismarck, ND
  PAOT: [66.8847, -162.5985],  // Kotzebue (Ralph Wien), AK
  KLEB: [43.6261, -72.3042],   // Lebanon, NH (near MHT/BOS)
  CYXX: [49.0253, -122.3606],  // Abbotsford, BC
  TLPL: [13.7332, -60.9528],   // Hewanorra (St Lucia)
  CYQA: [44.9747, -79.3033],   // Muskoka, ON
  KLWB: [37.8583, -80.3995],   // Greenbrier, WV (near CRW)
  KBRO: [25.9068, -97.4259],   // Brownsville, TX
  KSTP: [44.9345, -93.0600],   // St Paul Downtown, MN (near MSP)
  KSAF: [35.6171, -106.0892],  // Santa Fe, NM
  KCRW: [38.3731, -81.5932],   // Charleston, WV
  PAFA: [64.8151, -147.8561],  // Fairbanks, AK
  PAJN: [58.3550, -134.5763],  // Juneau, AK
  // Additional small/private fields
  KTHA: [35.3801, -86.2464],   // Tullahoma Regional, TN
  KLNS: [40.1217, -76.2961],   // Lancaster Airport, PA
  KOQU: [41.5971, -71.4121],   // Quonset State, RI
  S25:  [47.9574, -103.2533],  // Watford City Airport, ND (FAA LID)
  KBKL: [41.5175, -81.6833],   // Burke Lakefront, Cleveland OH
  KVPC: [34.1231, -84.8487],   // Cartersville Airport, GA
  KLZU: [33.9781, -83.9624],   // Gwinnett County, Lawrenceville GA
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
 * Estimate drive time between two airports.
 * Checks the in-memory OSRM cache first (populated by loadDriveTimeCache or warmDriveTimeCache).
 * Falls back to haversine + road multiplier if no cached OSRM data.
 * All drive times rounded UP to nearest 15 minutes.
 */
export function estimateDriveTime(originIcao: string, destIcao: string): DriveEstimate | null {
  const o = originIcao.toUpperCase();
  const d = destIcao.toUpperCase();
  const orig = AIRPORT_COORDS[o];
  const dest = AIRPORT_COORDS[d];
  if (!orig || !dest) return null;

  const straightMiles = haversineMiles(orig[0], orig[1], dest[0], dest[1]);

  // Check in-memory OSRM cache first
  const cached = driveCache.get(cacheKey(o, d));
  if (cached) {
    const driveMinutes = Math.ceil(cached.minutes / 15) * 15;
    return {
      origin: o,
      destination: d,
      straight_line_miles: Math.round(straightMiles),
      estimated_drive_miles: Math.round(cached.miles),
      estimated_drive_minutes: driveMinutes,
      feasible: driveMinutes <= 240,
    };
  }

  // Fallback: haversine + road multiplier
  const roadMultiplier = straightMiles > 50 ? 1.2 : 1.3;
  const driveMiles = straightMiles * roadMultiplier;
  const rawMinutes = (driveMiles / 55) * 60; // 55 mph average
  const driveMinutes = Math.ceil(rawMinutes / 15) * 15;

  return {
    origin: o,
    destination: d,
    straight_line_miles: Math.round(straightMiles),
    estimated_drive_miles: Math.round(driveMiles),
    estimated_drive_minutes: driveMinutes,
    feasible: driveMinutes <= 240,
  };
}

/**
 * Get airport coordinates (lat, lon) by ICAO code.
 */
export function getAirportCoords(icao: string): { lat: number; lon: number } | null {
  const coords = AIRPORT_COORDS[icao.toUpperCase()];
  if (!coords) return null;
  return { lat: coords[0], lon: coords[1] };
}

/**
 * Check if an airport is in our coordinate database.
 */
export function hasCoords(icao: string): boolean {
  return resolveToCoordKey(icao) !== null;
}

/** Resolve an airport code (ICAO, IATA, or FAA LID) to its AIRPORT_COORDS key.
 *  Also checks FBO→commercial aliases when the FBO itself isn't in AIRPORT_COORDS. */
function resolveToCoordKey(code: string): string | null {
  const upper = code.toUpperCase();
  if (upper in AIRPORT_COORDS) return upper;
  // Try ICAO with K prefix (IATA→ICAO for US airports)
  if (upper.length === 3) {
    const withK = `K${upper}`;
    if (withK in AIRPORT_COORDS) return withK;
  }
  // Try FBO→commercial alias (e.g. KPDK→KATL)
  const alias = DEFAULT_AIRPORT_ALIASES.find(
    (a) => a.fbo_icao === upper && a.preferred,
  );
  if (alias && alias.commercial_icao in AIRPORT_COORDS) {
    return alias.commercial_icao;
  }
  return null;
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
  "KEWR", "KFLL", "KHOU", "KIAH", "KIAD", "KIND", "KJAX", "KJFK",
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
  "KALB", "KAZO", "KBFI", "KBMI", "KBZN", "KCGF", "KILM",
  "KOGD", "KPGV", "KTUS", "KSEA", "KPDX", "KSMF", "KONT",
  "KLGB", "KSDF", "KLEX", "KXNA", "KCID", "KATW",
  // Added 2026-03-22 — next-30-day flight coverage
  "KAVP", "KBGR", "KBTV", "KBUF", "KCAK", "KFAT", "KGSP", "KJAC",
  "KLAN", "KLRD", "KMAF", "KMFE", "KMRY", "KMYR", "KOMA", "KRNO",
  "KROC", "KSBA", "KSBN", "KSUN",
  // Added 2026-04-09
  "KDRO", "KEVV",
  // Added 2026-04-06 — gap detection misses
  "KBIS", "KOTZ", "KBRO", "KSAF", "KLWB", "KSTP", "KLEB",
  "KFDK", "KMCC", "KCRW", "KMHT", "KPWM", "KSYR", "KABE",
  "KAVL", "KCHA", "KDAY", "KERI", "KFWA", "KGEG", "KHPN",
  "KISP", "KITH", "KMBS", "KMDW", "KMOB", "KPNS", "KSHV",
  "KSWF", "KTYC", "KPIA", "KCWA", "KCKB", "KLFT", "KMLI",
  "PANC", // Anchorage (non-K ICAO)
  "PAFA", // Fairbanks
  "PAJN", // Juneau
  "PAOT", // Kotzebue (OTZ)
  "CYYZ", "CYUL", "CYVR", "CYOW", "CYYC",
  "CYXX", // Abbotsford
  "CYQA", // Muskoka
  "TIST", // St. Thomas, USVI
  "TJSJ", // San Juan, PR
  "TXKF", // Bermuda
  // Caribbean / Latin America
  "TLPL", // St Lucia Hewanorra
  "MMSL", // Mazatlán
]);

/** Check if an airport is a known commercial airport with scheduled airline service. */
export function isCommercialAirport(icao: string): boolean {
  return COMMERCIAL_AIRPORTS.has(icao.toUpperCase());
}

/**
 * Find commercial airports within a given radius of an airport.
 * Returns ICAO codes sorted by distance (nearest first).
 */
export function findNearbyCommercialAirports(
  icao: string,
  radiusMiles: number = 30,
): { icao: string; distanceMiles: number }[] {
  const key = resolveToCoordKey(icao);
  if (!key) return [];
  const origin = AIRPORT_COORDS[key];

  const FALLBACK_RADIUS = 100;

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

  // If nothing within the default radius, widen to fallback to handle remote GA fields
  if (results.length === 0 && radiusMiles < FALLBACK_RADIUS) {
    for (const code of COMMERCIAL_AIRPORTS) {
      if (code === icao.toUpperCase()) continue;
      const coords = AIRPORT_COORDS[code];
      if (!coords) continue;

      const dist = haversineMiles(origin[0], origin[1], coords[0], coords[1]);
      if (dist <= FALLBACK_RADIUS) {
        results.push({ icao: code, distanceMiles: Math.round(dist) });
      }
    }
  }

  results.sort((a, b) => a.distanceMiles - b.distanceMiles);
  return results;
}

// ─── OSRM Integration ────────────────────────────────────────────────────────
// Free, keyless routing API. Results are cached in Supabase `drive_time_cache`
// and in the module-level `driveCache` Map for synchronous access.

const OSRM_BASE = "https://router.project-osrm.org/route/v1/driving";
const OSRM_DELAY_MS = 200; // rate limit: ~5 req/sec

/** Sleep helper for rate limiting */
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Load ALL cached drive times from Supabase into the in-memory Map.
 * Call once at startup (e.g., before the optimizer runs).
 * Returns the number of entries loaded.
 */
export async function loadDriveTimeCache(): Promise<number> {
  const sb = createServiceClient();
  const { data, error } = await sb
    .from("drive_time_cache")
    .select("origin_icao, destination_icao, duration_seconds, distance_meters");

  if (error) {
    console.error("[driveTime] Failed to load drive_time_cache:", error.message);
    return 0;
  }

  let count = 0;
  for (const row of data ?? []) {
    driveCache.set(cacheKey(row.origin_icao, row.destination_icao), {
      minutes: Number(row.duration_seconds) / 60,
      miles: Number(row.distance_meters) / 1609.344,
      source: "osrm",
    });
    count++;
  }

  console.log(`[driveTime] Loaded ${count} cached drive times into memory`);
  return count;
}

/**
 * Fetch drive time from OSRM for a single airport pair.
 * Stores result in both Supabase and in-memory cache.
 * Returns null if OSRM fails (caller should fall back to haversine).
 */
export async function fetchOSRMDriveTime(
  originIcao: string,
  destIcao: string,
): Promise<{ minutes: number; miles: number } | null> {
  const o = originIcao.toUpperCase();
  const d = destIcao.toUpperCase();

  // Already in memory?
  const existing = driveCache.get(cacheKey(o, d));
  if (existing) return { minutes: existing.minutes, miles: existing.miles };

  const orig = AIRPORT_COORDS[o];
  const dest = AIRPORT_COORDS[d];
  if (!orig || !dest) return null;

  // OSRM uses lon,lat order (AIRPORT_COORDS stores [lat, lon])
  const url = `${OSRM_BASE}/${orig[1]},${orig[0]};${dest[1]},${dest[0]}?overview=false`;

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) {
      console.warn(`[driveTime] OSRM HTTP ${res.status} for ${o}→${d}`);
      return null;
    }

    const json = await res.json() as {
      code: string;
      routes?: { duration: number; distance: number }[];
    };

    if (json.code !== "Ok" || !json.routes?.length) {
      console.warn(`[driveTime] OSRM no route for ${o}→${d}: ${json.code}`);
      return null;
    }

    const route = json.routes[0];
    const minutes = route.duration / 60;              // seconds → minutes
    const miles = route.distance / 1609.344;          // meters → miles

    // Store in memory
    driveCache.set(cacheKey(o, d), { minutes, miles, source: "osrm" });

    // Store in Supabase (fire and forget — don't block on this)
    const sb = createServiceClient();
    sb.from("drive_time_cache")
      .upsert(
        {
          origin_icao: o,
          destination_icao: d,
          duration_seconds: Math.round(minutes * 60),
          distance_meters: Math.round(miles * 1609.344),
          fetched_at: new Date().toISOString(),
        },
        { onConflict: "origin_icao,destination_icao" },
      )
      .then(({ error }) => {
        if (error) console.warn(`[driveTime] Supabase upsert failed for ${o}→${d}:`, error.message);
      });

    return { minutes, miles };
  } catch (err) {
    console.warn(`[driveTime] OSRM fetch error for ${o}→${d}:`, err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * Async drive time lookup: cache → OSRM → haversine fallback.
 * Use this when you can await (e.g., transport-options route).
 */
export async function getAccurateDriveTime(
  originIcao: string,
  destIcao: string,
): Promise<DriveEstimate | null> {
  const o = originIcao.toUpperCase();
  const d = destIcao.toUpperCase();
  const orig = AIRPORT_COORDS[o];
  const dest = AIRPORT_COORDS[d];
  if (!orig || !dest) return null;

  const straightMiles = haversineMiles(orig[0], orig[1], dest[0], dest[1]);

  // Try OSRM (checks in-memory cache first, then fetches)
  const osrm = await fetchOSRMDriveTime(o, d);
  if (osrm) {
    const driveMinutes = Math.ceil(osrm.minutes / 15) * 15;
    return {
      origin: o,
      destination: d,
      straight_line_miles: Math.round(straightMiles),
      estimated_drive_miles: Math.round(osrm.miles),
      estimated_drive_minutes: driveMinutes,
      feasible: driveMinutes <= 240,
    };
  }

  // Fallback to haversine
  return estimateDriveTime(o, d);
}

/**
 * Pre-fetch OSRM drive times for multiple airport pairs in batch.
 * Rate-limited to ~5 req/sec. Skips pairs already in the in-memory cache.
 * Call this once before the optimizer runs to warm the cache.
 *
 * @param pairs - Array of [originIcao, destIcao] tuples
 * @returns Number of new OSRM lookups performed
 */
export async function warmDriveTimeCache(
  pairs: [string, string][],
): Promise<number> {
  // Deduplicate
  const needed = new Map<string, [string, string]>();
  for (const [a, b] of pairs) {
    const key = cacheKey(a, b);
    if (!driveCache.has(key) && !needed.has(key)) {
      needed.set(key, [a.toUpperCase(), b.toUpperCase()]);
    }
  }

  if (needed.size === 0) {
    console.log("[driveTime] warmDriveTimeCache: all pairs already cached");
    return 0;
  }

  console.log(`[driveTime] warmDriveTimeCache: fetching ${needed.size} pairs from OSRM...`);
  let fetched = 0;
  let failures = 0;

  for (const [, [o, d]] of needed) {
    const result = await fetchOSRMDriveTime(o, d);
    if (result) {
      fetched++;
    } else {
      failures++;
    }
    // Rate limit — wait between requests (not after the last one)
    if (fetched + failures < needed.size) {
      await sleep(OSRM_DELAY_MS);
    }
  }

  console.log(`[driveTime] warmDriveTimeCache: ${fetched} fetched, ${failures} failed (haversine fallback)`);
  return fetched;
}

/** Get the current in-memory cache size (for diagnostics). */
export function driveCacheSize(): number {
  return driveCache.size;
}
