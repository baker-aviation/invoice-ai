import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin, isAuthed } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";
import { buildSwapPlan, assignOncomingCrew, twoPassAssignAndOptimize, solveOffgoingFirst, type CrewMember, type FlightLeg, type AirportAlias, type SwapAssignment, type OncomingPool, type SwapConstraint } from "@/lib/swapOptimizer";
import { DEFAULT_AIRPORT_ALIASES } from "@/lib/airportAliases";
import type { PilotRoute } from "@/lib/pilotRoutes";
import { detectCurrentRotation } from "@/lib/crewRotationDetect";
import { getHasdataCacheForOptimizer } from "@/lib/hasdataCache";
import { loadDriveTimeCache } from "@/lib/driveTime";
import { validatePreOptimization } from "@/lib/swapValidation";

const OptimizeRequestSchema = z.object({
  swap_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  strategy: z.enum(["offgoing_first", "oncoming_first"]).optional(),
  swap_assignments: z.record(z.string(), z.any()).optional(),
  oncoming_pool: z.any().optional(),
  force_auto_detect: z.boolean().optional(),
  lock_tails: z.array(z.string()).optional(),
  locked_rows: z.array(z.any()).optional(),
  required_pairings: z.array(z.object({
    pic: z.string(),
    sic: z.string(),
    reason: z.string(),
  })).optional(),
  constraints: z.array(z.discriminatedUnion("type", [
    z.object({ type: z.literal("force_tail"), crew_name: z.string(), tail: z.string(), day: z.string().optional(), reason: z.string().optional() }),
    z.object({ type: z.literal("force_pair"), crew_a: z.string(), crew_b: z.string(), day: z.string().optional(), reason: z.string().optional() }),
    z.object({ type: z.literal("force_fleet"), crew_name: z.string(), aircraft_type: z.string(), day: z.string().optional(), reason: z.string().optional() }),
  ])).optional(),
  /** Current swap day label (e.g., "tuesday", "wednesday") — used to filter day-specific constraints */
  current_swap_day: z.string().optional(),
}).strip();

export const dynamic = "force-dynamic";
export const maxDuration = 300; // 5 min — DB reads + heavy computation for 30+ tails

/**
 * POST /api/crew/optimize
 * Body: { swap_date: "2026-03-18" }
 *
 * Runs the swap optimizer using pre-computed routes from pilot_routes table.
 * Routes must be computed first via POST /api/crew/routes.
 */
