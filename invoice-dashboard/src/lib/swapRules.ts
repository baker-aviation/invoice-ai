/**
 * Crew Swap Rules & Constants
 *
 * Source of truth for all crew swap planning logic.
 * These rules drive the optimizer's decision-making.
 */

// ─── Duty & Rest Limits ─────────────────────────────────────────────────────

/** Max duty day in hours */
export const MAX_DUTY_HOURS = 14;

/** Min uninterrupted rest in hours */
export const MIN_REST_HOURS = 10;

/** Max flight hours in 24-hour period */
export const MAX_FLIGHT_HOURS_24 = 10;

// ─── Timing Buffers (minutes) ────────────────────────────────────────────────

/** Duty-on starts this many minutes before commercial flight departure (from home airport) */
export const DUTY_ON_BEFORE_COMMERCIAL = 60;

/** After commercial landing, time to deplane and get to rental/Uber */
export const DEPLANE_BUFFER = 30;

/** New crew must arrive at FBO this many minutes before their scheduled flight */
export const FBO_ARRIVAL_BUFFER = 60;

/** Preferred FBO arrival buffer (when possible) */
export const FBO_ARRIVAL_BUFFER_PREFERRED = 90;

/** Old crew is off duty this many minutes after their last leg wheels down */
export const DUTY_OFF_AFTER_LAST_LEG = 30;

/** International leg: extra time for customs */
export const INTERNATIONAL_DUTY_OFF = 50;

/** Old crew going home: minutes before departure for security/gate */
export const AIRPORT_SECURITY_BUFFER = 45;

/** Old crew going home with rental car to return */
export const RENTAL_RETURN_BUFFER = 60;

/** Avoid new crew duty-on before this local hour */
export const EARLIEST_DUTY_ON_HOUR = 4; // 0400L

// ─── Ground Transport Thresholds ─────────────────────────────────────────────

/** Drive under this = Uber, no duty day adjustment for local crew */
export const UBER_MAX_MINUTES = 60;

/** Drive over UBER_MAX and under this = rental car */
export const RENTAL_MAX_MINUTES = 300; // 5 hours — uses crew duty day, not ideal but viable

/** Drives between these are rental car territory */
export const RENTAL_MIN_MINUTES = 60;

/** If crew has multiple home airports (e.g. FLL/MIA), no duty adjustment needed */

// ─── Crew Swap Day Rules ─────────────────────────────────────────────────────

/** Swaps happen on Wednesdays */
export const SWAP_DAY = 3; // 0=Sun, 3=Wed

/** Old crew must be home by this local hour on Wednesday (midnight) */
export const OLD_CREW_HOME_BY_HOUR = 24; // midnight

/** Skill-Bridge SICs: can work Thursday, try to get home Wednesday night */
export const SKILLBRIDGE_HOME_BY_DAY = "thursday";

// ─── Early/Late Volunteer Bonuses ────────────────────────────────────────────

/** PIC early/late volunteer bonus */
export const EARLY_LATE_BONUS_PIC = 1500;

/** SIC early/late volunteer bonus */
export const EARLY_LATE_BONUS_SIC = 1000;

/** Skill-Bridge SICs do NOT get early bonus */

// ─── Flight Search Preferences ───────────────────────────────────────────────

/** Strong preference for direct flights */
export const MAX_CONNECTIONS = 1; // never 2+ connections

/**
 * Budget carriers — AVOID unless no other option exists.
 * Even if a budget carrier is half the price of a major carrier on the same
 * route, pick the major carrier. Budget carriers are last-resort only
 * (frequent delays, bad connections, poor rebooking if things go wrong).
 *
 * Scoring: when a non-budget option exists for the same origin→destination,
 * budget carriers are eliminated. Only used when they are the SOLE option.
 */
export const BUDGET_CARRIERS = ["NK", "F9", "G4"]; // Spirit, Frontier, Allegiant

