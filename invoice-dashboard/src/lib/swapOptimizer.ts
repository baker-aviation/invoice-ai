/**
 * Crew Swap Optimizer v2
 *
 * Matches the Excel swap sheet format: each crew member gets their own
 * independent travel plan. Oncoming crew travels TO the aircraft,
 * offgoing crew travels HOME from the aircraft.
 */

import { estimateDriveTime, type DriveEstimate } from "./driveTime";
import type { FlightOffer } from "./amadeus";

// ─── Types ───────────────────────────────────────────────────────────────────

export type CrewMember = {
  id: string;
  name: string;
  role: "PIC" | "SIC";
  home_airports: string[];
  aircraft_types: string[];
  is_checkairman: boolean;
  is_skillbridge: boolean;
  priority: number;
  standby_count?: number;
};

export type FlightLeg = {
  id: string;
  tail_number: string;
  departure_icao: string;
  arrival_icao: string;
  scheduled_departure: string;
  scheduled_arrival: string | null;
  flight_type: string | null;
  pic: string | null;
  sic: string | null;
};

export type AirportAlias = {
  fbo_icao: string;
  commercial_icao: string;
  preferred: boolean;
};

export type SwapAssignment = {
  oncoming_pic: string | null;
  oncoming_sic: string | null;
  offgoing_pic: string | null;
  offgoing_sic: string | null;
};

/** One row in the swap sheet — one crew member's travel plan */
export type CrewSwapRow = {
  name: string;
  home_airports: string[];
  role: "PIC" | "SIC";
  direction: "oncoming" | "offgoing";
  aircraft_type: string;         // citation_x, challenger, dual, unknown
  tail_number: string;           // aircraft they're assigned to
  swap_location: string | null;  // airport where they join/leave the aircraft
  // Travel details
  travel_type: "commercial" | "drive" | "none";
  flight_number: string | null;  // e.g. "UA1234" or "DRV"
  departure_time: string | null; // ISO
  arrival_time: string | null;   // ISO
  travel_from: string | null;
  travel_to: string | null;
  cost_estimate: number | null;
  duration_minutes: number | null;
  // When they're available on the aircraft
  available_time: string | null;
  // Extra
  is_checkairman: boolean;
  is_skillbridge: boolean;
  notes: string | null;
  warnings: string[];
  // Drive estimate if applicable
  drive_estimate: DriveEstimate | null;
  // Commercial flight offer if applicable
  flight_offer: FlightOffer | null;
  // All commercial options (for display)
  alt_flights: { flight_number: string; dep: string; arr: string; price: string }[];
};

