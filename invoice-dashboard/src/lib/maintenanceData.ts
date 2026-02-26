/**
 * Baker Aviation – Maintenance Van Positioning
 *
 * Trip data is sourced from JetInsight. This module:
 *  1. Holds the raw trip list (updated manually or eventually via API)
 *  2. Computes overnight aircraft positions for a given date
 *  3. Runs a greedy van-assignment algorithm to position 16 vans
 */

import { getAirportInfo } from "./airportCoords";

// ---------------------------------------------------------------------------
// Contiguous 48 states — used to exclude offshore / international aircraft
// from van assignment. Vans stay in the lower 48 only.
// ---------------------------------------------------------------------------

const CONTIGUOUS_48 = new Set([
  "AL","AZ","AR","CA","CO","CT","DE","FL","GA","ID","IL","IN","IA","KS","KY",
  "LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ","NM","NY",
  "NC","ND","OH","OK","OR","PA","RI","SC","SD","TN","TX","UT","VT","VA","WA",
  "WV","WI","WY",
]);

export function isContiguous48(state: string): boolean {
  return CONTIGUOUS_48.has(state);
}

// ---------------------------------------------------------------------------
// Fixed van zones — replaces dynamic k-means clustering so vans stay in
// the same geographic area. 8 home bases per ops requirements.
// ---------------------------------------------------------------------------

export type VanZone = {
  vanId: number;
  name: string;
  homeAirport: string;
  lat: number;
  lon: number;
};

export const FIXED_VAN_ZONES: VanZone[] = [
  { vanId: 1, name: "North FL",       homeAirport: "JAX", lat: 30.4943, lon: -81.6879 },
  { vanId: 2, name: "South FL East",  homeAirport: "PBI", lat: 26.6832, lon: -80.0956 },
  { vanId: 3, name: "South FL West",  homeAirport: "FMY", lat: 26.5866, lon: -81.8633 },
  { vanId: 4, name: "NY/NJ – TEB",    homeAirport: "TEB", lat: 40.8501, lon: -74.0608 },
  { vanId: 5, name: "NY/NJ – HPN",    homeAirport: "HPN", lat: 41.0670, lon: -73.7076 },
  { vanId: 6, name: "Bedford MA",     homeAirport: "BED", lat: 42.4700, lon: -71.2890 },
  { vanId: 7, name: "LA Area",        homeAirport: "VNY", lat: 34.2098, lon: -118.4899 },
  { vanId: 8, name: "SFO Area",       homeAirport: "SFO", lat: 37.6213, lon: -122.3790 },
];

// ---------------------------------------------------------------------------
// Raw trip data (from JetInsight export, 2026-02-25)
// ---------------------------------------------------------------------------

export type Trip = {
  tripId: string;
  tripStart: string; // YYYY-MM-DD
  tripEnd: string;   // YYYY-MM-DD
  tail: string;
  from: string;      // ICAO/IATA airport code
  to: string;
  status: "Booked" | "Released" | "Declined" | "Cancelled" | "Lost" | "Awaiting invoice" | "Invoiced";
  updated: string;   // YYYY-MM-DD
};