/** If the ONLY available flights are budget carriers, allow them */
export const BUDGET_CARRIER_LAST_RESORT = true;

/** Preferred connection hubs */
export const PREFERRED_HUBS = ["ATL", "DEN", "DFW", "ORD", "IAH", "CLT", "PHX", "MSP", "DTW", "EWR"];

/** Backup flight should be at least this many minutes after primary */
export const BACKUP_FLIGHT_MIN_GAP = 60;

/** More expensive flights = higher failure risk. Avoid when possible. */

// ─── Swap Location Preferences ───────────────────────────────────────────────

/**
 * EXTREMELY strong preference: swap before/after live legs ONLY.
 * Repositioning legs often change on the schedule.
 */

/**
 * PIC and SIC do NOT have to swap at the same location.
 * Can swap at different airports.
 */

/**
 * Can fly with 2 PICs on swap day if needed.
 * NEVER 2 SICs.
 */

// ─── Rental Car Handoff ──────────────────────────────────────────────────────

/** When offgoing crew takes oncoming's rental car, ground cost = fuel only */
export const RENTAL_HANDOFF_FUEL_COST = 20;

/**
 * New crew rents car, drives to regional FBO.
 * Old crew takes that car back to commercial airport for their flight home.
 * Saves money vs two separate Uber/rental trips.
 * System must account for rental return time before old crew's flight.
 */

// ─── Crew Handoff ──────────────────────────────────────────────────────────

/** Minimum overlap at FBO: oncoming must arrive this many minutes BEFORE offgoing leaves */
export const HANDOFF_BUFFER_MINUTES = 30;

// ─── Staggered Arrivals ─────────────────────────────────────────────────────

/** Warn if two oncoming crews arrive at the same airport within this gap */
export const STAGGER_MIN_GAP_HOURS = 2;

// ─── Unscheduled Aircraft Rules ──────────────────────────────────────────────

/**
 * When no legs scheduled Wednesday for a tail:
 * - Use last known position as swap location
 * - Get new crew there ASAP
 * - If multiple unscheduled tails at same airport (e.g., VNY):
 *   - First crew arrives ASAP
 *   - Second crew staggers 2-3 hours later for flexibility
 * - Match duty-on/arrival times of new crew (accounting for time zones)
 * - Hold old crew until ~1700-1800L departure where possible
 * - Still must get home by midnight
 * - If bonus situation for old crew, choose latest flight making midnight
 * - Aircraft must NEVER be unattended: new crew at FBO before old crew leaves
 */

// ─── Standby Rules ───────────────────────────────────────────────────────────

/**
 * If more crew than aircraft: excess go on standby
 * Standby is never guaranteed
 * If someone on standby is the only one who can execute a specific trip,
 * choose another crew member
 * Forced standby rotates through all crew before repeating
 * For SIC: Skill-Bridge always first for forced standby, then others
 */

// ─── International Swaps ─────────────────────────────────────────────────────

/**
 * Swapping in international countries is LAST RESORT.
 * Must follow all guidelines carefully.
 * Plan USA swaps as much as possible.
 */

// ─── Airport Alias Preferences ───────────────────────────────────────────────

/**
 * Many FBO airports have no commercial service.
 * Map to nearest commercial airport:
 *   VNY → BUR (preferred) or LAX
 *   TEB → EWR (preferred), LGA, or JFK
 *   OPF → MIA or FLL
 *   etc.
 * Backend setting for preferred commercial airports per FBO.
 */

// ─── Cost Optimization ──────────────────────────────────────────────────────

/**
 * Run multiple combinations of swaps to find best total cost.
 * Ground transport (Uber/rental/Amtrak/Brightline) preferred over flying
 *   when feasible and within duty limits.
 * Keep transit times low: don't fly FL→CA and CA→FL when avoidable.
 * Place PIC and SIC on same flights when possible (saves Uber/rental costs).
 * Stage arrivals at similar times for cost sharing.
 */
