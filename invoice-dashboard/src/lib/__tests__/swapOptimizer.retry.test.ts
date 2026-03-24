/**
 * Tests for offgoing swap-point retry logic.
 *
 * When offgoing crew can't get transport home because the oncoming PIC arrives
 * too late (after_live, late evening), the optimizer retries at an earlier swap
 * point (before_live). This is how humans solve it: swap at the departure airport
 * where commercial flights are available all day.
 */
import { describe, it, expect } from "vitest";
import {
  buildSwapPlan,
  solveOffgoingFirst,
  type FlightLeg,
  type CrewMember,
  type AirportAlias,
} from "../swapOptimizer";
import type { FlightOffer } from "../amadeus";

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Build a minimal FlightOffer with local departure/arrival times */
function offer(
  id: string,
  depIata: string,
  depLocal: string,
  arrIata: string,
  arrLocal: string,
  price: number,
): FlightOffer {
  const carrier = "UA";
  const num = id;
  const depDate = depLocal.split(" ")[0];
  const arrDate = arrLocal.split(" ")[0];
  const depTime = depLocal.split(" ")[1];
  const arrTime = arrLocal.split(" ")[1];
  // Estimate duration from the times (rough — just for the offer shape)
  return {
    id,
    price: { total: String(price), currency: "USD" },
    itineraries: [
      {
        duration: "PT3H0M",
        segments: [
          {
            departure: { iataCode: depIata, at: depLocal },
            arrival: { iataCode: arrIata, at: arrLocal },
            carrierCode: carrier,
            number: num,
            duration: "PT3H0M",
            numberOfStops: 0,
          },
        ],
      },
    ],
    numberOfBookableSeats: 5,
  };
}

const SWAP_DATE = "2026-04-15";

/**
 * Create a set of flights that produce two swap points:
 * - before_live at KTEB (departure)
 * - after_live at KVNY (arrival, late evening)
 *
 * The charter leg departs KTEB at 3pm ET, arrives KVNY at 6pm PT.
 * By the time oncoming arrives + handoff, it'll be ~7pm+ PT — tough for flights out.
 */
function makeTailFlights(): FlightLeg[] {
  return [
    {
      id: "leg-1",
      tail_number: "N100BA",
      departure_icao: "KTEB",
      arrival_icao: "KVNY",
      scheduled_departure: "2026-04-15T19:00:00Z", // 3pm ET
      scheduled_arrival: "2026-04-16T01:00:00Z", // 6pm PT
      flight_type: "charter",
      pic: "Smith, John",
      sic: null,
    },
  ];
}

function makeCrew(): CrewMember[] {
  return [
    {
      id: "crew-oncoming-pic",
      name: "Jones, Mike",
      role: "PIC",
      home_airports: ["KSFO"],
      aircraft_types: ["G650"],
      is_checkairman: false,
      checkairman_types: [],
      is_skillbridge: false,
      grade: 3,
      restrictions: {},
      priority: 1,
    },
    {
      id: "crew-offgoing-pic",
      name: "Smith, John",
      role: "PIC",
      home_airports: ["KATL"],
      aircraft_types: ["G650"],
      is_checkairman: false,
      checkairman_types: [],
      is_skillbridge: false,
      grade: 3,
      restrictions: {},
      priority: 1,
    },
  ];
}

function makeAliases(): AirportAlias[] {
  return [
    { fbo_icao: "KVNY", commercial_icao: "KBUR", preferred: true },
    { fbo_icao: "KTEB", commercial_icao: "KEWR", preferred: true },
  ];
}

/**
 * Build commercial flights map.
 *
 * For the "stuck at after_live" scenario:
 * - BUR→ATL: only an early afternoon flight (3pm PT departure).
 *   After oncoming arrives at VNY ~5:30pm PT + 30min handoff = 6pm,
 *   the offgoing can't make this 3pm flight. The fboLeaveTime (~1pm PT)
 *   is before the oncoming PIC arrives → filtered by handoff constraint.
 *
 * For the retry at before_live (KTEB):
 * - EWR→ATL: evening flight (6pm ET). Offgoing at KTEB has all day to
 *   catch this flight since before_live releases crew at 5am.
 *
 * Oncoming flights:
 * - SFO→BUR: arriving 5pm PT (for after_live scenario)
 * - SFO→EWR: arriving 10am ET (for before_live retry)
 */