export const TRIPS: Trip[] = [
  { tripId: "0HSIEB1", tripStart: "2025-12-27", tripEnd: "2026-03-14", tail: "N51GB",   from: "TEB",  to: "PSP",  status: "Booked",   updated: "2026-02-20" },
  { tripId: "C5FJH81", tripStart: "2025-12-29", tripEnd: "2026-04-30", tail: "N125DZ",  from: "VNY",  to: "PGD",  status: "Booked",   updated: "2026-01-21" },
  { tripId: "ITJ1WW",  tripStart: "2026-02-14", tripEnd: "2026-03-13", tail: "N106PC",  from: "OAK",  to: "OPF",  status: "Booked",   updated: "2026-02-18" },
  { tripId: "GDJ2BK",  tripStart: "2026-02-15", tripEnd: "2026-02-24", tail: "N860TX",  from: "TEB",  to: "EGE",  status: "Released", updated: "2026-02-23" },
  { tripId: "EGUYMX",  tripStart: "2026-02-19", tripEnd: "2026-02-25", tail: "N301HR",  from: "MRLB", to: "IAH",  status: "Released", updated: "2026-02-25" },
  { tripId: "J0WX2O",  tripStart: "2026-02-20", tripEnd: "2026-02-24", tail: "N883TR",  from: "BCT",  to: "FRG",  status: "Released", updated: "2026-02-24" },
  { tripId: "IMNFXL",  tripStart: "2026-02-21", tripEnd: "2026-02-28", tail: "N992MG",  from: "TEB",  to: "PBI",  status: "Booked",   updated: "2026-02-25" },
  { tripId: "DOM9H6",  tripStart: "2026-02-22", tripEnd: "2026-02-25", tail: "N106PC",  from: "ALB",  to: "LWS",  status: "Released", updated: "2026-02-25" },
  { tripId: "EO7I0T",  tripStart: "2026-02-22", tripEnd: "2026-03-05", tail: "N125TH",  from: "TRM",  to: "TRM",  status: "Booked",   updated: "2026-02-24" },
  { tripId: "SADVFK",  tripStart: "2026-02-22", tripEnd: "2026-02-27", tail: "N552FX",  from: "TEB",  to: "MYNN", status: "Booked",   updated: "2026-02-24" },
  { tripId: "BL6XRE",  tripStart: "2026-02-22", tripEnd: "2026-03-02", tail: "N733FL",  from: "TTN",  to: "FLL",  status: "Booked",   updated: "2026-02-24" },
  { tripId: "UG4WE1",  tripStart: "2026-02-22", tripEnd: "2026-02-26", tail: "N51GB",   from: "BUR",  to: "IAH",  status: "Booked",   updated: "2026-02-24" },
  { tripId: "T812DT",  tripStart: "2026-02-22", tripEnd: "2026-03-01", tail: "N201HR",  from: "HPN",  to: "VNY",  status: "Booked",   updated: "2026-02-23" },
  { tripId: "FJPUCC",  tripStart: "2026-02-22", tripEnd: "2026-02-28", tail: "N553FX",  from: "MSN",  to: "OPF",  status: "Booked",   updated: "2026-02-23" },
  { tripId: "F5Z340",  tripStart: "2026-02-23", tripEnd: "2026-02-26", tail: "N201HR",  from: "VNY",  to: "TEB",  status: "Released", updated: "2026-02-25" },
  { tripId: "LXE0XK",  tripStart: "2026-02-23", tripEnd: "2026-02-24", tail: "N519FX",  from: "LAS",  to: "TEB",  status: "Released", updated: "2026-02-23" },
  { tripId: "1OE5LW",  tripStart: "2026-02-23", tripEnd: "2026-02-24", tail: "N988TX",  from: "MPTO", to: "PGV",  status: "Released", updated: "2026-02-24" },
  { tripId: "KLM81P",  tripStart: "2026-02-24", tripEnd: "2026-02-25", tail: "N703TX",  from: "SJC",  to: "OMA",  status: "Released", updated: "2026-02-24" },
  { tripId: "OY3ZZV",  tripStart: "2026-02-24", tripEnd: "2026-02-24", tail: "N939TX",  from: "TEB",  to: "OPF",  status: "Released", updated: "2026-02-25" },
  { tripId: "KLY31C",  tripStart: "2026-02-24", tripEnd: "2026-02-28", tail: "N102VR",  from: "TEB",  to: "VNY",  status: "Booked",   updated: "2026-02-25" },
  { tripId: "97VH95",  tripStart: "2026-02-24", tripEnd: "2026-02-26", tail: "N513JB",  from: "ADS",  to: "ANB",  status: "Booked",   updated: "2026-02-25" },
  { tripId: "6W2E0D",  tripStart: "2026-02-24", tripEnd: "2026-02-24", tail: "N106PC",  from: "OAK",  to: "VRB",  status: "Released", updated: "2026-02-24" },
  { tripId: "ELGZS3",  tripStart: "2026-02-24", tripEnd: "2026-02-24", tail: "N955GH",  from: "OPF",  to: "TEB",  status: "Released", updated: "2026-02-24" },
  { tripId: "O6P5JD",  tripStart: "2026-02-24", tripEnd: "2026-02-24", tail: "N301HR",  from: "DAL",  to: "BED",  status: "Released", updated: "2026-02-24" },
  { tripId: "AJN1DY",  tripStart: "2026-02-24", tripEnd: "2026-02-24", tail: "N700LH",  from: "FLL",  to: "CMH",  status: "Released", updated: "2026-02-24" },
  { tripId: "77D6AR",  tripStart: "2026-02-24", tripEnd: "2026-02-24", tail: "N553FX",  from: "VNY",  to: "TTN",  status: "Released", updated: "2026-02-24" },
  { tripId: "96V048",  tripStart: "2026-02-24", tripEnd: "2026-02-24", tail: "N552FX",  from: "TEB",  to: "PBI",  status: "Released", updated: "2026-02-24" },
  { tripId: "JU20CD",  tripStart: "2026-02-24", tripEnd: "2026-02-25", tail: "N992MG",  from: "BED",  to: "PBI",  status: "Released", updated: "2026-02-25" },
  { tripId: "ZSI4IU",  tripStart: "2026-02-24", tripEnd: "2026-02-24", tail: "N971JS",  from: "LAS",  to: "TEB",  status: "Released", updated: "2026-02-24" },
  { tripId: "5P1DEX",  tripStart: "2026-02-24", tripEnd: "2026-02-24", tail: "N954JS",  from: "TEB",  to: "VNY",  status: "Released", updated: "2026-02-24" },
  { tripId: "Y2XOS8",  tripStart: "2026-02-24", tripEnd: "2026-02-25", tail: "N187CR",  from: "TEB",  to: "LAS",  status: "Released", updated: "2026-02-25" },
  { tripId: "8OYGB1",  tripStart: "2026-02-24", tripEnd: "2026-02-25", tail: "N939TX",  from: "FPR",  to: "DFW",  status: "Released", updated: "2026-02-25" },
  { tripId: "9N3C2K",  tripStart: "2026-02-24", tripEnd: "2026-02-24", tail: "N51GB",   from: "TEB",  to: "VNY",  status: "Released", updated: "2026-02-25" },
  { tripId: "VHOUNR",  tripStart: "2026-02-24", tripEnd: "2026-02-26", tail: "N818CF",  from: "PTK",  to: "TEB",  status: "Released", updated: "2026-02-24" },
  { tripId: "5595I5",  tripStart: "2026-02-24", tripEnd: "2026-02-25", tail: "N416F",   from: "VNY",  to: "TTN",  status: "Released", updated: "2026-02-25" },
  { tripId: "RVETKK",  tripStart: "2026-02-24", tripEnd: "2026-02-24", tail: "N988TX",  from: "MYEH", to: "SRQ",  status: "Released", updated: "2026-02-24" },
  { tripId: "N3N8TZ",  tripStart: "2026-02-24", tripEnd: "2026-02-24", tail: "N521FX",  from: "MWCR", to: "TEB",  status: "Released", updated: "2026-02-24" },
  { tripId: "TRP1II",  tripStart: "2026-02-24", tripEnd: "2026-02-25", tail: "N955GH",  from: "TEB",  to: "STL",  status: "Released", updated: "2026-02-25" },
  { tripId: "R9LKFJ",  tripStart: "2026-02-24", tripEnd: "2026-02-24", tail: "N519FX",  from: "IAD",  to: "PBI",  status: "Released", updated: "2026-02-24" },
  { tripId: "ZKQX36",  tripStart: "2026-02-24", tripEnd: "2026-02-24", tail: "N700LH",  from: "CLE",  to: "SNA",  status: "Released", updated: "2026-02-24" },
  { tripId: "QARAYJ",  tripStart: "2026-02-24", tripEnd: "2026-02-24", tail: "N125DZ",  from: "PBI",  to: "TEB",  status: "Released", updated: "2026-02-24" },
  { tripId: "HW01UE",  tripStart: "2026-02-24", tripEnd: "2026-02-24", tail: "N957JS",  from: "PBI",  to: "HPN",  status: "Released", updated: "2026-02-24" },
  { tripId: "7NVZH4",  tripStart: "2026-02-24", tripEnd: "2026-02-25", tail: "N818CF",  from: "BOS",  to: "MEM",  status: "Released", updated: "2026-02-24" },
  { tripId: "X71Q3R",  tripStart: "2026-02-25", tripEnd: "2026-02-25", tail: "N883TR",  from: "TAPA", to: "TEB",  status: "Released", updated: "2026-02-25" },
  { tripId: "KX0Y9G",  tripStart: "2026-02-25", tripEnd: "2026-02-25", tail: "N955GH",  from: "CHS",  to: "HPN",  status: "Released", updated: "2026-02-25" },
  { tripId: "P3KSJR",  tripStart: "2026-02-25", tripEnd: "2026-02-27", tail: "N954JS",  from: "BZN",  to: "MSN",  status: "Booked",   updated: "2026-02-25" },
  { tripId: "P0NPDD",  tripStart: "2026-02-25", tripEnd: "2026-02-25", tail: "N519FX",  from: "OPF",  to: "RIL",  status: "Released", updated: "2026-02-25" },
  { tripId: "OM2K3T",  tripStart: "2026-02-25", tripEnd: "2026-02-26", tail: "N187CR",  from: "LNK",  to: "SDL",  status: "Released", updated: "2026-02-25" },
  { tripId: "WWT98L",  tripStart: "2026-02-25", tripEnd: "2026-02-25", tail: "N700LH",  from: "SNA",  to: "BCT",  status: "Released", updated: "2026-02-25" },
  { tripId: "PXW76Q",  tripStart: "2026-02-25", tripEnd: "2026-03-01", tail: "N988TX",  from: "FMY",  to: "SLC",  status: "Booked",   updated: "2026-02-25" },
  { tripId: "JVORQU",  tripStart: "2026-02-25", tripEnd: "2026-02-25", tail: "N552FX",  from: "PBI",  to: "BOS",  status: "Released", updated: "2026-02-25" },
  { tripId: "69HELO",  tripStart: "2026-02-25", tripEnd: "2026-02-25", tail: "N416F",   from: "BUY",  to: "BUY",  status: "Booked",   updated: "2026-02-24" },
  { tripId: "6OP0JM",  tripStart: "2026-02-25", tripEnd: "2026-02-26", tail: "N992MG",  from: "PBI",  to: "TXKF", status: "Booked",   updated: "2026-02-25" },
  { tripId: "HZ8B0L",  tripStart: "2026-02-25", tripEnd: "2026-02-26", tail: "N957JS",  from: "TEB",  to: "BVO",  status: "Released", updated: "2026-02-24" },
  { tripId: "WADB5W",  tripStart: "2026-02-25", tripEnd: "2026-02-26", tail: "N125TH",  from: "PBI",  to: "TEB",  status: "Released", updated: "2026-02-24" },
  { tripId: "1D5EA0",  tripStart: "2026-02-25", tripEnd: "2026-02-26", tail: "N553FX",  from: "DAL",  to: "IAD",  status: "Released", updated: "2026-02-24" },
  { tripId: "YMYB0L",  tripStart: "2026-02-25", tripEnd: "2026-02-25", tail: "N939TX",  from: "2IS",  to: "IKG",  status: "Released", updated: "2026-02-25" },
  { tripId: "ULD7SP",  tripStart: "2026-02-25", tripEnd: "2026-03-01", tail: "N201HR",  from: "ADS",  to: "MRY",  status: "Booked",   updated: "2026-02-24" },
  { tripId: "KWKTU1",  tripStart: "2026-02-25", tripEnd: "2026-03-01", tail: "N513JB",  from: "HPN",  to: "EGE",  status: "Booked",   updated: "2026-02-25" },
  { tripId: "F0KZWG",  tripStart: "2026-02-25", tripEnd: "2026-02-25", tail: "N301HR",  from: "BED",  to: "RIL",  status: "Booked",   updated: "2026-02-25" },
  { tripId: "A7LFB6",  tripStart: "2026-02-25", tripEnd: "2026-02-25", tail: "N733FL",  from: "TEB",  to: "OPF",  status: "Booked",   updated: "2026-02-24" },
  { tripId: "3415EH",  tripStart: "2026-02-25", tripEnd: "2026-02-25", tail: "N521FX",  from: "SJU",  to: "HPN",  status: "Released", updated: "2026-02-24" },
  { tripId: "9UY8KT",  tripStart: "2026-02-25", tripEnd: "2026-02-28", tail: "N971JS",  from: "TEB",  to: "PBI",  status: "Booked",   updated: "2026-02-25" },
  { tripId: "4G4VDN",  tripStart: "2026-02-25", tripEnd: "2026-02-26", tail: "N818CF",  from: "OPF",  to: "PSP",  status: "Booked",   updated: "2026-02-25" },
  { tripId: "02XSVZ",  tripStart: "2026-02-25", tripEnd: "2026-02-26", tail: "N700LH",  from: "BCT",  to: "HPN",  status: "Released", updated: "2026-02-24" },
  { tripId: "BAZXDT",  tripStart: "2026-02-25", tripEnd: "2026-02-26", tail: "N106PC",  from: "PIE",  to: "SLC",  status: "Booked",   updated: "2026-02-25" },
  { tripId: "O0PU9E",  tripStart: "2026-02-25", tripEnd: "2026-02-27", tail: "N998CX",  from: "TEB",  to: "OPF",  status: "Booked",   updated: "2026-02-24" },
  { tripId: "H70SDC",  tripStart: "2026-02-26", tripEnd: "2026-02-26", tail: "N883TR",  from: "TEB",  to: "ASE",  status: "Booked",   updated: "2026-02-25" },
  { tripId: "NX4BLE",  tripStart: "2026-02-26", tripEnd: "2026-03-02", tail: "N955GH",  from: "SJC",  to: "PBI",  status: "Booked",   updated: "2026-02-25" },
  { tripId: "XTSNHZ",  tripStart: "2026-02-26", tripEnd: "2026-03-01", tail: "N521FX",  from: "FRG",  to: "PBI",  status: "Booked",   updated: "2026-02-25" },
  { tripId: "MXJ4SA",  tripStart: "2026-02-26", tripEnd: "2026-02-26", tail: "N416F",   from: "MCO",  to: "AAO",  status: "Booked",   updated: "2026-02-25" },
  { tripId: "0XRUVQ",  tripStart: "2026-02-26", tripEnd: "2026-02-26", tail: "N513JB",  from: "BOI",  to: "LAX",  status: "Booked",   updated: "2026-02-25" },
  { tripId: "L1KDCR",  tripStart: "2026-02-26", tripEnd: "2026-03-01", tail: "N301HR",  from: "ADS",  to: "SRQ",  status: "Booked",   updated: "2026-02-25" },
  { tripId: "0YEKH1",  tripStart: "2026-02-26", tripEnd: "2026-03-07", tail: "N818CF",  from: "VNY",  to: "TIX",  status: "Booked",   updated: "2026-02-25" },
  { tripId: "VN934G",  tripStart: "2026-02-26", tripEnd: "2026-03-02", tail: "N519FX",  from: "VNY",  to: "NEW",  status: "Booked",   updated: "2026-02-25" },
  { tripId: "UZZDD2",  tripStart: "2026-02-26", tripEnd: "2026-02-26", tail: "N700LH",  from: "HPN",  to: "BTR",  status: "Booked",   updated: "2026-02-25" },
  { tripId: "2EBZTO",  tripStart: "2026-02-26", tripEnd: "2026-02-26", tail: "N860TX",  from: "LAX",  to: "SUA",  status: "Booked",   updated: "2026-02-25" },
  { tripId: "TKQY2Q",  tripStart: "2026-02-26", tripEnd: "2026-02-26", tail: "N733FL",  from: "JWN",  to: "ORL",  status: "Booked",   updated: "2026-02-25" },
  { tripId: "8J8SYE",  tripStart: "2026-02-26", tripEnd: "2026-02-26", tail: "N971JS",  from: "IAD",  to: "MCC",  status: "Booked",   updated: "2026-02-25" },
  { tripId: "6BI2P0",  tripStart: "2026-02-26", tripEnd: "2026-02-27", tail: "N201HR",  from: "SBA",  to: "EGE",  status: "Booked",   updated: "2026-02-25" },
  { tripId: "2EXCTL",  tripStart: "2026-02-26", tripEnd: "2026-02-26", tail: "N51GB",   from: "TNCA", to: "PNE",  status: "Booked",   updated: "2026-02-25" },
  { tripId: "8T5D5G",  tripStart: "2026-02-26", tripEnd: "2026-02-26", tail: "N939TX",  from: "PIE",  to: "APA",  status: "Booked",   updated: "2026-02-24" },
  { tripId: "5ZJ8O2",  tripStart: "2026-02-26", tripEnd: "2026-02-26", tail: "N521FX",  from: "PBI",  to: "HPN",  status: "Booked",   updated: "2026-02-25" },
  { tripId: "CMUMCH",  tripStart: "2026-02-26", tripEnd: "2026-02-27", tail: "N125DZ",  from: "VNY",  to: "OPF",  status: "Booked",   updated: "2026-02-25" },
  { tripId: "FQR3HD",  tripStart: "2026-02-26", tripEnd: "2026-02-26", tail: "N371DB",  from: "BED",  to: "PBI",  status: "Booked",   updated: "2026-02-25" },
  { tripId: "WAKKAW",  tripStart: "2026-02-26", tripEnd: "2026-02-27", tail: "N106PC",  from: "YKM",  to: "ORF",  status: "Booked",   updated: "2026-02-25" },
  { tripId: "08NTGO",  tripStart: "2026-02-26", tripEnd: "2026-03-02", tail: "N102VR",  from: "ABE",  to: "OPF",  status: "Booked",   updated: "2026-02-25" },
  { tripId: "S080LA",  tripStart: "2026-02-26", tripEnd: "2026-02-26", tail: "N552FX",  from: "PWM",  to: "ILM",  status: "Booked",   updated: "2026-02-25" },
  { tripId: "0ZSY12",  tripStart: "2026-02-26", tripEnd: "2026-02-26", tail: "N553FX",  from: "TEB",  to: "OPF",  status: "Booked",   updated: "2026-02-25" },
  { tripId: "DJFRB0",  tripStart: "2026-02-26", tripEnd: "2026-02-27", tail: "N187CR",  from: "TKI",  to: "RDU",  status: "Booked",   updated: "2026-02-25" },
  { tripId: "787LHB",  tripStart: "2026-02-26", tripEnd: "2026-02-27", tail: "N703TX",  from: "TEB",  to: "DAL",  status: "Booked",   updated: "2026-02-24" },
  { tripId: "1S8AMM",  tripStart: "2026-02-26", tripEnd: "2026-02-27", tail: "N957JS",  from: "TEB",  to: "VNY",  status: "Booked",   updated: "2026-02-25" },
  { tripId: "LDCVP0",  tripStart: "2026-02-27", tripEnd: "2026-02-27", tail: "N51GB",   from: "LYH",  to: "PWM",  status: "Booked",   updated: "2026-02-23" },
  { tripId: "1D0H0S",  tripStart: "2026-02-27", tripEnd: "2026-02-27", tail: "N301HR",  from: "HOU",  to: "OXC",  status: "Booked",   updated: "2026-02-24" },
  { tripId: "C06OFI",  tripStart: "2026-02-27", tripEnd: "2026-02-27", tail: "N988TX",  from: "SGF",  to: "PBI",  status: "Booked",   updated: "2026-02-25" },
  { tripId: "N9CLP1",  tripStart: "2026-02-27", tripEnd: "2026-02-27", tail: "N971JS",  from: "PDX",  to: "BOS",  status: "Booked",   updated: "2026-02-24" },
  { tripId: "LFBTQO",  tripStart: "2026-02-27", tripEnd: "2026-02-27", tail: "N733FL",  from: "INT",  to: "EGE",  status: "Booked",   updated: "2026-02-24" },
  { tripId: "VRLZ0D",  tripStart: "2026-02-27", tripEnd: "2026-02-27", tail: "N883TR",  from: "GTU",  to: "APF",  status: "Booked",   updated: "2026-02-24" },
  { tripId: "SP81LU",  tripStart: "2026-02-27", tripEnd: "2026-03-15", tail: "N700LH",  from: "BED",  to: "MMMY", status: "Booked",   updated: "2026-02-25" },
  { tripId: "BEWUJE",  tripStart: "2026-02-27", tripEnd: "2026-02-27", tail: "N125TH",  from: "TEB",  to: "IAD",  status: "Booked",   updated: "2026-02-24" },
  { tripId: "WYQ91O",  tripStart: "2026-02-27", tripEnd: "2026-02-28", tail: "N703TX",  from: "DAL",  to: "EGE",  status: "Booked",   updated: "2026-02-24" },
  { tripId: "V5YQNS",  tripStart: "2026-02-27", tripEnd: "2026-02-28", tail: "N201HR",  from: "VNY",  to: "TEB",  status: "Booked",   updated: "2026-02-23" },
  { tripId: "D1RNHV",  tripStart: "2026-02-27", tripEnd: "2026-03-03", tail: "N187CR",  from: "PHL",  to: "TME",  status: "Booked",   updated: "2026-02-24" },
  { tripId: "IXK41H",  tripStart: "2026-02-27", tripEnd: "2026-02-27", tail: "N552FX",  from: "HPN",  to: "SLC",  status: "Booked",   updated: "2026-02-25" },
  { tripId: "TQF9WX",  tripStart: "2026-02-27", tripEnd: "2026-02-28", tail: "N513JB",  from: "SFO",  to: "TEB",  status: "Booked",   updated: "2026-02-24" },
  { tripId: "47QY7Y",  tripStart: "2026-02-27", tripEnd: "2026-02-27", tail: "N998CX",  from: "AUS",  to: "SSI",  status: "Booked",   updated: "2026-02-25" },
  { tripId: "EZ6FVE",  tripStart: "2026-02-27", tripEnd: "2026-03-03", tail: "N818CF",  from: "LAL",  to: "SNA",  status: "Booked",   updated: "2026-02-25" },
  { tripId: "YIERKC",  tripStart: "2026-02-27", tripEnd: "2026-02-28", tail: "N106PC",  from: "TEB",  to: "MDLR", status: "Booked",   updated: "2026-02-24" },
];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AircraftOvernightPosition = {
  tail: string;
  airport: string;           // IATA/ICAO code
  airportName: string;
  city: string;
  state: string;
  lat: number;
  lon: number;
  tripId: string;
  tripStatus: string;
  isKnown: boolean;          // false if we can't resolve coords
};