export async function POST(req: NextRequest) {
  // Allow service-role-key auth for CLI testing (temporary)
  const serviceKey = req.headers.get("x-service-key");
  const envKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const isServiceAuth = serviceKey && envKey && serviceKey.trim() === envKey.trim();
  if (!isServiceAuth) {
    console.log("[Optimize] Service key auth:", "invalid");
    const auth = await requireAdmin(req);
    if (!isAuthed(auth)) return auth.error;
  }

  try {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = OptimizeRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: "Validation failed", details: parsed.error.issues }, { status: 400 });
  }

  const swapDate = parsed.data.swap_date;
  const strategy = parsed.data.strategy ?? "oncoming_first";
  const clientSwapAssignments = parsed.data.swap_assignments as Record<string, SwapAssignment> | undefined;
  const clientOncomingPool = parsed.data.oncoming_pool as OncomingPool | undefined;
  const lockTails = parsed.data.lock_tails as string[] | undefined;
  const requiredPairings = parsed.data.required_pairings as { pic: string; sic: string; reason: string }[] | undefined;
  const swapConstraints = parsed.data.constraints as SwapConstraint[] | undefined;
  const lockedRows = parsed.data.locked_rows as unknown[] | undefined;
  const lockTailSet = lockTails ? new Set(lockTails) : null;

  const supa = createServiceClient();

  // Fetch flights around the swap date (±3 days for context)
  const wedDate = new Date(swapDate);
  const start = new Date(wedDate.getTime() - 3 * 24 * 60 * 60 * 1000).toISOString();
  const end = new Date(wedDate.getTime() + 3 * 24 * 60 * 60 * 1000).toISOString();

  const [flightsRes, crewRes, aliasRes, rotationsRes] = await Promise.all([
    supa
      .from("flights")
      .select("id, tail_number, departure_icao, arrival_icao, scheduled_departure, scheduled_arrival, flight_type, pic, sic")
      .gte("scheduled_departure", start)
      .lte("scheduled_departure", end)
      .order("scheduled_departure"),
    supa.from("crew_members").select("*").eq("active", true),
    supa.from("airport_aliases").select("fbo_icao, commercial_icao, preferred"),
    // Fallback: get crew rotations to build swap assignments if not provided by client
    !clientSwapAssignments
      ? supa.from("crew_rotations")
          .select("crew_member_id, tail_number, rotation_start, rotation_end, crew_members(name, role)")
          .order("rotation_start", { ascending: false })
      : Promise.resolve({ data: null, error: null }),
  ]);

  if (flightsRes.error) {
    return NextResponse.json({ error: flightsRes.error.message }, { status: 500 });
  }
  if (crewRes.error) {
    return NextResponse.json({ error: crewRes.error.message }, { status: 500 });
  }

  const flights: FlightLeg[] = (flightsRes.data ?? []).map((f) => ({
    id: f.id as string,
    tail_number: f.tail_number as string,
    departure_icao: f.departure_icao as string,
    arrival_icao: f.arrival_icao as string,
    scheduled_departure: f.scheduled_departure as string,
    scheduled_arrival: f.scheduled_arrival as string | null,
    flight_type: f.flight_type as string | null,
    pic: f.pic as string | null,
    sic: f.sic as string | null,
  }));

  const crewRoster: CrewMember[] = (crewRes.data ?? []).map((c) => ({
    id: c.id as string,
    name: c.name as string,
    jetinsight_name: (c.jetinsight_name as string | null) ?? null,
    role: c.role as "PIC" | "SIC",
    home_airports: (c.home_airports as string[]) ?? [],
    aircraft_types: (c.aircraft_types as string[]) ?? [],
    is_checkairman: (c.is_checkairman as boolean) ?? false,
    checkairman_types: (c.checkairman_types as string[]) ?? [],
    is_skillbridge: (c.is_skillbridge as boolean) ?? false,
    grade: (c.grade as number) ?? 3,
    restrictions: (c.restrictions as Record<string, boolean>) ?? {},
    priority: (c.priority as number) ?? 0,
    rotation_group: (c.rotation_group as "A" | "B" | null) ?? null,
  }));

  // Merge DB aliases with defaults (DB takes precedence)
  const dbAliases: AirportAlias[] = (aliasRes.data ?? []).map((a) => ({
    fbo_icao: a.fbo_icao as string,
    commercial_icao: a.commercial_icao as string,
    preferred: (a.preferred as boolean) ?? false,
  }));
  const dbFboKeys = new Set(dbAliases.map((a) => `${a.fbo_icao}|${a.commercial_icao}`));
  const aliases: AirportAlias[] = [
    ...dbAliases,
    ...DEFAULT_AIRPORT_ALIASES.filter((a) => !dbFboKeys.has(`${a.fbo_icao}|${a.commercial_icao}`)),
  ];

  // Determine swap assignments + oncoming pool from one of three sources:
  // 1. Client-provided (from Excel upload) — highest priority
  // 2. crew_rotations table — manual rotation tracking
  // 3. Auto-detect from JetInsight flights — scan who's flying each tail now
  const forceAutoDetect = parsed.data.force_auto_detect === true;
  let swapAssignments: Record<string, SwapAssignment> = {};
  let autoDetectedPool: OncomingPool | null = null;
  let rotationSource = "none";

  if (clientSwapAssignments && Object.keys(clientSwapAssignments).length > 0) {
    swapAssignments = clientSwapAssignments;
    rotationSource = "excel";
  } else if (!forceAutoDetect && rotationsRes.data && rotationsRes.data.length > 0) {
    // Fallback 1: reconstruct from crew_rotations table
    for (const rot of rotationsRes.data) {
      const tail = rot.tail_number as string;
      const memberArr = rot.crew_members as unknown as { name: string; role: string }[] | { name: string; role: string } | null;
      const member = Array.isArray(memberArr) ? memberArr[0] : memberArr;
      if (!member || !tail) continue;

      if (!swapAssignments[tail]) {
        swapAssignments[tail] = { oncoming_pic: null, oncoming_sic: null, offgoing_pic: null, offgoing_sic: null };
      }
      const sa = swapAssignments[tail];
      const rotEnd = rot.rotation_end as string | null;
      const isPic = member.role === "PIC";

      if (rotEnd) {
        if (isPic) sa.offgoing_pic = sa.offgoing_pic ?? member.name;
        else sa.offgoing_sic = sa.offgoing_sic ?? member.name;
      } else {
        if (isPic) sa.oncoming_pic = sa.oncoming_pic ?? member.name;
        else sa.oncoming_sic = sa.oncoming_sic ?? member.name;
      }
    }
    if (Object.keys(swapAssignments).length > 0) rotationSource = "crew_rotations";
  }

  // Fallback 2: Auto-detect from JetInsight flights
  if (Object.keys(swapAssignments).length === 0) {
    console.log("[Swap Optimizer] No swap assignments from Excel or crew_rotations — auto-detecting from flights");
    const detected = detectCurrentRotation(flights, crewRoster, swapDate);
    swapAssignments = detected.swap_assignments;
    autoDetectedPool = detected.oncoming_pool;
    rotationSource = "auto_detect";
    console.log(`[Swap Optimizer] Auto-detected ${detected.stats.tails_detected} tails, ${detected.stats.offgoing_pic} PICs, ${detected.stats.offgoing_sic} SICs offgoing`);
    if (detected.unmatched_names.length > 0) {
      console.log(`[Swap Optimizer] Unmatched JetInsight names: ${detected.unmatched_names.join(", ")}`);
    }
  }

  // Use client pool, auto-detected pool, or auto-build from roster
  let effectivePool: OncomingPool | null = clientOncomingPool ?? autoDetectedPool;

  // If we have swap assignments but no pool, derive the pool from the roster.
  // Steps:
  //   1. Collect all offgoing names from the assignments.
  //   2. Majority-vote their rotation_group to find the offgoing group.
  //   3. The oncoming group is the opposite (A↔B).
  //   4. Include only crew from the oncoming group who aren't already offgoing.
  // This mirrors what detectCurrentRotation builds, but from Excel-provided data.
  if (!effectivePool && Object.keys(swapAssignments).length > 0) {
    const offgoingNames = new Set<string>();
    for (const sa of Object.values(swapAssignments)) {
      if (sa.offgoing_pic) offgoingNames.add(sa.offgoing_pic);
      if (sa.offgoing_sic) offgoingNames.add(sa.offgoing_sic);
    }

    // Majority-vote the offgoing rotation group
    const groupCounts: Record<string, number> = { A: 0, B: 0 };
    for (const c of crewRoster) {
      if (offgoingNames.has(c.name) && c.rotation_group) groupCounts[c.rotation_group]++;
    }
    const offgoingGroup = groupCounts.A >= groupCounts.B ? (groupCounts.A > 0 ? "A" : null) : "B";
    const oncomingGroup = offgoingGroup === "A" ? "B" : offgoingGroup === "B" ? "A" : null;

    const autoPool: OncomingPool = { pic: [], sic: [] };
    for (const c of crewRoster) {
      if (offgoingNames.has(c.name)) continue;
      // If rotation groups are known, only include the oncoming group
      if (oncomingGroup && c.rotation_group && c.rotation_group !== oncomingGroup) continue;
      const entry = {
        name: c.name,
        aircraft_type: c.aircraft_types[0] ?? "unknown",
        home_airports: c.home_airports,
        is_checkairman: c.is_checkairman,
        is_skillbridge: c.is_skillbridge,
        early_volunteer: false,
        late_volunteer: false,
        standby_volunteer: false,
        notes: null,
      };
      if (c.role === "PIC") autoPool.pic.push(entry);
      else autoPool.sic.push(entry);
    }
    effectivePool = autoPool;
    console.log(`[Swap Optimizer] Auto-built oncoming pool (group ${oncomingGroup ?? "unknown"}): ${autoPool.pic.length} PICs, ${autoPool.sic.length} SICs (excluded ${offgoingNames.size} offgoing, group votes: A=${groupCounts.A} B=${groupCounts.B})`);
  }

  const hasPool = effectivePool && (effectivePool.pic?.length > 0 || effectivePool.sic?.length > 0);

  // ── STEP 0: Pre-optimization validation ──────────────────────────────────
  const validation = validatePreOptimization({
    swapAssignments,
    crewRoster,
    flights,
    swapDate,
  });

  if (!validation.valid) {
    console.log(`[Swap Optimizer] Validation FAILED: ${validation.errors.length} errors, ${validation.warnings.length} warnings`);
    return NextResponse.json({
      ok: false,
      error: "Pre-optimization validation failed",
      validation: {
        errors: validation.errors,
        warnings: validation.warnings,
      },
    }, { status: 422 });
  }

  if (validation.warnings.length > 0) {
    console.log(`[Swap Optimizer] Validation passed with ${validation.warnings.length} warnings`);
  }

  // ── STEP 0.5: Filter locked tails from assignments AND pool ──────────────
  // When lock_tails is provided, we only optimize unlocked tails.
  // Locked tail rows come from the saved plan and are merged back at the end.
  // Critically, we also remove locked tails' oncoming crew from the pool so the
  // optimizer can't double-assign them to unlocked tails.
  if (lockTailSet && lockTailSet.size > 0) {
    // Collect names of crew already assigned in locked rows
    const lockedCrewNames = new Set<string>();
    if (lockedRows) {
      for (const row of lockedRows as { name?: string; direction?: string }[]) {
        if (row.name && row.direction === "oncoming") {
          lockedCrewNames.add(row.name);
        }
      }
    }

    swapAssignments = Object.fromEntries(
      Object.entries(swapAssignments).filter(([tail]) => !lockTailSet.has(tail))
    );

    // Filter oncoming pool to exclude crew locked into saved plan tails
    if (effectivePool && lockedCrewNames.size > 0) {
      effectivePool = {
        pic: effectivePool.pic.filter((p) => !lockedCrewNames.has(p.name)),
        sic: effectivePool.sic.filter((p) => !lockedCrewNames.has(p.name)),
      };
      console.log(`[Swap Optimizer] lock_tails: removed ${lockedCrewNames.size} locked crew from pool (${effectivePool.pic.length} PICs, ${effectivePool.sic.length} SICs remaining)`);
    }

    console.log(`[Swap Optimizer] lock_tails: optimizing ${Object.keys(swapAssignments).length} tails, ${lockTailSet.size} locked`);
  }

  // ── STEP 0.5: Load OSRM drive time cache from Supabase into memory ──
  const dtStart = Date.now();
  const dtCount = await loadDriveTimeCache();
  if (dtCount > 0) {
    console.log(`[Swap Optimizer] Loaded ${dtCount} OSRM drive times in ${Date.now() - dtStart}ms`);
  }

  // ── STEP 1: Load HasData flight cache (Google Flights — sole data source) ──
  const routeStart = Date.now();
  const cached = await getHasdataCacheForOptimizer(swapDate);
  const effectiveFlights = cached.commercialFlights;
  const hasFlightData = effectiveFlights.size > 0;

  if (hasFlightData) {
    console.log(`[Swap Optimizer] Loaded ${cached.totalFlights} HasData flights (${effectiveFlights.size} route keys) in ${Date.now() - routeStart}ms`);
  } else {
    console.log(`[Swap Optimizer] No HasData cache for ${swapDate} — drive-only mode. Seed HasData first.`);
  }

  // Pre-computed route maps (from pilot_routes) are no longer used for flight data.
  // We still load them for crew-specific route scoring if available.
  const crewRouteMap = new Map<string, import("@/lib/pilotRoutes").PilotRoute[]>();
  const crewOffgoingMap = new Map<string, import("@/lib/pilotRoutes").PilotRoute[]>();

  // ── STEP 1.5: Offgoing-first analysis (Phase 5) ────────────────────────
  let offgoingFirstResult = null;
  if (strategy === "offgoing_first" && Object.keys(swapAssignments).length > 0) {
    console.log("[Swap Optimizer] Running offgoing-first analysis...");
    offgoingFirstResult = solveOffgoingFirst({
      flights, crewRoster, aliases, swapDate,
      commercialFlights: hasFlightData ? effectiveFlights : undefined,
      swapAssignments,
    });
    console.log(`[Swap Optimizer] Offgoing-first: ${offgoingFirstResult.deadlines.length} deadlines, ${offgoingFirstResult.unsolvable.length} unsolvable`);
  }

  // Build set of tails with CONFIRMED timing deadlocks — cases where the offgoing crew
  // has a known departure deadline that makes any oncoming arrival impossible.
  // We do NOT exclude tails where offgoing simply has no commercial transport (those tails
  // can still be planned: offgoing will self-arrange, oncoming should still be assigned).
  //
  // Key: match on tail+role (not just tail). In solveOffgoingFirst, each crew member goes
  // to EITHER deadlines OR unsolvable — never both. A tail where PIC is unsolvable (no
  // transport) but SIC has a deadline (has a flight) is NOT a timing deadlock — those are
  // independent crew members. Only exclude when the SAME role on the same tail somehow
  // ends up in both lists (shouldn't happen, but defensive).
  const deadlineTailRoles = offgoingFirstResult
    ? new Set(offgoingFirstResult.deadlines.map((d) => `${d.tail}|${d.role}`))
    : new Set<string>();
  const unsolvableTails = offgoingFirstResult
    ? new Set(
        offgoingFirstResult.unsolvable
          .filter((u) => deadlineTailRoles.has(`${u.tail}|${u.role}`))
          .map((u) => u.tail)
      )
    : undefined;
  if (unsolvableTails?.size) {
    console.log(`[Swap Optimizer] Excluding ${unsolvableTails.size} timing-deadlock tails from oncoming assignment: ${[...unsolvableTails].join(", ")}`);
  }
  const noTransportTails = offgoingFirstResult
    ? offgoingFirstResult.unsolvable.filter((u) => !deadlineTailRoles.has(`${u.tail}|${u.role}`)).map((u) => u.tail)
    : [];
  if (noTransportTails.length) {
    console.log(`[Swap Optimizer] ${noTransportTails.length} tails have no offgoing transport but oncoming will still be assigned: ${noTransportTails.join(", ")}`);
  }

  // ── STEP 2+3: Assign oncoming crew + run transport optimizer ────────────────
  // When strategy is offgoing_first and we have volunteers, use two-pass approach:
  // Pass 1: normal crew only. Pass 2: add early/late volunteers for unsolvable tails.
  let assignmentResult: ReturnType<typeof assignOncomingCrew> | null = null;
  let result: ReturnType<typeof buildSwapPlan>;

  const hasVolunteers = hasPool && effectivePool && (
    effectivePool.pic.some((p) => p.early_volunteer || p.late_volunteer) ||
    effectivePool.sic.some((p) => p.early_volunteer || p.late_volunteer)
  );

  if (hasPool && strategy === "offgoing_first" && hasVolunteers) {
    // ── Two-pass optimizer ──────────────────────────────────────────────
    const twoPassStart = Date.now();
    const twoPass = twoPassAssignAndOptimize({
      swapAssignments,
      oncomingPool: effectivePool!,
      crewRoster,
      flights,
      swapDate,
      aliases,
      commercialFlights: hasFlightData ? effectiveFlights : undefined,
      preComputedRoutes: false ? crewRouteMap : undefined,
      preComputedOffgoing: false ? crewOffgoingMap : undefined,
      excludeTails: unsolvableTails,
      offgoingDeadlines: offgoingFirstResult?.deadlines,
      constraints: swapConstraints,
      currentSwapDay: parsed.data.current_swap_day,
    });
    assignmentResult = twoPass.assignmentResult;
    swapAssignments = twoPass.assignmentResult.assignments;

    // Apply required pairings to two-pass result
    if (requiredPairings && requiredPairings.length > 0) {
      for (const pairing of requiredPairings) {
        const picTail = Object.entries(swapAssignments).find(([, sa]) => sa.oncoming_pic === pairing.pic)?.[0];
        if (!picTail) continue;
        if (swapAssignments[picTail].oncoming_sic === pairing.sic) continue;
        for (const [, sa] of Object.entries(swapAssignments)) {
          if (sa.oncoming_sic === pairing.sic) sa.oncoming_sic = null;
        }
        swapAssignments[picTail].oncoming_sic = pairing.sic;
        console.log(`[Pairing] Forced "${pairing.sic}" onto ${picTail} with "${pairing.pic}" (${pairing.reason})`);
      }
    }

    // Re-run transport plan with updated assignments
    result = buildSwapPlan({
      flights, crewRoster, aliases, swapDate,
      commercialFlights: hasFlightData ? effectiveFlights : undefined,
      swapAssignments: Object.keys(swapAssignments).length > 0 ? swapAssignments : undefined,
      oncomingPool: effectivePool ?? undefined,
      strategy,
    });
    console.log(`[Swap Optimizer] Two-pass took ${((Date.now() - twoPassStart) / 1000).toFixed(1)}s`);
  } else {
    // ── Single-pass (legacy or no volunteers) ───────────────────────────
    if (hasPool) {
      const assignStart = Date.now();
      assignmentResult = assignOncomingCrew({
        swapAssignments,
        oncomingPool: effectivePool!,
        crewRoster,
        flights,
        swapDate,
        aliases,
        commercialFlights: hasFlightData ? effectiveFlights : undefined,
        preComputedRoutes: false ? crewRouteMap : undefined,
        preComputedOffgoing: false ? crewOffgoingMap : undefined,
        excludeTails: unsolvableTails,
        offgoingDeadlines: offgoingFirstResult?.deadlines,
        constraints: swapConstraints,
        currentSwapDay: input.current_swap_day,
      });
      swapAssignments = assignmentResult.assignments;
      console.log(`[Swap Optimizer] Assignment took ${((Date.now() - assignStart) / 1000).toFixed(1)}s`);
    }

    // ── Apply required pairings: force paired SIC onto same tail as paired PIC ──
    if (requiredPairings && requiredPairings.length > 0) {
      for (const pairing of requiredPairings) {
        // Find which tail the PIC was assigned to
        const picTail = Object.entries(swapAssignments).find(([, sa]) => sa.oncoming_pic === pairing.pic)?.[0];
        if (!picTail) {
          console.log(`[Pairing] PIC "${pairing.pic}" not assigned to any tail — skipping pairing with "${pairing.sic}"`);
          continue;
        }

        // Check if the SIC is already on that tail
        const currentSic = swapAssignments[picTail].oncoming_sic;
        if (currentSic === pairing.sic) {
          console.log(`[Pairing] "${pairing.pic}" + "${pairing.sic}" already on ${picTail}`);
          continue;
        }

        // Remove the SIC from wherever they're currently assigned
        for (const [tail, sa] of Object.entries(swapAssignments)) {
          if (sa.oncoming_sic === pairing.sic) {
            sa.oncoming_sic = null;
            console.log(`[Pairing] Removed "${pairing.sic}" from ${tail} SIC`);
          }
        }

        // If the PIC's tail already has a SIC, move that SIC to the pool
        if (currentSic && currentSic !== pairing.sic) {
          console.log(`[Pairing] Displaced "${currentSic}" from ${picTail} SIC (replaced by "${pairing.sic}" for ${pairing.reason})`);
          // The displaced SIC will be re-assigned by the transport plan
          swapAssignments[picTail].oncoming_sic = null;
        }

        // Assign the paired SIC to the PIC's tail
        swapAssignments[picTail].oncoming_sic = pairing.sic;
        console.log(`[Pairing] Forced "${pairing.sic}" onto ${picTail} with "${pairing.pic}" (${pairing.reason})`);
      }
    }

    const transportStart = Date.now();
    result = buildSwapPlan({
      flights,
      crewRoster,
      aliases,
      swapDate,
      commercialFlights: hasFlightData ? effectiveFlights : undefined,
      swapAssignments: Object.keys(swapAssignments).length > 0 ? swapAssignments : undefined,
      oncomingPool: effectivePool ?? undefined,
      strategy,
    });
    console.log(`[Swap Optimizer] Transport plan took ${((Date.now() - transportStart) / 1000).toFixed(1)}s`);
  }

  // ── Merge locked rows back into result ────────────────────────────────────
  if (lockTailSet && lockTailSet.size > 0 && lockedRows && lockedRows.length > 0) {
    const typedLockedRows = lockedRows as typeof result.rows;
    result.rows = [...typedLockedRows, ...result.rows];
    // Recalculate totals
    result.total_cost = result.rows.reduce((s, r) => s + (r.cost_estimate ?? 0), 0);
    const solved = result.rows.filter((r) => r.travel_type !== "none").length;
    result.solved_count = solved;
    result.unsolved_count = result.rows.length - solved;
    // Recompute plan_score as average of row scores
    const scores = result.rows.map((r) => r.score ?? 0);
    result.plan_score = scores.length > 0 ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : 0;
    console.log(`[Swap Optimizer] Merged ${typedLockedRows.length} locked rows + ${result.rows.length - typedLockedRows.length} optimized rows`);
  }

  return NextResponse.json({
    ok: true,
    ...result,
    strategy,
    routes_used: cached.totalFlights,
    flight_cache_used: !false && hasFlightData,
    rotation_source: rotationSource,
    validation: validation.warnings.length > 0 ? { warnings: validation.warnings } : undefined,
    offgoing_first: offgoingFirstResult ? {
      deadlines: offgoingFirstResult.deadlines.map((d) => ({
        ...d,
        deadline: d.deadline.toISOString(),
      })),
      unsolvable: offgoingFirstResult.unsolvable,
    } : undefined,
    crew_assignment: assignmentResult ? {
      standby: assignmentResult.standby,
      details: assignmentResult.details,
    } : undefined,
  });

  } catch (e) {
    console.error("[Swap Optimizer] Unhandled error:", e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Optimization failed" },
      { status: 500 },
    );
  }
}