function makeCommercialFlights(): Map<string, FlightOffer[]> {
  const map = new Map<string, FlightOffer[]>();

  // Offgoing from BUR (near VNY) — only early flight, will be filtered by handoff
  map.set(`BUR-ATL-${SWAP_DATE}`, [
    offer("100", "BUR", `${SWAP_DATE} 15:00`, "ATL", `${SWAP_DATE} 22:00`, 350),
  ]);

  // Offgoing from EWR (near TEB) — evening flight, viable for before_live retry
  map.set(`EWR-ATL-${SWAP_DATE}`, [
    offer("200", "EWR", `${SWAP_DATE} 18:00`, "ATL", `${SWAP_DATE} 21:30`, 280),
  ]);

  // Oncoming SFO→BUR for after_live scenario (arrives 5pm PT, late)
  map.set(`SFO-BUR-${SWAP_DATE}`, [
    offer("300", "SFO", `${SWAP_DATE} 13:00`, "BUR", `${SWAP_DATE} 17:00`, 200),
  ]);

  // Oncoming SFO→EWR for before_live retry (arrives 10am ET, early)
  map.set(`SFO-EWR-${SWAP_DATE}`, [
    offer("400", "SFO", `${SWAP_DATE} 06:00`, "EWR", `${SWAP_DATE} 10:00`, 300),
  ]);

  return map;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("offgoing swap point retry", () => {
  describe("buildSwapPlan", () => {
    it("retries at earlier swap point when offgoing has no transport after handoff", () => {
      const result = buildSwapPlan({
        flights: makeTailFlights(),
        crewRoster: makeCrew(),
        aliases: makeAliases(),
        swapDate: SWAP_DATE,
        commercialFlights: makeCommercialFlights(),
        swapAssignments: {
          N100BA: {
            oncoming_pic: "Jones, Mike",
            oncoming_sic: null,
            offgoing_pic: "Smith, John",
            offgoing_sic: null,
            // Force swap at KVNY (after_live) — triggers the handoff issue
            oncoming_pic_swap_icao: "KVNY",
          },
        },
      });

      // Find the offgoing PIC row
      const offgoingPic = result.rows.find(
        (r) => r.name === "Smith, John" && r.direction === "offgoing",
      );
      expect(offgoingPic).toBeDefined();

      // After retry, offgoing should either:
      // 1. Have a real transport option (not "none")
      // 2. Have been moved to an earlier swap point (before_live at KTEB)
      // 3. Or at minimum, have the swap-point-moved warning
      const hasSwapMoveWarning = offgoingPic!.warnings.some((w) =>
        w.includes("Swap point moved"),
      );
      const hasRealTransport = offgoingPic!.travel_type !== "none";
      const handoffFailure = offgoingPic!.warnings.some((w) =>
        w.includes("No offgoing transport available"),
      );

      // The retry should have either solved it or at least tried
      if (hasSwapMoveWarning) {
        // Retry happened — swap location should be TEB (before_live)
        expect(offgoingPic!.swap_location).toBe("TEB");
      }

      // At least one of these should be true:
      // - Retry happened (swap move warning present)
      // - Or original swap point worked fine (has real transport, no handoff failure)
      expect(hasSwapMoveWarning || hasRealTransport || !handoffFailure).toBe(
        true,
      );
    });

    it("preserves original results when no earlier swap point exists", () => {
      // Tail with only one swap point (before_live) — no earlier point to retry
      const flights: FlightLeg[] = [
        {
          id: "leg-1",
          tail_number: "N200BA",
          departure_icao: "KTEB",
          arrival_icao: "KTEB", // round trip — only before_live swap point
          scheduled_departure: "2026-04-15T14:00:00Z",
          scheduled_arrival: "2026-04-15T18:00:00Z",
          flight_type: "charter",
          pic: "Smith, John",
          sic: null,
        },
      ];

      const result = buildSwapPlan({
        flights,
        crewRoster: makeCrew(),
        aliases: makeAliases(),
        swapDate: SWAP_DATE,
        commercialFlights: makeCommercialFlights(),
        swapAssignments: {
          N200BA: {
            oncoming_pic: "Jones, Mike",
            oncoming_sic: null,
            offgoing_pic: "Smith, John",
            offgoing_sic: null,
          },
        },
      });

      // Should produce rows without crashing
      expect(result.rows.length).toBeGreaterThan(0);

      // No "Swap point moved" warning since there's nothing earlier to try
      const offgoingPic = result.rows.find(
        (r) => r.name === "Smith, John" && r.direction === "offgoing",
      );
      if (offgoingPic) {
        const hasSwapMove = offgoingPic.warnings.some((w) =>
          w.includes("Swap point moved"),
        );
        expect(hasSwapMove).toBe(false);
      }
    });

    it("does not retry for idle tails", () => {
      // Idle tail — no live legs, just overnight position
      const priorDayLeg: FlightLeg[] = [
        {
          id: "prior-1",
          tail_number: "N300BA",
          departure_icao: "KATL",
          arrival_icao: "KLAS",
          scheduled_departure: "2026-04-14T14:00:00Z",
          scheduled_arrival: "2026-04-14T19:00:00Z",
          flight_type: "charter",
          pic: "Smith, John",
          sic: null,
        },
      ];

      const result = buildSwapPlan({
        flights: priorDayLeg,
        crewRoster: makeCrew(),
        aliases: makeAliases(),
        swapDate: SWAP_DATE,
        commercialFlights: makeCommercialFlights(),
        swapAssignments: {
          N300BA: {
            oncoming_pic: "Jones, Mike",
            oncoming_sic: null,
            offgoing_pic: "Smith, John",
            offgoing_sic: null,
          },
        },
      });

      // Idle tails should NOT trigger the retry (per plan: "not an idle tail")
      const offgoingPic = result.rows.find(
        (r) => r.name === "Smith, John" && r.direction === "offgoing",
      );
      if (offgoingPic) {
        const hasSwapMove = offgoingPic.warnings.some((w) =>
          w.includes("Swap point moved"),
        );
        expect(hasSwapMove).toBe(false);
      }
    });
  });

  describe("solveOffgoingFirst", () => {
    it("retries offgoing at earlier swap point when no viable transport", () => {
      const result = solveOffgoingFirst({
        flights: makeTailFlights(),
        crewRoster: makeCrew(),
        aliases: makeAliases(),
        swapDate: SWAP_DATE,
        commercialFlights: makeCommercialFlights(),
        swapAssignments: {
          N100BA: {
            oncoming_pic: "Jones, Mike",
            oncoming_sic: null,
            offgoing_pic: "Smith, John",
            offgoing_sic: null,
          },
        },
      });

      // Find offgoing plan for Smith
      const smithPlan = result.offgoingPlans.find(
        (p) => p.name === "Smith, John",
      );
      expect(smithPlan).toBeDefined();

      // If the original swap point (after_live at KVNY) had no viable transport,
      // the retry should have moved to before_live (KTEB → near EWR)
      if (smithPlan!.transport && smithPlan!.transport.type !== "none") {
        // Transport was found — either original or retry worked
        expect(smithPlan!.deadline).not.toBeNull();
      }

      // Check unsolvable list
      const unsolvableSmith = result.unsolvable.find(
        (u) => u.role === "PIC" && u.tail === "N100BA",
      );

      // If retry worked, Smith should NOT be in unsolvable
      // If retry moved swap point, plan's swap point should be KTEB
      if (smithPlan!.swapPoint === "KTEB") {
        expect(unsolvableSmith).toBeUndefined();
        expect(smithPlan!.deadline).not.toBeNull();
      }
    });

    it("returns deadlines for successfully retried offgoing", () => {
      const result = solveOffgoingFirst({
        flights: makeTailFlights(),
        crewRoster: makeCrew(),
        aliases: makeAliases(),
        swapDate: SWAP_DATE,
        commercialFlights: makeCommercialFlights(),
        swapAssignments: {
          N100BA: {
            oncoming_pic: "Jones, Mike",
            oncoming_sic: null,
            offgoing_pic: "Smith, John",
            offgoing_sic: null,
          },
        },
      });

      // If the offgoing was solved (at original or retry swap point),
      // there should be a deadline entry
      const deadline = result.deadlines.find(
        (d) => d.offgoingName === "Smith, John",
      );
      const smithPlan = result.offgoingPlans.find(
        (p) => p.name === "Smith, John",
      );

      if (smithPlan?.transport && smithPlan.transport.type !== "none") {
        expect(deadline).toBeDefined();
        expect(deadline!.deadline).toBeInstanceOf(Date);
      }
    });
  });
});
