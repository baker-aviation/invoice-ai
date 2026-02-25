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
// Step 2: Assign 16 vans to overnight aircraft clusters
// ---------------------------------------------------------------------------

const haversineKm = (lat1: number, lon1: number, lat2: number, lon2: number): number => {
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

/**
 * Simple greedy k-means-style van placement.
 *
 * 1. Start with 16 cluster seeds (aircraft at unique airports, spread geographically).
 * 2. Iterate: assign each aircraft to its nearest van, then re-center each van.
 * 3. Return the final assignments.
 */
export function assignVans(
  positions: AircraftOvernightPosition[],
  numVans = 16
): VanAssignment[] {
  const known = positions.filter((p) => p.isKnown && p.lat !== 0);
  if (known.length === 0) return [];

  // Deduplicate airports — pick one aircraft per unique airport as seed
  const uniqueAirports = Array.from(new Map(known.map((p) => [p.airport, p])).values());

  // Seed: take up to numVans most geographically spread airports
  // Simple approach: pick first, then always pick the point furthest from existing seeds
  const seeds: { lat: number; lon: number; airport: string }[] = [];

  // Start with the first airport
  seeds.push(uniqueAirports[0]);
  while (seeds.length < Math.min(numVans, uniqueAirports.length)) {
    let maxMinDist = -1;
    let farthest = uniqueAirports[0];
    for (const apt of uniqueAirports) {
      if (seeds.some((s) => s.airport === apt.airport)) continue;
      const minDist = Math.min(...seeds.map((s) => haversineKm(s.lat, s.lon, apt.lat, apt.lon)));
      if (minDist > maxMinDist) {
        maxMinDist = minDist;
        farthest = apt;
      }
    }
    seeds.push(farthest);
  }

  // Fill remaining vans with copies of the closest seed if we have fewer airports than vans
  let centers = seeds.map((s) => ({ lat: s.lat, lon: s.lon, airport: s.airport }));
  while (centers.length < numVans) {
    centers.push({ ...centers[0] });
  }

  // k-means iterations
  for (let iter = 0; iter < 10; iter++) {
    // Assign each aircraft to nearest center
    const clusters: AircraftOvernightPosition[][] = Array.from({ length: numVans }, () => []);
    for (const ac of known) {
      let bestIdx = 0;
      let bestDist = Infinity;
      for (let i = 0; i < centers.length; i++) {
        const d = haversineKm(ac.lat, ac.lon, centers[i].lat, centers[i].lon);
        if (d < bestDist) { bestDist = d; bestIdx = i; }
      }
      clusters[bestIdx].push(ac);
    }

    // Re-center each van to the mean position of its cluster
    for (let i = 0; i < numVans; i++) {
      if (clusters[i].length === 0) continue;
      const latMean = clusters[i].reduce((s, a) => s + a.lat, 0) / clusters[i].length;
      const lonMean = clusters[i].reduce((s, a) => s + a.lon, 0) / clusters[i].length;
      // Snap to the nearest actual aircraft position (vans must be at a real airport)
      let nearest = clusters[i][0];
      let nearestDist = Infinity;
      for (const ac of clusters[i]) {
        const d = haversineKm(latMean, lonMean, ac.lat, ac.lon);
        if (d < nearestDist) { nearestDist = d; nearest = ac; }
      }
      centers[i] = { lat: nearest.lat, lon: nearest.lon, airport: nearest.airport };
    }
  }

  // Final assignment
  const finalClusters: AircraftOvernightPosition[][] = Array.from({ length: numVans }, () => []);
  for (const ac of known) {
    let bestIdx = 0;
    let bestDist = Infinity;
    for (let i = 0; i < centers.length; i++) {
      const d = haversineKm(ac.lat, ac.lon, centers[i].lat, centers[i].lon);
      if (d < bestDist) { bestDist = d; bestIdx = i; }
    }
    finalClusters[bestIdx].push(ac);
  }

  // Build region labels from state/geography
  const regionLabel = (lat: number, lon: number): string => {
    if (lon > -80) return "Southeast / Caribbean";
    if (lon > -90 && lat > 38) return "Northeast";
    if (lon > -90 && lat <= 38) return "Southeast";
    if (lon > -100 && lat > 40) return "Midwest";
    if (lon > -100 && lat <= 40) return "South Central";
    if (lon > -115) return "Mountain / West";
    return "West Coast";
  };

  return centers
    .map((c, i) => {
      const aircraft = finalClusters[i];
      const maxDist = aircraft.length > 0
        ? Math.max(...aircraft.map((a) => haversineKm(c.lat, c.lon, a.lat, a.lon)))
        : 50;
      return {
        vanId: i + 1,
        homeAirport: c.airport,
        lat: c.lat,
        lon: c.lon,
        coverageRadius: Math.max(maxDist, 50),
        aircraft,
        region: regionLabel(c.lat, c.lon),
      };
    })
    .filter((v) => v.aircraft.length > 0)  // hide empty vans
    .sort((a, b) => b.aircraft.length - a.aircraft.length);
}

// Pre-compute for today and tomorrow
export const TODAY = "2026-02-25";
export const TOMORROW = "2026-02-26";
