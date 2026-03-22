import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, isAuthed } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";
import {
  parseCrewInfo,
  type CrewRosterEntry,
  type WeeklySwapEntry,
  type BadPairing,
  type CheckairmanEntry,
  type TrainingEntry,
  type Recurrency299Entry,
  type PicSwapEntry,
  type CrewingChecklist,
  type CalendarWeek,
} from "@/lib/crewInfoParser";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * POST /api/crew/roster/sync
 *
 * Upload the master CREW INFO Excel workbook. Parses:
 *   1. CREW ROSTER → upserts all crew_members (name, home, rotation, type, rank, SB, terminated)
 *   2. Slack names → fuzzy matches and stores slack_display_name
 *   3. Weekly swap sheet → extracts swap assignments + oncoming pool
 *   4. Different airports → crew temporarily at non-home locations
 *
 * Body: multipart/form-data with:
 *   - file: the .xlsx file
 *   - swap_date: (optional) YYYY-MM-DD to target a specific weekly sheet
 *   - slack_names: (optional) JSON array of Slack display names
 */
export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (!isAuthed(auth)) return auth.error;

  const formData = await req.formData();
  const file = formData.get("file") as File | null;
  if (!file) return NextResponse.json({ error: "No file uploaded" }, { status: 400 });

  const swapDate = formData.get("swap_date") as string | null;
  const slackNamesRaw = formData.get("slack_names") as string | null;
  let slackNames: string[] | undefined;
  if (slackNamesRaw) {
    try {
      slackNames = JSON.parse(slackNamesRaw);
    } catch {
      return NextResponse.json({ error: "slack_names must be valid JSON array" }, { status: 400 });
    }
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  const result = parseCrewInfo(buffer, slackNames, swapDate ?? undefined);

  const supa = createServiceClient();
  const syncErrors: string[] = [...result.errors];

  // ═══ 1. Upsert crew_members from CREW ROSTER ═════════════════════════════

  let upsertedCount = 0;
  let deactivatedCount = 0;
  let slackMatchedCount = 0;

  // Clean slate: delete all existing crew_members, then insert fresh from Excel.
  // The Excel is the sole source of truth — no merge, no duplicates.
  await supa.from("crew_members").delete().neq("id", "00000000-0000-0000-0000-000000000000"); // delete all rows
  console.log("[Roster Sync] Cleared crew_members table — inserting fresh from Excel");

  // JetInsight legal name mappings — these differ from roster display names.
  // Stored on crew_members so auto-detect rotation can match flight PIC/SIC fields.
  const JETINSIGHT_NAMES: Record<string, string> = {
    "Wilder Ponte": "Wilder Ponte-Vela",
    "Jesus Olmos": "Jesus Enrique Olmos Arias",
    "Robert Lankford": "Robert Donald Lankford Jr",
    "Hamilton Heatly": "Lawrence Heatly",
    "Eddie Goble": "Edward Goble II",
    "Dave Hill": "Ronald David Hill Jr",
    "Luis Maestre": "Luis Maestre Giron",
  };

  // No existing map needed — everything is new
  const existingMap = new Map<string, { id: string; slack_display_name: string | null }>();

  // Track which names are in the new roster (to deactivate removed ones)
  const rosterKeys = new Set<string>();

  for (const entry of result.roster) {
    const key = `${entry.name}|${entry.role}`;
    rosterKeys.add(key);

    const record: Record<string, unknown> = {
      name: entry.name,
      role: entry.role,
      home_airports: entry.home_airports,
      aircraft_types: [entry.aircraft_type],
      rotation_group: entry.rotation === "part_time" ? null : entry.rotation,
      is_skillbridge: entry.is_skillbridge,
      is_checkairman: false, // will be updated from weekly sheet if available
      active: !entry.is_terminated,
      updated_at: new Date().toISOString(),
    };

    // Store Slack display name if matched
    if (entry.slack_display_name) {
      record.slack_display_name = entry.slack_display_name;
      slackMatchedCount++;
    }

    // Store JetInsight legal name if different from display name
    if (JETINSIGHT_NAMES[entry.name]) {
      record.jetinsight_name = JETINSIGHT_NAMES[entry.name];
    }

    // Add notes for SkillBridge end date and termination
    const notesParts: string[] = [];
    if (entry.skillbridge_end) notesParts.push(`SB ends ${entry.skillbridge_end}`);
    if (entry.terminated_on) notesParts.push(`Terminated ${entry.terminated_on}`);
    if (entry.rotation === "part_time") notesParts.push("Part-time / Non-standard rotation");
    if (notesParts.length > 0) record.notes = notesParts.join("; ");

    try {
      const existing = existingMap.get(key);
      if (existing) {
        // Don't overwrite existing slack_display_name if we didn't get a new one
        if (!entry.slack_display_name && existing.slack_display_name) {
          delete record.slack_display_name;
        }
        await supa.from("crew_members").update(record).eq("id", existing.id);
      } else {
        await supa.from("crew_members").insert(record);
      }
      upsertedCount++;
    } catch (e) {
      syncErrors.push(`${entry.name}: ${e instanceof Error ? e.message : "upsert failed"}`);
    }
  }

  // No deactivation needed — we wiped and re-inserted from Excel.
  // Terminated crew are already marked active: false in the insert above.
  {
  }

  // ═══ 2. Update checkairman flags from weekly sheet + checkairmen table ════

  // Build a lookup from the parsed checkairmen data for aircraft type capabilities
  const checkairmanTypeMap = new Map<string, { citation_x: boolean; challenger: boolean }>();
  for (const ca of result.checkairmen) {
    const existing = checkairmanTypeMap.get(ca.name);
    if (existing) {
      // Merge — a checkairman can appear in multiple rotation columns
      if (ca.citation_x) existing.citation_x = true;
      if (ca.challenger) existing.challenger = true;
    } else {
      checkairmanTypeMap.set(ca.name, { citation_x: ca.citation_x, challenger: ca.challenger });
    }
  }

  if (result.weekly_swap) {
    for (const entry of result.weekly_swap) {
      if (entry.is_checkairman) {
        const key = `${entry.name}|${entry.role}`;
        const existing = existingMap.get(key);
        if (existing) {
          const types = checkairmanTypeMap.get(entry.name);
          const checkairmanTypes: string[] = [];
          if (types?.citation_x) checkairmanTypes.push("citation_x");
          if (types?.challenger) checkairmanTypes.push("challenger");

          const updatePayload: Record<string, unknown> = { is_checkairman: true };
          if (checkairmanTypes.length > 0) {
            updatePayload.checkairman_types = checkairmanTypes;
          }
          await supa.from("crew_members").update(updatePayload).eq("id", existing.id);
        }
      }
    }
  }

  // ═══ 3. Build swap assignments from weekly sheet ══════════════════════════

  type SwapAssignment = {
    oncoming_pic: string | null;
    oncoming_sic: string | null;
    offgoing_pic: string | null;
    offgoing_sic: string | null;
  };

  const swapByTail = new Map<string, SwapAssignment>();
  type PoolEntry = {
    name: string;
    aircraft_type: string;
    home_airports: string[];
    is_checkairman: boolean;
    is_skillbridge: boolean;
    early_volunteer: boolean;
    late_volunteer: boolean;
    standby_volunteer: boolean;
    notes: string | null;
  };
  const oncomingPool: { pic: PoolEntry[]; sic: PoolEntry[] } = { pic: [], sic: [] };
  const standbyPool: { pic: PoolEntry[]; sic: PoolEntry[] } = { pic: [], sic: [] };

  if (result.weekly_swap) {
    // Build offgoing assignments (they have tail numbers)
    for (const e of result.weekly_swap.filter((e) => e.direction === "offgoing" && e.tail_number)) {
      const tail = e.tail_number!;
      if (!swapByTail.has(tail)) {
        swapByTail.set(tail, { oncoming_pic: null, oncoming_sic: null, offgoing_pic: null, offgoing_sic: null });
      }
      const sa = swapByTail.get(tail)!;
      if (e.role === "PIC") sa.offgoing_pic = e.name;
      else sa.offgoing_sic = e.name;
    }

    // Oncoming with tails (including "Staying on")
    for (const e of result.weekly_swap.filter((e) => e.direction === "oncoming" && e.tail_number)) {
      const tail = e.tail_number!;
      if (!swapByTail.has(tail)) {
        swapByTail.set(tail, { oncoming_pic: null, oncoming_sic: null, offgoing_pic: null, offgoing_sic: null });
      }
      const sa = swapByTail.get(tail)!;
      if (e.role === "PIC") sa.oncoming_pic = e.name;
      else sa.oncoming_sic = e.name;
    }

    // Oncoming without tails → pool or standby
    const assignedOncoming = new Set<string>();
    for (const [, sa] of swapByTail) {
      if (sa.oncoming_pic) assignedOncoming.add(sa.oncoming_pic);
      if (sa.oncoming_sic) assignedOncoming.add(sa.oncoming_sic);
    }

    for (const e of result.weekly_swap.filter((e) => e.direction === "oncoming" && !e.tail_number)) {
      if (assignedOncoming.has(e.name)) continue;

      const poolEntry: PoolEntry = {
        name: e.name,
        aircraft_type: e.aircraft_type,
        home_airports: e.home_airports,
        is_checkairman: e.is_checkairman,
        is_skillbridge: e.is_skillbridge,
        early_volunteer: e.volunteer === "early",
        late_volunteer: e.volunteer === "late",
        standby_volunteer: e.volunteer === "standby",
        notes: e.notes,
      };

      // Check if this person is on standby (notes mention STANDBY)
      const isStandby = e.notes?.toUpperCase().includes("STANDBY") || e.volunteer === "standby";

      if (isStandby) {
        if (e.role === "PIC") standbyPool.pic.push(poolEntry);
        else standbyPool.sic.push(poolEntry);
      } else {
        if (e.role === "PIC") oncomingPool.pic.push(poolEntry);
        else oncomingPool.sic.push(poolEntry);
      }
    }
  }

  // Convert swap assignments to plain object
  const swapAssignments: Record<string, SwapAssignment> = {};
  for (const [tail, sa] of swapByTail) {
    swapAssignments[tail] = sa;
  }

  // Determine rotation groups
  const oncomingNames = result.weekly_swap
    ?.filter((e) => e.direction === "oncoming")
    .map((e) => e.name) ?? [];
  const offgoingNames = result.weekly_swap
    ?.filter((e) => e.direction === "offgoing")
    .map((e) => e.name) ?? [];

  // Infer rotation from the sheet name (e.g., "MAR 18-MAR 25 (B)" → offgoing is B)
  let offgoingGroup: "A" | "B" = "B";
  let oncomingGroup: "A" | "B" = "A";
  if (result.weekly_sheet_name) {
    const rotMatch = result.weekly_sheet_name.match(/\(([AB])\)/);
    if (rotMatch) {
      // The sheet is named after the OFFGOING rotation (the crew leaving)
      offgoingGroup = rotMatch[1] as "A" | "B";
      oncomingGroup = offgoingGroup === "A" ? "B" : "A";
    }
  }

  // ═══ 4. Different airports summary ════════════════════════════════════════

  // Filter to entries relevant to the swap date (if provided)
  let relevantDiffAirports = result.different_airports;
  if (swapDate) {
    relevantDiffAirports = result.different_airports.filter((d) => {
      if (!d.date) return true; // undated entries always relevant
      return d.date === swapDate;
    });
  }

  // ═══ 5. Find target week from calendar_weeks ════════════════════════════

  let targetWeekCrew: CalendarWeek | null = null;
  if (result.calendar_weeks.length > 0) {
    // Try to match the swap_date to a calendar week's date range
    if (swapDate) {
      const targetTs = new Date(swapDate + "T12:00:00Z").getTime();

      for (const week of result.calendar_weeks) {
        // date_range looks like "March 18, 2026 - March 25, 2026"
        const rangeParts = week.date_range.split(/\s*-\s*/);
        if (rangeParts.length !== 2) continue;
        const startTs = new Date(rangeParts[0].trim() + " 00:00:00 UTC").getTime();
        const endTs = new Date(rangeParts[1].trim() + " 23:59:59 UTC").getTime();
        if (isNaN(startTs) || isNaN(endTs)) continue;
        if (targetTs >= startTs && targetTs <= endTs) {
          targetWeekCrew = week;
          break;
        }
      }
    }

    // Fallback: find the next upcoming week (first week whose start >= today)
    if (!targetWeekCrew) {
      const now = Date.now();
      for (const week of result.calendar_weeks) {
        const rangeParts = week.date_range.split(/\s*-\s*/);
        if (rangeParts.length !== 2) continue;
        const startTs = new Date(rangeParts[0].trim() + " 00:00:00 UTC").getTime();
        if (isNaN(startTs)) continue;
        if (startTs >= now) {
          targetWeekCrew = week;
          break;
        }
      }
      // If all weeks are in the past, use the last one
      if (!targetWeekCrew) {
        targetWeekCrew = result.calendar_weeks[result.calendar_weeks.length - 1];
      }
    }
  }

  // ═══ Response ═════════════════════════════════════════════════════════════

  return NextResponse.json({
    ok: true,
    roster: {
      total: result.roster.length,
      active: result.roster.filter((r) => !r.is_terminated).length,
      terminated: result.roster.filter((r) => r.is_terminated).length,
      skillbridge: result.roster.filter((r) => r.is_skillbridge).length,
      part_time: result.roster.filter((r) => r.rotation === "part_time").length,
      upserted: upsertedCount,
      deactivated: deactivatedCount,
    },
    slack: {
      provided: slackNames?.length ?? 0,
      matched: slackMatchedCount,
      unmatched: (slackNames?.length ?? 0) - slackMatchedCount,
    },
    rotation: {
      oncoming_group: oncomingGroup,
      offgoing_group: offgoingGroup,
      counts: result.rotation_counts,
    },
    weekly_sheet: result.weekly_sheet_name,
    swap_assignments: swapAssignments,
    oncoming_pool: oncomingPool,
    standby_pool: standbyPool,
    different_airports: relevantDiffAirports,
    bad_pairings: result.bad_pairings,
    checkairmen: result.checkairmen,
    training_needed: result.training_needed,
    recurrency_299: result.recurrency_299,
    pic_swap_table: result.pic_swap_table,
    crewing_checklist: result.crewing_checklist,
    calendar_weeks: result.calendar_weeks,
    target_week_crew: targetWeekCrew,
    errors: syncErrors.length > 0 ? syncErrors : undefined,
  });
}