export type VanAssignment = {
  vanId: number;             // 1–16
  homeAirport: string;       // primary overnight base
  lat: number;
  lon: number;
  coverageRadius: number;    // km, for map circle
  aircraft: AircraftOvernightPosition[];
  region: string;
};

// ---------------------------------------------------------------------------
// Step 1: Compute overnight positions for a given date
// ---------------------------------------------------------------------------

/**
 * For each tail in the fleet, find where it ends the night of `date`.
 *
 * Strategy:
 *  - Find all trips that END on or before `date` (the aircraft has landed).
 *  - Among those, take the most recently ending trip (latest tripEnd, then latest updated).
 *  - If a trip ends exactly on `date`, that "To" airport is the overnight spot.
 *  - If no trip ends on `date` but a multi-day trip spans through `date`, the aircraft is
 *    "en-route" (we approximate using the destination city of the trip origin).
 */
export function computeOvernightPositions(date: string): AircraftOvernightPosition[] {
  // Group trips by tail
  const byTail = new Map<string, Trip[]>();
  for (const t of TRIPS) {
    const arr = byTail.get(t.tail) ?? [];
    arr.push(t);
    byTail.set(t.tail, arr);
  }

  const results: AircraftOvernightPosition[] = [];

  for (const [tail, trips] of byTail) {
    // Sort by tripEnd desc, then updated desc
    const sorted = [...trips].sort((a, b) => {
      if (b.tripEnd !== a.tripEnd) return b.tripEnd.localeCompare(a.tripEnd);
      return b.updated.localeCompare(a.updated);
    });

    // Find the best trip for this date
    // 1. Trip ending exactly on this date
    const endingToday = sorted.filter((t) => t.tripEnd === date);
    // 2. Trip spanning this date (started before, ends after)
    const spanning = sorted.filter((t) => t.tripStart <= date && t.tripEnd > date);
    // 3. Most recent trip that ended before this date
    const pastTrips = sorted.filter((t) => t.tripEnd < date);

    let bestTrip: Trip | null = null;
    let airport: string;

    if (endingToday.length > 0) {
      // Multiple trips ending today — take the one with the latest updated time
      bestTrip = endingToday[0];
      airport = bestTrip.to;
    } else if (spanning.length > 0) {
      // Aircraft is mid-trip; best guess is origin (departed but not arrived yet)
      bestTrip = spanning[0];
      airport = bestTrip.from; // could be mid-leg — approximate
    } else if (pastTrips.length > 0) {
      bestTrip = pastTrips[0];
      airport = bestTrip.to;
    } else {
      continue; // no data for this tail
    }

    const info = getAirportInfo(airport);
    results.push({
      tail,
      airport,
      airportName: info?.name ?? airport,
      city: info?.city ?? "Unknown",
      state: info?.state ?? "",
      lat: info?.lat ?? 0,
      lon: info?.lon ?? 0,
      tripId: bestTrip.tripId,
      tripStatus: bestTrip.status,
      isKnown: info !== null,
    });
  }

  // Sort by tail
  return results.sort((a, b) => a.tail.localeCompare(b.tail));
}

