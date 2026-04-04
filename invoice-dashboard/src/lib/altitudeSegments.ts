/**
 * Altitude segment extraction from ADS-B track data.
 *
 * Analyzes raw position data to identify:
 * - Time at each cruise flight level
 * - Step climbs (when and how long between levels)
 * - Level-offs during climb (ATC holds)
 * - Time at optimal vs sub-optimal altitude
 */

const OPTIMAL_ALT: Record<string, number> = { "CE-750": 470, "CL-30": 450 };
const ALT_PENALTY_PER_10FL = 0.04; // lbs/NM per 10 FL below optimal

export interface AltSegment {
  altitudeFl: number;
  startMin: number;
  endMin: number;
  durationMin: number;
  phase: "climb" | "cruise" | "descent" | "level-off";
  altDeltaFromOptimal: number; // negative = below optimal
  fuelPenaltyLbs: number;
  pilotChoice: boolean; // true if above FL410
}

export interface SegmentsSummary {
  segments: AltSegment[];
  timeToFirstCruise: number | null;
  initialCruiseAlt: number | null;
  maxCruiseAlt: number | null;
  stepClimbCount: number;
  totalCruiseMin: number;
  timeAtOptimalMin: number;
  timeAtOptimalPct: number;
  timeBelowOptimalMin: number;
  totalSubOptimalPenaltyLbs: number;
  levelOffs: Array<{ altitudeFl: number; durationMin: number }>;
}

interface Position {
  minutesFromDep: number;
  altitudeFl: number;
}

/**
 * Smooth altitude data with a 3-point median filter to remove GPS noise
 */
function smoothAltitudes(positions: Position[]): Position[] {
  if (positions.length < 3) return positions;
  const result: Position[] = [positions[0]];
  for (let i = 1; i < positions.length - 1; i++) {
    const vals = [positions[i - 1].altitudeFl, positions[i].altitudeFl, positions[i + 1].altitudeFl].sort((a, b) => a - b);
    result.push({ minutesFromDep: positions[i].minutesFromDep, altitudeFl: vals[1] });
  }
  result.push(positions[positions.length - 1]);
  return result;
}

/**
 * Extract altitude segments from ADS-B track positions.
 */
