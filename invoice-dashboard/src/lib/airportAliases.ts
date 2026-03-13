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
  ["KSRQ", "KTPA", true],   // Sarasota → Tampa
  ["KMLB", "KMCO", true],   // Melbourne FL → Orlando

  // Desert Southwest
  ["KTRM", "KPSP", true],   // Thermal → Palm Springs
  ["KIWA", "KPHX", true],   // Phoenix-Mesa Gateway → Phoenix
  ["KSDL", "KPHX", true],   // Scottsdale → Phoenix
  ["KFFZ", "KPHX", true],   // Mesa Falcon → Phoenix
  ["KDVT", "KPHX", true],   // Deer Valley → Phoenix

  // Mountain / Northwest
  ["KASE", "KDEN", true],   // Aspen → Denver (limited Aspen service)
  ["KEGE", "KDEN", true],   // Eagle/Vail → Denver
  ["KGJT", "KDEN", true],   // Grand Junction → Denver
  ["KAPA", "KDEN", true],   // Centennial → Denver
  ["KBJC", "KDEN", true],   // Rocky Mountain Metro → Denver
  ["KRNO", "KRNO", true],   // Reno (IS commercial)

  // Michigan / Great Lakes
  ["KESC", "KGRR", true],   // Escanaba → Grand Rapids (closest major)
  ["KTVC", "KGRR", true],   // Traverse City → Grand Rapids

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

  // International — FBO to nearest commercial
  ["CYYZ", "CYYZ", true],   // Toronto Pearson (IS commercial)
  ["MROC", "MROC", true],   // San Jose Costa Rica (IS commercial)
  ["MRLB", "MRLB", true],   // Liberia Costa Rica (IS commercial)
  ["MBPV", "MBPV", true],   // Marsh Harbour Bahamas (IS commercial)
  ["MYNN", "MYNN", true],   // Nassau Bahamas (IS commercial)
  ["MPTO", "MPTO", true],   // Panama City (IS commercial)
];

export const DEFAULT_AIRPORT_ALIASES: AirportAliasEntry[] = RAW.map(([fbo, comm, pref]) => ({
  fbo_icao: fbo,
  commercial_icao: comm,
  preferred: pref,
}));