// ---------------------------------------------------------------------------
// Step 2: Assign vans to aircraft.
//
// Phase 1 — Fixed zones (V1-V8):
//   Each aircraft within MAX_ZONE_DISTANCE_KM of a fixed zone home base is
//   assigned there (nearest zone first, capped at maxPerVan).
//
// Phase 2 — Overflow vans (V9-V16):
//   Aircraft not covered by any fixed zone are grouped geographically into
//   up to 8 additional "flex vans" that position themselves near the work.
//
// 48-states rule: offshore / international aircraft are excluded entirely.
// ---------------------------------------------------------------------------

const MAX_ZONE_DISTANCE_KM = 700;   // ~6-7 hour drive — max reach for a fixed zone van
const MAX_TOTAL_VANS       = 16;
const OVERFLOW_START_ID    = FIXED_VAN_ZONES.length + 1; // 9
const MAX_OVERFLOW_VANS    = MAX_TOTAL_VANS - FIXED_VAN_ZONES.length; // 8
const OVERFLOW_GROUP_KM    = 450;   // max radius to merge unassigned aircraft into one overflow van

export const haversineKm = (lat1: number, lon1: number, lat2: number, lon2: number): number => {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

function overflowRegionLabel(lat: number, lon: number): string {
  if (lat > 45) return "Pacific NW";
  if (lon > -80 && lat > 35) return "Mid-Atlantic";
  if (lon > -80 && lat <= 35) return "Southeast";
  if (lon > -95 && lat > 40) return "Midwest";
  if (lon > -95 && lat <= 40) return "South Central";
  if (lon > -115) return "Mountain West";
  return "West Coast";
}

export function assignVans(
  positions: AircraftOvernightPosition[],
  _numVans = MAX_TOTAL_VANS, // ignored, kept for API compat
  maxPerVan = 4
): VanAssignment[] {
  // Only assign vans to aircraft in the contiguous 48 states
  const eligible = positions.filter(
    (p) => p.isKnown && p.lat !== 0 && isContiguous48(p.state)
  );
  if (eligible.length === 0) return [];

  // Sort aircraft so closest-to-a-zone goes first (ensures nearest aircraft win slots)
  const sorted = [...eligible].sort((a, b) => {
    const dA = Math.min(...FIXED_VAN_ZONES.map((z) => haversineKm(a.lat, a.lon, z.lat, z.lon)));
    const dB = Math.min(...FIXED_VAN_ZONES.map((z) => haversineKm(b.lat, b.lon, z.lat, z.lon)));
    return dA - dB;
  });

  // ── Phase 1: assign to fixed zones (only within MAX_ZONE_DISTANCE_KM) ──
  const fixedClusters: AircraftOvernightPosition[][] = FIXED_VAN_ZONES.map(() => []);
  const unassigned: AircraftOvernightPosition[] = [];

  for (const ac of sorted) {
    const ranked = FIXED_VAN_ZONES
      .map((z, i) => ({ i, d: haversineKm(ac.lat, ac.lon, z.lat, z.lon) }))
      .sort((a, b) => a.d - b.d);

    if (ranked[0].d > MAX_ZONE_DISTANCE_KM) {
      // Too far from every fixed zone — goes to overflow
      unassigned.push(ac);
      continue;
    }

    let placed = false;
    for (const { i, d } of ranked) {
      if (d > MAX_ZONE_DISTANCE_KM) break; // stop checking once beyond cutoff
      if (fixedClusters[i].length < maxPerVan) {
        fixedClusters[i].push(ac);
        placed = true;
        break;
      }
    }
    if (!placed) {
      // All nearby zones at cap — overflow
      unassigned.push(ac);
    }
  }

  // ── Phase 2: overflow vans (V9-V16) — greedy nearest-center grouping ──
  type OverflowVan = { lat: number; lon: number; airport: string; aircraft: AircraftOvernightPosition[] };
  const overflowVans: OverflowVan[] = [];

  for (const ac of unassigned) {
    // Find an existing overflow van close enough with capacity
    let bestIdx = -1;
    let bestDist = OVERFLOW_GROUP_KM;
    for (let i = 0; i < overflowVans.length; i++) {
      const d = haversineKm(ac.lat, ac.lon, overflowVans[i].lat, overflowVans[i].lon);
      if (d < bestDist && overflowVans[i].aircraft.length < maxPerVan) {
        bestDist = d;
        bestIdx = i;
      }
    }

    if (bestIdx >= 0) {
      overflowVans[bestIdx].aircraft.push(ac);
      // Re-center overflow van to centroid of its aircraft
      const ov = overflowVans[bestIdx];
      ov.lat = ov.aircraft.reduce((s, a) => s + a.lat, 0) / ov.aircraft.length;
      ov.lon = ov.aircraft.reduce((s, a) => s + a.lon, 0) / ov.aircraft.length;
    } else if (overflowVans.length < MAX_OVERFLOW_VANS) {
      overflowVans.push({ lat: ac.lat, lon: ac.lon, airport: ac.airport, aircraft: [ac] });
    }
    // If no slot anywhere, skip (OK to miss some)
  }

  // ── Build result ──
  const result: VanAssignment[] = [];

  FIXED_VAN_ZONES.forEach((zone, i) => {
    const aircraft = fixedClusters[i];
    if (aircraft.length === 0) return;
    const maxDist = Math.max(...aircraft.map((a) => haversineKm(zone.lat, zone.lon, a.lat, a.lon)));
    result.push({
      vanId: zone.vanId,
      homeAirport: zone.homeAirport,
      lat: zone.lat,
      lon: zone.lon,
      coverageRadius: Math.max(maxDist, 50),
      aircraft,
      region: zone.name,
    });
  });

  overflowVans.forEach((ov, i) => {
    const maxDist = Math.max(...ov.aircraft.map((a) => haversineKm(ov.lat, ov.lon, a.lat, a.lon)));
    result.push({
      vanId: OVERFLOW_START_ID + i,
      homeAirport: ov.airport,
      lat: ov.lat,
      lon: ov.lon,
      coverageRadius: Math.max(maxDist, 50),
      aircraft: ov.aircraft,
      region: `${overflowRegionLabel(ov.lat, ov.lon)} (Flex)`,
    });
  });

  return result.sort((a, b) => b.aircraft.length - a.aircraft.length);
}

// Pre-compute for today and tomorrow (kept for backward-compat)
export const TODAY = "2026-02-25";
export const TOMORROW = "2026-02-26";

/**
 * Returns an array of YYYY-MM-DD strings starting from today (local date),
 * going `days` days forward.
 */
export function getDateRange(days = 7): string[] {
  const today = new Date();
  return Array.from({ length: days }, (_, i) => {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() + i);
    return [
      d.getFullYear(),
      String(d.getMonth() + 1).padStart(2, "0"),
      String(d.getDate()).padStart(2, "0"),
    ].join("-");
  });
}