export function extractAltitudeSegments(
  rawPositions: Position[],
  aircraftType: string,
  routeNm: number,
): SegmentsSummary | null {
  if (rawPositions.length < 5) return null;

  const positions = smoothAltitudes(rawPositions);
  const optimal = OPTIMAL_ALT[aircraftType] ?? 470;
  const totalFlightMin = positions[positions.length - 1].minutesFromDep;

  // Find max altitude
  const maxAlt = Math.max(...positions.map((p) => p.altitudeFl));
  if (maxAlt < 50) return null; // ground-only track

  // Detect level segments: consecutive stretches within ±5 FL for ≥1 minute
  const segments: AltSegment[] = [];
  let segStart = 0;
  let segAlt = Math.round(positions[0].altitudeFl / 10) * 10; // round to nearest 10 FL

  for (let i = 1; i < positions.length; i++) {
    const roundedAlt = Math.round(positions[i].altitudeFl / 10) * 10;
    const altDiff = Math.abs(roundedAlt - segAlt);

    if (altDiff >= 10 || i === positions.length - 1) {
      // End current segment
      const startMin = positions[segStart].minutesFromDep;
      const endMin = positions[i === positions.length - 1 && altDiff < 10 ? i : i - 1].minutesFromDep;
      const durationMin = Math.round((endMin - startMin) * 10) / 10;

      if (durationMin >= 1) { // only keep segments ≥1 minute
        const altDelta = segAlt - optimal;
        const penaltyPerNm = altDelta < 0 ? (Math.abs(altDelta) / 10) * ALT_PENALTY_PER_10FL : 0;
        // Prorate penalty by fraction of total flight this segment represents
        const timeFraction = durationMin / (totalFlightMin || 1);
        const fuelPenalty = Math.round(penaltyPerNm * routeNm * timeFraction);

        segments.push({
          altitudeFl: segAlt,
          startMin: Math.round(startMin * 10) / 10,
          endMin: Math.round(endMin * 10) / 10,
          durationMin,
          phase: "cruise", // will classify below
          altDeltaFromOptimal: altDelta,
          fuelPenaltyLbs: fuelPenalty,
          pilotChoice: segAlt >= 410,
        });
      }

      segStart = i;
      segAlt = roundedAlt;
    }
  }

  if (segments.length === 0) return null;

  // Classify phases: climb → cruise → descent
  // Find TOC: first segment at ≥80% of max altitude lasting ≥3 min
  const cruiseThreshold = maxAlt * 0.8;
  let tocSegIdx = segments.findIndex((s) => s.altitudeFl >= cruiseThreshold && s.durationMin >= 3);
  if (tocSegIdx < 0) tocSegIdx = segments.findIndex((s) => s.altitudeFl >= cruiseThreshold);
  if (tocSegIdx < 0) tocSegIdx = 0;

  // Find TOD: last segment at ≥80% of max altitude lasting ≥3 min
  let todSegIdx = segments.length - 1;
  for (let i = segments.length - 1; i >= tocSegIdx; i--) {
    if (segments[i].altitudeFl >= cruiseThreshold && segments[i].durationMin >= 3) {
      todSegIdx = i;
      break;
    }
  }

  // Classify
  const levelOffs: Array<{ altitudeFl: number; durationMin: number }> = [];
  for (let i = 0; i < segments.length; i++) {
    if (i < tocSegIdx) {
      segments[i].phase = "climb";
      // Check for level-offs during climb (held altitude for 2+ min)
      if (segments[i].durationMin >= 2) {
        segments[i].phase = "level-off";
        levelOffs.push({ altitudeFl: segments[i].altitudeFl, durationMin: segments[i].durationMin });
      }
    } else if (i > todSegIdx) {
      segments[i].phase = "descent";
    } else {
      segments[i].phase = "cruise";
    }
  }

  // Compute summary
  const cruiseSegments = segments.filter((s) => s.phase === "cruise");
  const totalCruiseMin = cruiseSegments.reduce((s, seg) => s + seg.durationMin, 0);
  const timeAtOptimalMin = cruiseSegments
    .filter((s) => Math.abs(s.altDeltaFromOptimal) <= 10) // within 10 FL of optimal
    .reduce((s, seg) => s + seg.durationMin, 0);
  const timeBelowOptimalMin = cruiseSegments
    .filter((s) => s.altDeltaFromOptimal < -10)
    .reduce((s, seg) => s + seg.durationMin, 0);
  const totalSubOptimalPenaltyLbs = cruiseSegments
    .reduce((s, seg) => s + seg.fuelPenaltyLbs, 0);

  // Count step climbs: altitude increases between consecutive cruise segments
  let stepClimbCount = 0;
  for (let i = 1; i < cruiseSegments.length; i++) {
    if (cruiseSegments[i].altitudeFl > cruiseSegments[i - 1].altitudeFl) {
      stepClimbCount++;
    }
  }

  const initialCruise = cruiseSegments.length > 0 ? cruiseSegments[0] : null;
  const maxCruise = cruiseSegments.length > 0 ? Math.max(...cruiseSegments.map((s) => s.altitudeFl)) : null;

  return {
    segments,
    timeToFirstCruise: initialCruise ? Math.round(initialCruise.startMin * 10) / 10 : null,
    initialCruiseAlt: initialCruise?.altitudeFl ?? null,
    maxCruiseAlt: maxCruise,
    stepClimbCount,
    totalCruiseMin: Math.round(totalCruiseMin * 10) / 10,
    timeAtOptimalMin: Math.round(timeAtOptimalMin * 10) / 10,
    timeAtOptimalPct: totalCruiseMin > 0 ? Math.round((timeAtOptimalMin / totalCruiseMin) * 1000) / 10 : 0,
    timeBelowOptimalMin: Math.round(timeBelowOptimalMin * 10) / 10,
    totalSubOptimalPenaltyLbs: Math.round(totalSubOptimalPenaltyLbs),
    levelOffs,
  };
}
