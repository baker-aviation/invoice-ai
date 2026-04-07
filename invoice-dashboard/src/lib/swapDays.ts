/**
 * Multi-day swap planning utilities.
 *
 * Maps volunteer preferences to eligible swap days and computes
 * actual dates from a swap day + anchor Wednesday.
 */

export type SwapDay = "monday" | "tuesday" | "wednesday" | "thursday" | "friday" | "saturday" | "sunday";

export type VolunteerPreference = "early" | "late" | "standby" | null;

/** Day-of-week ordering (0 = Monday) */
const DAY_ORDER: Record<SwapDay, number> = {
  monday: 0,
  tuesday: 1,
  wednesday: 2,
  thursday: 3,
  friday: 4,
  saturday: 5,
  sunday: 6,
};

/** Label for display */
export const DAY_LABELS: Record<SwapDay, string> = {
  monday: "Mon",
  tuesday: "Tue",
  wednesday: "Wed",
  thursday: "Thu",
  friday: "Fri",
  saturday: "Sat",
  sunday: "Sun",
};

export const ALL_SWAP_DAYS: SwapDay[] = [
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
];

/**
 * Map volunteer preference to eligible swap days.
 * - Early → Mon/Tue/Wed (available early in the week)
 * - Late → Wed/Thu/Fri (available late in the week)
 * - Standby → all days
 * - null (no preference) → Wednesday only (default swap day)
 */
export function getEligibleDays(preference: VolunteerPreference): SwapDay[] {
  switch (preference) {
    case "early":
      return ["monday", "tuesday", "wednesday"];
    case "late":
      return ["wednesday", "thursday", "friday"];
    case "standby":
      return ALL_SWAP_DAYS;
    case null:
      return ["wednesday"];
  }
}

/**
 * Check if a crew member is available for a specific swap day.
 * Wednesday is always available (normal swap day).
 */
export function isCrewAvailableForDay(
  volunteerStatus: VolunteerPreference,
  day: SwapDay,
): boolean {
  if (day === "wednesday") return true; // Wednesday is always the default
  return getEligibleDays(volunteerStatus).includes(day);
}

/**
 * Convert a swap day + anchor Wednesday date to an actual ISO date string.
 * The anchor Wednesday is the standard swap date for the week.
 */
export function dayToDate(day: SwapDay, anchorWednesday: string): string {
  const wed = new Date(anchorWednesday + "T12:00:00Z"); // noon to avoid timezone issues
  const dayOffset = DAY_ORDER[day] - DAY_ORDER.wednesday;
  const target = new Date(wed);
  target.setUTCDate(target.getUTCDate() + dayOffset);
  return target.toISOString().slice(0, 10);
}

/**
 * Sort swap days in chronological order.
 */
export function sortDays(days: SwapDay[]): SwapDay[] {
  return [...days].sort((a, b) => DAY_ORDER[a] - DAY_ORDER[b]);
}

/**
 * Get volunteer badge label for display.
 */
export function getVolunteerBadge(preference: VolunteerPreference): { label: string; color: string } | null {
  switch (preference) {
    case "early":
      return { label: "E", color: "bg-blue-100 text-blue-700" };
    case "late":
      return { label: "L", color: "bg-purple-100 text-purple-700" };
    case "standby":
      return { label: "SB", color: "bg-amber-100 text-amber-700" };
    default:
      return null;
  }
}
