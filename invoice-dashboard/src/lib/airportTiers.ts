/**
 * Airport commercial tier data for crew difficulty scoring.
 *
 * Tier determines how easy it is for a crew member to get commercial flights
 * from their home airport. Used by the optimizer to prioritize constrained
 * crew (those at small/regional airports with fewer flight options).
 */

export type AirportTier = "major_hub" | "large_hub" | "medium_hub" | "small_hub" | "regional" | "fbo_only" | "unknown";

// IATA → tier mapping for US airports commonly used by Baker crew
export const AIRPORT_TIERS: Record<string, AirportTier> = {
  // ── Major Hubs (10+ carriers, 200+ daily departures) ──────────────────────
  ATL: "major_hub", DFW: "major_hub", DEN: "major_hub", ORD: "major_hub",
  LAX: "major_hub", JFK: "major_hub", SFO: "major_hub", SEA: "major_hub",
  MIA: "major_hub", EWR: "major_hub", CLT: "major_hub", PHX: "major_hub",
  IAH: "major_hub", MCO: "major_hub", MSP: "major_hub", DTW: "major_hub",
  BOS: "major_hub", LGA: "major_hub", FLL: "major_hub", PHL: "major_hub",

  // ── Large Hubs (5+ carriers, 100+ daily departures) ───────────────────────
  DCA: "large_hub", IAD: "large_hub", BWI: "large_hub", SLC: "large_hub",
  SAN: "large_hub", TPA: "large_hub", BNA: "large_hub", AUS: "large_hub",
  STL: "large_hub", HOU: "large_hub", DAL: "large_hub", MDW: "large_hub",
  OAK: "large_hub", SJC: "large_hub", RDU: "large_hub", MCI: "large_hub",
  CLE: "large_hub", PIT: "large_hub", IND: "large_hub", CMH: "large_hub",
  SNA: "large_hub", SAT: "large_hub", JAX: "large_hub", BUR: "large_hub",
  MKE: "large_hub", CVG: "large_hub", PBI: "large_hub", MSY: "large_hub",
  LAS: "large_hub", PDX: "large_hub", RSW: "large_hub", MEM: "large_hub",
  RNO: "large_hub", ONT: "large_hub",

  // ── Medium Hubs (3+ carriers, scheduled service) ──────────────────────────
  BDL: "medium_hub", PVD: "medium_hub", ABQ: "medium_hub", TUL: "medium_hub",
  OKC: "medium_hub", LIT: "medium_hub", BHM: "medium_hub", RIC: "medium_hub",
  ORF: "medium_hub", CHS: "medium_hub", SAV: "medium_hub", GRR: "medium_hub",
  DSM: "medium_hub", ICT: "medium_hub", ELP: "medium_hub", PSP: "medium_hub",
  DAB: "medium_hub", SRQ: "medium_hub", PIE: "medium_hub", HSV: "medium_hub",
  ACY: "medium_hub", MHT: "medium_hub", PWM: "medium_hub", BTV: "medium_hub",
  SWF: "medium_hub", ISP: "medium_hub", ASE: "medium_hub", EGE: "medium_hub",
  COS: "medium_hub", BOI: "medium_hub", GNV: "medium_hub", FAY: "medium_hub",
  ECP: "medium_hub", MDT: "medium_hub", FSD: "medium_hub", SGF: "medium_hub",
  GRB: "medium_hub", JAN: "medium_hub", SDL: "medium_hub", HPN: "medium_hub",
  BZN: "medium_hub", JAC: "medium_hub",

  // ── Small Hubs (1-2 carriers, limited service) ────────────────────────────
  TVC: "small_hub", MQT: "small_hub", ESC: "small_hub", TWF: "small_hub",
  SUN: "small_hub", BDR: "small_hub", ILM: "small_hub", GSO: "small_hub",
  INT: "small_hub", PGV: "small_hub", AVP: "small_hub", ABE: "small_hub",
  ALB: "small_hub", SHV: "small_hub", BTR: "small_hub", ATW: "small_hub",
  CID: "small_hub", BFI: "small_hub",

  // ── Regional (very limited or seasonal service) ───────────────────────────
  GPI: "regional", HDN: "regional", CEZ: "regional",

  // ── FBO Only (no commercial service at all) ───────────────────────────────
  TEB: "fbo_only", VNY: "fbo_only", OPF: "fbo_only", PDK: "fbo_only",
  APA: "fbo_only", PWK: "fbo_only", FXE: "fbo_only", MMU: "fbo_only",
  CDW: "fbo_only", FRG: "fbo_only", DWH: "fbo_only", BED: "fbo_only",
  SGR: "fbo_only", TME: "fbo_only", ADS: "fbo_only", AFW: "fbo_only",
  FTW: "fbo_only", EDC: "fbo_only", GTU: "fbo_only", SUA: "fbo_only",
  BCT: "fbo_only", APF: "fbo_only", TMB: "fbo_only", SDM: "fbo_only",
  CMA: "fbo_only", CRQ: "fbo_only", TRM: "fbo_only", UDD: "fbo_only",
  BLM: "fbo_only", FOK: "fbo_only", OXC: "fbo_only", FCI: "fbo_only",
  OFP: "fbo_only", JYO: "fbo_only", OKV: "fbo_only", SHD: "fbo_only",
  TTN: "fbo_only",
};

// Difficulty score by tier (higher = harder to get flights from)
const TIER_DIFFICULTY: Record<AirportTier, number> = {
  major_hub: 0,
  large_hub: 10,
  medium_hub: 25,
  small_hub: 50,
  regional: 70,
  fbo_only: 90,
  unknown: 60,
};

/**
 * Get difficulty score for a crew member based on their home airports.
 * Uses the BEST (lowest difficulty) home airport — if they have IAH and DWH,
 * they're rated as a major_hub crew member since they can fly from IAH.
 *
 * Returns 0-90 where higher = harder to find flights.
 */
export function getCrewDifficulty(homeAirports: string[]): number {
  if (homeAirports.length === 0) return TIER_DIFFICULTY.unknown;

  let bestDifficulty = Infinity;
  for (const apt of homeAirports) {
    // Normalize: strip K prefix for ICAO codes
    const iata = apt.length === 4 && apt.startsWith("K") ? apt.slice(1) : apt;
    const tier = AIRPORT_TIERS[iata.toUpperCase()] ?? "unknown";
    const diff = TIER_DIFFICULTY[tier];
    if (diff < bestDifficulty) bestDifficulty = diff;
  }

  return bestDifficulty === Infinity ? TIER_DIFFICULTY.unknown : bestDifficulty;
}

/**
 * Get the commercial tier for an airport code (IATA or ICAO).
 */
export function getAirportTier(code: string): AirportTier {
  const iata = code.length === 4 && code.startsWith("K") ? code.slice(1) : code;
  return AIRPORT_TIERS[iata.toUpperCase()] ?? "unknown";
}
