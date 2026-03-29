/**
 * Default FBO → Commercial Airport aliases.
 * Used when the airport_aliases DB table is empty.
 * Format: [fbo_icao, commercial_icao, preferred]
 */

export type AirportAliasEntry = {
  fbo_icao: string;
  commercial_icao: string;
  preferred: boolean;
};

const RAW: [string, string, boolean][] = [
  // New York / New Jersey
  ["KTEB", "KEWR", true],   // Teterboro → Newark
  ["KTEB", "KLGA", false],  // Teterboro → LaGuardia
  ["KTEB", "KJFK", false],  // Teterboro → JFK
  ["KMMU", "KEWR", true],   // Morristown → Newark
  ["KHPN", "KEWR", false],  // White Plains → Newark
  ["KHPN", "KJFK", true],   // White Plains → JFK

  // South Florida
  ["KOPF", "KMIA", true],   // Opa-locka → Miami
  ["KOPF", "KFLL", false],  // Opa-locka → Fort Lauderdale
  ["KFXE", "KFLL", true],   // Ft Lauderdale Exec → FLL
  ["KFXE", "KMIA", false],  // Ft Lauderdale Exec → MIA
  ["KBCT", "KFLL", true],   // Boca Raton → FLL
  ["KBCT", "KPBI", false],  // Boca Raton → Palm Beach

  // Houston area
  ["KDWH", "KIAH", true],   // David Wayne Hooks → IAH
  ["KDWH", "KHOU", false],  // David Wayne Hooks → Hobby
  ["KSGR", "KHOU", true],   // Sugar Land → Hobby
  ["KSGR", "KIAH", false],  // Sugar Land → IAH
  ["KCXO", "KIAH", true],   // Conroe/Lone Star → IAH
  ["KELP", "KELP", true],   // El Paso (IS commercial)

  // Dallas area
  ["KADS", "KDFW", true],   // Addison → DFW
  ["KADS", "KDAL", false],  // Addison → Love Field
  ["KFTW", "KDFW", true],   // Ft Worth Meacham → DFW

  // California
  ["KVNY", "KBUR", true],   // Van Nuys → Burbank
  ["KVNY", "KLAX", false],  // Van Nuys → LAX
  ["KSNA", "KSNA", true],   // John Wayne (IS commercial)
  ["KONT", "KONT", true],   // Ontario (IS commercial)
  ["KCRQ", "KSAN", true],   // Carlsbad/Palomar → San Diego
  ["KSMO", "KLAX", true],   // Santa Monica → LAX
  ["KHWD", "KOAK", true],   // Hayward → Oakland
  ["KPAO", "KSJC", true],   // Palo Alto → San Jose
  ["KCCR", "KOAK", true],   // Concord → Oakland

  // New England
  ["KASH", "KBOS", true],   // Nashua/Boire → Boston
  ["KASH", "KMHT", false],  // Nashua/Boire → Manchester NH
  ["KBED", "KBOS", true],   // Hanscom/Bedford → Boston
  ["KPVD", "KPVD", true],   // Providence (IS commercial)
  ["KBDL", "KBDL", true],   // Hartford (IS commercial)
  ["KOXC", "KBDL", true],   // Oxford CT → Hartford

  // Mid-Atlantic
  ["KGAI", "KIAD", true],   // Gaithersburg → Dulles
  ["KGAI", "KDCA", false],  // Gaithersburg → Reagan
  ["KJYO", "KIAD", true],   // Leesburg VA → Dulles
  ["KHEF", "KIAD", true],   // Manassas → Dulles

  // Southeast
  ["KPDK", "KATL", true],   // DeKalb-Peachtree → Atlanta
  ["KRYY", "KATL", true],   // McCollum → Atlanta
  ["KSGJ", "KJAX", true],   // St. Augustine → Jacksonville
  ["KGNV", "KGNV", true],   // Gainesville FL (has limited commercial)
  ["KGNV", "KJAX", false],  // Gainesville FL → Jacksonville (backup)
  ["KORL", "KMCO", true],   // Orlando Exec → Orlando Intl
  ["KSFB", "KMCO", true],   // Sanford → Orlando Intl
  ["KISM", "KMCO", true],   // Kissimmee Gateway → Orlando Intl
  ["KSRQ", "KTPA", true],   // Sarasota → Tampa
  ["KMLB", "KMCO", true],   // Melbourne FL → Orlando

  // Desert Southwest
  ["KTRM", "KPSP", true],   // Thermal → Palm Springs
  ["KIWA", "KPHX", true],   // Phoenix-Mesa Gateway → Phoenix
  ["KSDL", "KPHX", true],   // Scottsdale → Phoenix
  ["KFFZ", "KPHX", true],   // Mesa Falcon → Phoenix
  ["KDVT", "KPHX", true],   // Deer Valley → Phoenix

  // Mountain / Northwest
  ["KASE", "KASE", true],   // Aspen (has United Express commercial)
  ["KASE", "KDEN", false],  // Aspen → Denver (backup / more options)
  ["KEGE", "KDEN", true],   // Eagle/Vail → Denver
  ["KGJT", "KDEN", true],   // Grand Junction → Denver
  ["KAPA", "KDEN", true],   // Centennial → Denver
  ["KBJC", "KDEN", true],   // Rocky Mountain Metro → Denver
  ["KRNO", "KRNO", true],   // Reno (IS commercial)

  // Michigan / Great Lakes
  ["KESC", "KMQT", true],   // Escanaba → Marquette (closest UP airport)
  ["KESC", "KGRR", false],  // Escanaba → Grand Rapids (backup)
  ["KTVC", "KTVC", true],   // Traverse City (IS commercial)
  ["KTVC", "KGRR", false],  // Traverse City → Grand Rapids (backup)

  // Idaho
  ["KTWF", "KBOI", true],   // Twin Falls → Boise

  // Carolinas
  ["KHKY", "KCLT", true],   // Hickory NC → Charlotte
  ["KINT", "KGSO", true],   // Smith Reynolds → Greensboro

  // Gulf Coast
  ["KLFT", "KMSY", true],   // Lafayette LA → New Orleans
  ["KBTR", "KMSY", true],   // Baton Rouge → New Orleans (backup)
  ["KBTR", "KBTR", false],  // Baton Rouge (has limited commercial)
  ["KSHV", "KSHV", true],   // Shreveport (IS commercial)
  ["KVPS", "KVPS", true],   // Ft Walton/Destin (IS commercial)
  ["KECP", "KECP", true],   // Panama City (IS commercial)
  ["KMOB", "KMOB", true],   // Mobile (IS commercial)
  ["KPNS", "KPNS", true],   // Pensacola (IS commercial)
  ["KDHN", "KMGM", true],   // Dothan → Montgomery

  // Midwest
  ["KPWK", "KORD", true],   // Chicago Executive → O'Hare
  ["KPWK", "KMDW", false],  // Chicago Executive → Midway
  ["KDPA", "KORD", true],   // DuPage → O'Hare
  ["KFCM", "KMSP", true],   // Flying Cloud → Minneapolis

  // Austin/San Antonio area
  ["KGRK", "KAUS", true],   // Killeen/Fort Hood → Austin

  // Tampa Bay / Florida Gulf
  ["KPIE", "KTPA", true],   // St. Pete-Clearwater → Tampa
  ["KSPG", "KTPA", true],   // Albert Whitted → Tampa
  ["KVDF", "KTPA", true],   // Tampa Executive → Tampa

  // Long Island / Connecticut
  ["KFRG", "KJFK", true],   // Republic/Farmingdale → JFK
  ["KFRG", "KLGA", false],  // Republic/Farmingdale → LaGuardia
  ["KISP", "KJFK", true],   // Islip/MacArthur → JFK
  ["KHVN", "KBDL", true],   // Tweed New Haven → Hartford

  // Virginia / DC area
  ["KRIC", "KRIC", true],   // Richmond (IS commercial)
  ["KORF", "KORF", true],   // Norfolk (IS commercial)
  ["KCHO", "KIAD", true],   // Charlottesville → Dulles

  // Upstate NY
  ["KSWF", "KEWR", true],   // Stewart/Newburgh → Newark

  // More Southeast
  ["KMGM", "KMGM", true],   // Montgomery (IS commercial)
  ["KCAE", "KCAE", true],   // Columbia SC (IS commercial)
  ["KAGS", "KATL", true],   // Augusta GA → Atlanta
  ["KGSP", "KCLT", true],   // Greenville-Spartanburg → Charlotte
  ["KGSP", "KGSP", false],  // GSP has some commercial

  // Montana / Remote
  ["KMSO", "KMSO", true],   // Missoula (IS commercial)
  ["KFCA", "KFCA", true],   // Kalispell (IS commercial)
  ["KGTF", "KGTF", true],   // Great Falls (IS commercial)

  // Stuart FL (35mi to PBI)
  ["KSUA", "KPBI", true],   // Stuart → Palm Beach
  ["KSUA", "KFLL", false],  // Stuart → Fort Lauderdale (backup)

  // Burlington NC (35mi to GSO, 45mi to RDU)
  ["KBUY", "KGSO", true],   // Burlington NC → Greensboro
  ["KBUY", "KRDU", false],  // Burlington NC → Raleigh-Durham

  // Trenton NJ (36mi to PHL, 40mi to EWR)
  ["KTTN", "KPHL", true],   // Trenton → Philadelphia
  ["KTTN", "KEWR", false],  // Trenton → Newark

  // Russellville AR (~55mi to XNA)
  ["KRUE", "KXNA", true],   // Russellville → NW Arkansas Regional

  // Moffett Field CA (8mi to SJC)
  ["KNUQ", "KSJC", true],   // Moffett Field → San Jose
  ["KNUQ", "KSFO", false],  // Moffett Field → San Francisco

  // Mesa-Gateway AZ (22mi to PHX)
  ["KIWA", "KPHX", true],   // Mesa-Gateway → Phoenix
  ["KIWA", "KSDL", false],  // Mesa-Gateway → Scottsdale

  // Thermal/Jacqueline Cochran CA (24mi to PSP)
  ["KTRM", "KPSP", true],   // Thermal → Palm Springs

  // Bermuda Dunes CA (14mi to PSP)
  ["KUDD", "KPSP", true],   // Bermuda Dunes → Palm Springs

  // Ohio State Univ (11mi to CMH)
  ["KOSU", "KCMH", true],   // OSU Airport → Columbus

  // Concord NC (18mi to CLT)
  ["KJQF", "KCLT", true],   // Concord → Charlotte

  // Manassas VA (already have HEF→IAD, add for completeness)
  // San Juan PR
  ["KSJU", "TJSJ", true],   // San Juan K-code → San Juan ICAO

  // Anguilla
  ["TQPF", "TNCM", true],   // Anguilla → St. Maarten

  // ── FBO aliases added 2026-03-22 (next-30-day flight coverage) ────────────

  // Pittsburgh area
  ["KAGC", "KPIT", true],    // Allegheny County → Pittsburgh

  // New York / New Jersey area
  ["KBLM", "KEWR", true],    // Belmar/Monmouth NJ → Newark
  ["KBLM", "KJFK", false],   // Belmar/Monmouth NJ → JFK
  ["KFOK", "KJFK", true],    // Westhampton Beach LI → JFK
  ["KPOU", "KEWR", true],    // Dutchess County NY → Newark

  // New England
  ["KPSM", "KBOS", true],    // Portsmouth/Pease NH → Boston

  // Mid-Atlantic / DC
  ["KMTN", "KBWI", true],    // Martin State → Baltimore

  // Virginia
  ["KSIG", "KORF", true],    // Norfolk Bravo → Norfolk

  // Pacific Northwest
  ["KBFI", "KSEA", true],    // Boeing Field → Sea-Tac

  // California
  ["KCMA", "KBUR", true],    // Camarillo → Burbank
  ["KMHR", "KSMF", true],    // Sacramento Mather → Sacramento

  // Texas
  ["KEDC", "KAUS", true],    // Austin Executive → Austin

  // Florida
  ["KFMY", "KRSW", true],    // Page Field → Fort Myers/RSW
  ["KMKY", "KRSW", true],    // Marco Island → Fort Myers/RSW
  ["KPGD", "KRSW", true],    // Punta Gorda → Fort Myers/RSW
  ["KVNC", "KSRQ", true],    // Venice FL → Sarasota
  ["KVRB", "KPBI", true],    // Vero Beach → Palm Beach

  // Midwest
  ["KGYY", "KMDW", true],    // Gary IN → Midway
  ["KGYY", "KORD", false],   // Gary IN → O'Hare
  ["KMKC", "KMCI", true],    // KC Downtown → Kansas City
  ["KPTK", "KDTW", true],    // Oakland County/Pontiac MI → Detroit
  ["KSUS", "KSTL", true],    // Spirit of St. Louis → St. Louis
  ["KYIP", "KDTW", true],    // Willow Run MI → Detroit

  // Utah
  ["KOGD", "KSLC", true],    // Ogden → Salt Lake City

  // Ohio
  ["KCGF", "KCLE", true],    // Cuyahoga County → Cleveland

  // ── FBO aliases added 2026-03-29 (Apr 2 swap coverage gaps) ─────────────

  // California
  ["KAPC", "KOAK", true],    // Napa County → Oakland
  ["KAPC", "KSFO", false],   // Napa County → San Francisco
  ["KLGB", "KLGB", true],    // Long Beach (IS commercial — JetBlue)
  ["KLGB", "KLAX", false],   // Long Beach → LAX (backup)

  // Pennsylvania / Mid-Atlantic
  ["KAVP", "KAVP", true],    // Wilkes-Barre (IS commercial — United Express)
  ["KMDT", "KMDT", true],    // Harrisburg (IS commercial — AA/United)
  ["KRDG", "KPHL", true],    // Reading PA → Philadelphia

  // Illinois / Midwest
  ["KBMI", "KBMI", true],    // Bloomington IL (IS commercial — AA)
  ["KDEC", "KIND", true],    // Decatur IL → Indianapolis
  ["KUGN", "KORD", true],    // Waukegan IL → O'Hare
  ["KUGN", "KMDW", false],   // Waukegan IL → Midway

  // Florida
  ["KTIX", "KMCO", true],    // Titusville/Space Coast → Orlando
  ["KJZI", "KCHS", true],    // Charleston Executive → Charleston

  // Texas
  ["KMFE", "KMFE", true],    // McAllen (IS commercial — AA/United)
  ["KGPI", "KGPI", true],    // Glacier Park (IS commercial — same as Kalispell)
  ["KFAT", "KFAT", true],    // Fresno (IS commercial)

  // Mountain / Remote
  ["KSUN", "KBOI", true],    // Hailey/Sun Valley → Boise
  ["KSUN", "KSLC", false],   // Hailey/Sun Valley → Salt Lake City
  ["KTEX", "KDEN", true],    // Telluride → Denver
  ["KHII", "KPHX", true],    // Lake Havasu → Phoenix

  // Nashville area
  ["KJWN", "KBNA", true],    // Nashville area exec → Nashville

  // Michigan / Detroit
  // KYIP already mapped to DTW above

  // Obscure / rare (map to nearest major hub)
  ["KLUM", "KDEN", true],    // Lumberton? → Denver (verify)
  ["KCPP", "KDEN", true],    // Casper? → Denver (verify)
  ["KOEO", "KORD", true],    // L'Anse/Baraga MI → O'Hare (verify)
  ["KSRC", "KLIT", true],    // Searcy AR → Little Rock (verify)

  // Jamaica
  ["MKJP", "MKJP", true],   // Kingston Jamaica (IS commercial)

  // International — FBO to nearest commercial
  ["CYYZ", "CYYZ", true],   // Toronto Pearson (IS commercial)
  ["MROC", "MROC", true],   // San Jose Costa Rica (IS commercial)
  ["MRLB", "MRLB", true],   // Liberia Costa Rica (IS commercial)
  ["MBPV", "KMIA", true],   // Marsh Harbour Bahamas → Miami (main connection)
  ["MBPV", "KFLL", false],  // Marsh Harbour Bahamas → Fort Lauderdale
  ["MBPV", "MBPV", false],  // Marsh Harbour (has limited Bahamasair)
  ["MYNN", "MYNN", true],   // Nassau Bahamas (IS commercial)
  ["MYNN", "KMIA", false],  // Nassau → Miami (backup)
  ["MPTO", "MPTO", true],   // Panama City (IS commercial)
];

export const DEFAULT_AIRPORT_ALIASES: AirportAliasEntry[] = RAW.map(([fbo, comm, pref]) => ({
  fbo_icao: fbo,
  commercial_icao: comm,
  preferred: pref,
}));