export type SwapPlanResult = {
  swap_date: string;
  rows: CrewSwapRow[];
  warnings: string[];
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

const LIVE_TYPES = new Set(["charter", "revenue", "owner"]);

function isLiveType(type: string | null): boolean {
  return !!type && LIVE_TYPES.has(type.toLowerCase());
}

function isWednesday(iso: string, wedDate: string): boolean {
  return iso.slice(0, 10) === wedDate;
}

/** Normalize a name for fuzzy matching */
function normalizeName(name: string): string {
  let n = name.trim().toLowerCase();
  if (n.includes(",")) {
    const parts = n.split(",").map((p) => p.trim());
    if (parts.length === 2) n = `${parts[1]} ${parts[0]}`;
  }
  return n.replace(/\s+/g, " ");
}

/** Find crew member by fuzzy name match */
function findCrewByName(roster: CrewMember[], name: string, role: "PIC" | "SIC"): CrewMember | null {
  const norm = normalizeName(name);
  const exact = roster.find((c) => c.role === role && normalizeName(c.name) === norm);
  if (exact) return exact;
  const normParts = norm.split(" ");
  const lastName = normParts[normParts.length - 1];
  const lastNameMatches = roster.filter((c) => {
    if (c.role !== role) return false;
    const cParts = normalizeName(c.name).split(" ");
    return cParts[cParts.length - 1] === lastName;
  });
  if (lastNameMatches.length === 1) return lastNameMatches[0];
  const contains = roster.find(
    (c) => c.role === role && (normalizeName(c.name).includes(norm) || norm.includes(normalizeName(c.name))),
  );
  return contains ?? null;
}

/** Find the commercial airport for an FBO airport */
function findCommercialAirport(fboIcao: string, aliases: AirportAlias[]): string {
  const preferred = aliases.find(
    (a) => a.fbo_icao.toUpperCase() === fboIcao.toUpperCase() && a.preferred,
  );
  if (preferred) return preferred.commercial_icao;
  const any = aliases.find(
    (a) => a.fbo_icao.toUpperCase() === fboIcao.toUpperCase(),
  );
  if (any) return any.commercial_icao;
  return fboIcao;
}

/** Convert ICAO to IATA (strip K prefix) */
function toIata(icao: string): string {
  return icao.length === 4 && icao.startsWith("K") ? icao.slice(1) : icao;
}

/** Ensure ICAO format (add K prefix for 3-letter US codes) */
function toIcao(code: string): string {
  return code.length === 3 ? `K${code}` : code;
}

// ─── Main optimizer ──────────────────────────────────────────────────────────

export function buildSwapPlan(params: {
  flights: FlightLeg[];
  crewRoster: CrewMember[];
  aliases: AirportAlias[];
  swapDate: string;
  commercialFlights?: Map<string, FlightOffer[]>;
  swapAssignments?: Record<string, SwapAssignment>;
}): SwapPlanResult {
  const { flights, crewRoster, aliases, swapDate, commercialFlights, swapAssignments } = params;
  const warnings: string[] = [];
  const rows: CrewSwapRow[] = [];

  if (!swapAssignments || Object.keys(swapAssignments).length === 0) {
    warnings.push("No swap assignments found. Upload the swap Excel document first.");
    return { swap_date: swapDate, rows, warnings };
  }

  // Group flights by tail
  const byTail = new Map<string, FlightLeg[]>();
  for (const f of flights) {
    if (!f.tail_number) continue;
    if (!byTail.has(f.tail_number)) byTail.set(f.tail_number, []);
    byTail.get(f.tail_number)!.push(f);
  }
  for (const [, legs] of byTail) {
    legs.sort((a, b) => new Date(a.scheduled_departure).getTime() - new Date(b.scheduled_departure).getTime());
  }

  // Process each tail's swap assignments
  for (const [tail, assignment] of Object.entries(swapAssignments)) {
    const legs = byTail.get(tail) ?? [];
    const wedLegs = legs.filter((f) => isWednesday(f.scheduled_departure, swapDate));

    // Determine aircraft type from crew roster
    const anyCrewName = assignment.oncoming_pic ?? assignment.offgoing_pic ?? assignment.oncoming_sic ?? assignment.offgoing_sic;
    const anyCrewMember = anyCrewName ? findCrewByName(crewRoster, anyCrewName, "PIC") ?? findCrewByName(crewRoster, anyCrewName, "SIC") : null;
    const aircraftType = anyCrewMember?.aircraft_types[0] ?? "unknown";

    // Determine key airports for this tail on Wednesday
    // First airport: where aircraft starts Wednesday (or last known before Wed)
    const priorLegs = legs.filter(
      (f) => new Date(f.scheduled_departure).getTime() < new Date(swapDate).getTime(),
    );
    const lastPrior = priorLegs[priorLegs.length - 1];
    const overnightAirport = lastPrior?.arrival_icao ?? wedLegs[0]?.departure_icao ?? null;
    const firstWedDeparture = wedLegs[0]?.departure_icao ?? overnightAirport;
    const lastWedArrival = wedLegs.length > 0 ? wedLegs[wedLegs.length - 1].arrival_icao : overnightAirport;

    // All Wednesday airports in order (where crew could join/leave)
    const wedAirports: { icao: string; time: string; type: "departure" | "arrival"; isLive: boolean }[] = [];
    if (overnightAirport && wedLegs.length > 0) {
      // Aircraft is at overnight airport before first Wednesday leg
      wedAirports.push({
        icao: overnightAirport,
        time: wedLegs[0].scheduled_departure,
        type: "departure",
        isLive: isLiveType(wedLegs[0].flight_type),
      });
    }
    for (const wl of wedLegs) {
      if (wl.arrival_icao) {
        wedAirports.push({
          icao: wl.arrival_icao,
          time: wl.scheduled_arrival ?? wl.scheduled_departure,
          type: "arrival",
          isLive: isLiveType(wl.flight_type),
        });
      }
      // Next departure if there's a gap
      const idx = wedLegs.indexOf(wl);
      if (idx < wedLegs.length - 1) {
        wedAirports.push({
          icao: wedLegs[idx + 1].departure_icao,
          time: wedLegs[idx + 1].scheduled_departure,
          type: "departure",
          isLive: isLiveType(wedLegs[idx + 1].flight_type),
        });
      }
    }
    if (wedAirports.length === 0 && overnightAirport) {
      // Aircraft idle all day — crew swaps at overnight position
      wedAirports.push({
        icao: overnightAirport,
        time: `${swapDate}T12:00:00Z`,
        type: "departure",
        isLive: false,
      });
    }

    // Process each crew member in this assignment
    const crewEntries: { name: string; role: "PIC" | "SIC"; direction: "oncoming" | "offgoing" }[] = [];
    if (assignment.oncoming_pic) crewEntries.push({ name: assignment.oncoming_pic, role: "PIC", direction: "oncoming" });
    if (assignment.oncoming_sic) crewEntries.push({ name: assignment.oncoming_sic, role: "SIC", direction: "oncoming" });
    if (assignment.offgoing_pic) crewEntries.push({ name: assignment.offgoing_pic, role: "PIC", direction: "offgoing" });
    if (assignment.offgoing_sic) crewEntries.push({ name: assignment.offgoing_sic, role: "SIC", direction: "offgoing" });

    for (const entry of crewEntries) {
      const crewMember = findCrewByName(crewRoster, entry.name, entry.role);
      const rowWarnings: string[] = [];

      if (!crewMember) {
        rowWarnings.push(`Crew member "${entry.name}" not found in roster`);
      }

      const homeAirports = crewMember?.home_airports ?? [];
      const homeIata = homeAirports[0] ? toIata(homeAirports[0]) : null;

      // Determine swap location based on direction
      let swapLocation: string | null = null;
      let bestTravel: {
        type: "commercial" | "drive" | "none";
        flightNumber: string | null;
        depTime: string | null;
        arrTime: string | null;
        from: string | null;
        to: string | null;
        cost: number | null;
        duration: number | null;
        drive: DriveEstimate | null;
        offer: FlightOffer | null;
        altFlights: { flight_number: string; dep: string; arr: string; price: string }[];
        availableTime: string | null;
      } = {
        type: "none", flightNumber: null, depTime: null, arrTime: null,
        from: null, to: null, cost: null, duration: null, drive: null,
        offer: null, altFlights: [], availableTime: null,
      };

      if (entry.direction === "oncoming") {
        // Oncoming crew needs to GET TO the aircraft
        // Best swap location: first airport on Wednesday (they need to be there before first leg)
        // Or the airport with best commercial service from their home
        swapLocation = firstWedDeparture;
        const swapIcao = swapLocation ? toIcao(swapLocation) : null;
        const commercialAirport = swapLocation ? findCommercialAirport(swapLocation, aliases) : null;
        const commIata = commercialAirport ? toIata(commercialAirport) : null;

        if (homeIata && commIata && commercialFlights) {
          // Search for commercial flights from home to swap location
          const key = `${homeIata}-${commIata}-${swapDate}`;
          const offers = commercialFlights.get(key);
          if (offers && offers.length > 0) {
            const best = offers[0];
            const segs = best.itineraries[0]?.segments ?? [];
            const firstSeg = segs[0];
            const lastSeg = segs[segs.length - 1];
            if (firstSeg && lastSeg) {
              bestTravel = {
                type: "commercial",
                flightNumber: segs.map((s) => `${s.carrierCode}${s.number}`).join("/"),
                depTime: firstSeg.departure.at,
                arrTime: lastSeg.arrival.at,
                from: firstSeg.departure.iataCode,
                to: lastSeg.arrival.iataCode,
                cost: parseFloat(best.price.total),
                duration: segs.reduce((s, sg) => {
                  const m = sg.duration.match(/PT(?:(\d+)H)?(?:(\d+)M)?/);
                  return s + (parseInt(m?.[1] ?? "0") * 60 + parseInt(m?.[2] ?? "0"));
                }, 0),
                drive: null,
                offer: best,
                altFlights: offers.slice(1, 4).map((o) => {
                  const ss = o.itineraries[0]?.segments ?? [];
                  return {
                    flight_number: ss.map((s) => `${s.carrierCode}${s.number}`).join("/"),
                    dep: ss[0]?.departure.at ?? "",
                    arr: ss[ss.length - 1]?.arrival.at ?? "",
                    price: o.price.total,
                  };
                }),
                availableTime: lastSeg.arrival.at,
              };
            }
          }
        }

        // Also check drive option
        if (homeIata && swapIcao) {
          const drive = estimateDriveTime(toIcao(homeIata), swapIcao);
          if (drive && drive.feasible) {
            // Use drive if no commercial flight found, or if drive is cheaper/faster
            if (bestTravel.type === "none") {
              bestTravel = {
                type: "drive",
                flightNumber: "DRIVE",
                depTime: null,
                arrTime: null,
                from: homeIata,
                to: toIata(swapLocation ?? ""),
                cost: Math.round(drive.estimated_drive_miles * 0.67),
                duration: drive.estimated_drive_minutes,
                drive,
                offer: null,
                altFlights: [],
                availableTime: null,
              };
            }
          }
        }

        if (bestTravel.type === "none" && homeIata && swapLocation) {
          rowWarnings.push(`No transport found from ${homeIata} to ${toIata(swapLocation)}`);
        }

      } else {
        // Offgoing crew needs to GET HOME from the aircraft
        // They leave from the last airport the aircraft visits on Wednesday
        swapLocation = lastWedArrival;
        const swapIcao = swapLocation ? toIcao(swapLocation) : null;
        const commercialAirport = swapLocation ? findCommercialAirport(swapLocation, aliases) : null;
        const commIata = commercialAirport ? toIata(commercialAirport) : null;

        if (homeIata && commIata && commercialFlights) {
          // Search for flights from swap location to home
          const key = `${commIata}-${homeIata}-${swapDate}`;
          const offers = commercialFlights.get(key);
          if (offers && offers.length > 0) {
            const best = offers[0];
            const segs = best.itineraries[0]?.segments ?? [];
            const firstSeg = segs[0];
            const lastSeg = segs[segs.length - 1];
            if (firstSeg && lastSeg) {
              bestTravel = {
                type: "commercial",
                flightNumber: segs.map((s) => `${s.carrierCode}${s.number}`).join("/"),
                depTime: firstSeg.departure.at,
                arrTime: lastSeg.arrival.at,
                from: firstSeg.departure.iataCode,
                to: lastSeg.arrival.iataCode,
                cost: parseFloat(best.price.total),
                duration: segs.reduce((s, sg) => {
                  const m = sg.duration.match(/PT(?:(\d+)H)?(?:(\d+)M)?/);
                  return s + (parseInt(m?.[1] ?? "0") * 60 + parseInt(m?.[2] ?? "0"));
                }, 0),
                drive: null,
                offer: best,
                altFlights: offers.slice(1, 4).map((o) => {
                  const ss = o.itineraries[0]?.segments ?? [];
                  return {
                    flight_number: ss.map((s) => `${s.carrierCode}${s.number}`).join("/"),
                    dep: ss[0]?.departure.at ?? "",
                    arr: ss[ss.length - 1]?.arrival.at ?? "",
                    price: o.price.total,
                  };
                }),
                availableTime: null,
              };
            }
          }
        }

        // Drive option
        if (homeIata && swapIcao) {
          const drive = estimateDriveTime(swapIcao, toIcao(homeIata));
          if (drive && drive.feasible) {
            if (bestTravel.type === "none") {
              bestTravel = {
                type: "drive",
                flightNumber: "DRIVE",
                depTime: null,
                arrTime: null,
                from: toIata(swapLocation ?? ""),
                to: homeIata,
                cost: Math.round(drive.estimated_drive_miles * 0.67),
                duration: drive.estimated_drive_minutes,
                drive,
                offer: null,
                altFlights: [],
                availableTime: null,
              };
            }
          }
        }

        if (bestTravel.type === "none" && homeIata && swapLocation) {
          rowWarnings.push(`No transport found from ${toIata(swapLocation)} to ${homeIata}`);
        }
      }

      rows.push({
        name: crewMember?.name ?? entry.name,
        home_airports: homeAirports,
        role: entry.role,
        direction: entry.direction,
        aircraft_type: crewMember?.aircraft_types[0] ?? aircraftType,
        tail_number: tail,
        swap_location: swapLocation ? toIata(swapLocation) : null,
        travel_type: bestTravel.type,
        flight_number: bestTravel.flightNumber,
        departure_time: bestTravel.depTime,
        arrival_time: bestTravel.arrTime,
        travel_from: bestTravel.from,
        travel_to: bestTravel.to,
        cost_estimate: bestTravel.cost,
        duration_minutes: bestTravel.duration,
        available_time: bestTravel.availableTime,
        is_checkairman: crewMember?.is_checkairman ?? false,
        is_skillbridge: crewMember?.is_skillbridge ?? false,
        notes: null,
        warnings: rowWarnings,
        drive_estimate: bestTravel.drive,
        flight_offer: bestTravel.offer,
        alt_flights: bestTravel.altFlights,
      });
    }
  }

  // Sort rows: oncoming PIC, oncoming SIC, offgoing PIC, offgoing SIC
  const sectionOrder = (r: CrewSwapRow) => {
    if (r.direction === "oncoming" && r.role === "PIC") return 0;
    if (r.direction === "oncoming" && r.role === "SIC") return 1;
    if (r.direction === "offgoing" && r.role === "PIC") return 2;
    return 3;
  };
  rows.sort((a, b) => sectionOrder(a) - sectionOrder(b) || a.name.localeCompare(b.name));

  return { swap_date: swapDate, rows, warnings };
}
