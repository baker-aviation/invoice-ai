import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, isAuthed } from "@/lib/api-auth";
import { getSheetData } from "@/lib/googleSheets";
import { createServiceClient } from "@/lib/supabase/service";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FreezeEntry = {
  name: string;
  home_airports: string[];
  role: "PIC" | "SIC";
  tail_number: string | null;
  swap_location: string | null;
  flight_number: string | null;
  date: string | null;
  depart_time: string | null;
  arrival_time: string | null;
  price: number | null;
  notes: string | null;
  volunteer: boolean;
  is_skillbridge: boolean;
};

type ComparisonResult = {
  tail_number: string;
  role: "PIC" | "SIC";
  freeze_crew: string;
  optimizer_crew: string | null;
  match: boolean;
  differences: string[];
};

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

/** Strip emoji prefixes (aircraft type colors, etc.) and trim */
function stripEmoji(s: string): string {
  // Remove common emoji chars and variation selectors
  return s.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}\u{200D}\u{20E3}]/gu, "").trim();
}

/** Parse "Name (SAV)" or "Name (SAV/JAX)" → { name, airports } */
function parseNameColumn(raw: string): { name: string; airports: string[] } {
  const cleaned = stripEmoji(raw).trim();
  const match = cleaned.match(/^(.+?)\s*\(([^)]+)\)\s*$/);
  if (!match) return { name: cleaned, airports: [] };
  const name = match[1].trim();
  const airports = match[2].split("/").map(a => a.trim().toUpperCase()).filter(Boolean);
  return { name, airports };
}

/** Parse time string — strip trailing "L" */
function parseTime(raw: unknown): string | null {
  if (raw == null || raw === "") return null;
  const s = String(raw).trim();
  return s.replace(/L$/i, "") || null;
}

/** Parse price — strip "$" and "," */
function parsePrice(raw: unknown): number | null {
  if (raw == null || raw === "") return null;
  const s = String(raw).replace(/[$,]/g, "").trim();
  const n = parseFloat(s);
  return isNaN(n) ? null : n;
}

/** Detect if a row is a section header (PIC / SIC divider) */
function detectRole(row: unknown[]): "PIC" | "SIC" | null {
  const joined = row.map(c => String(c ?? "").toUpperCase()).join(" ");
  if (/PILOT\s+IN\s+COMMAND|^PIC$/i.test(joined)) return "PIC";
  if (/SECOND\s+IN.COMMAND|^SIC$/i.test(joined)) return "SIC";
  return null;
}

// ---------------------------------------------------------------------------
// Core parser
// ---------------------------------------------------------------------------

function parseFreezeTab(rows: unknown[][]): FreezeEntry[] {
  const entries: FreezeEntry[] = [];
  let currentRole: "PIC" | "SIC" = "PIC"; // default until we see a header

  for (const row of rows) {
    // Check for section headers
    const roleHeader = detectRole(row);
    if (roleHeader) {
      currentRole = roleHeader;
      continue;
    }

    // Column C (index 2) must have a name to be a data row
    const nameRaw = row[2];
    if (!nameRaw || String(nameRaw).trim() === "") continue;

    const nameStr = String(nameRaw);
    // Skip obvious header/label rows
    if (/^name|^crew|^pilot/i.test(stripEmoji(nameStr))) continue;

    const { name, airports } = parseNameColumn(nameStr);
    if (!name) continue;

    // Column A: emoji indicators — check for skillbridge
    const colA = String(row[0] ?? "").toLowerCase();
    const isSkillbridge = colA.includes("sb") || colA.includes("skill") || /\u{1F3D7}/u.test(colA);

    // Column B: volunteer flag
    const colB = String(row[1] ?? "").trim();
    const volunteer = colB === "TRUE" || colB === "1" || colB.toLowerCase() === "yes" || colB === "✓" || colB === "✅";

    const entry: FreezeEntry = {
      name,
      home_airports: airports,
      role: currentRole,
      tail_number: row[4] != null && String(row[4]).trim() !== "" ? String(row[4]).trim() : null,
      swap_location: row[3] != null && String(row[3]).trim() !== "" ? String(row[3]).trim().toUpperCase() : null,
      flight_number: row[5] != null && String(row[5]).trim() !== "" ? String(row[5]).trim() : null,
      date: row[6] != null && String(row[6]).trim() !== "" ? String(row[6]).trim() : null,
      depart_time: parseTime(row[7]),
      arrival_time: parseTime(row[8]),
      price: parsePrice(row[9]),
      notes: row[10] != null && String(row[10]).trim() !== "" ? String(row[10]).trim() : null,
      volunteer,
      is_skillbridge: isSkillbridge,
    };

    entries.push(entry);
  }

  return entries;
}

// ---------------------------------------------------------------------------
// Comparison logic
// ---------------------------------------------------------------------------

function compareFreezeToPlan(
  freezeEntries: FreezeEntry[],
  planData: Record<string, unknown>,
): ComparisonResult[] {
  const results: ComparisonResult[] = [];

  // Extract swap_assignments from plan_data — keyed by tail number
  const swapAssignments = (planData.swap_assignments ?? planData.assignments ?? {}) as Record<
    string,
    { oncoming_pic?: string | null; oncoming_sic?: string | null }
  >;

  for (const entry of freezeEntries) {
    if (!entry.tail_number) continue;

    const tail = entry.tail_number;
    const assignment = swapAssignments[tail];
    const optimizerCrew =
      entry.role === "PIC"
        ? (assignment?.oncoming_pic ?? null)
        : (assignment?.oncoming_sic ?? null);

    const differences: string[] = [];

    if (!assignment) {
      differences.push(`Tail ${tail} missing from optimizer plan`);
    } else if (!optimizerCrew) {
      differences.push(`No ${entry.role} assigned in optimizer for ${tail}`);
    } else {
      // Normalize names for comparison (case-insensitive, trim)
      const freezeName = entry.name.toLowerCase().trim();
      const optName = optimizerCrew.toLowerCase().trim();
      if (freezeName !== optName) {
        differences.push(`Crew mismatch: FREEZE="${entry.name}" vs optimizer="${optimizerCrew}"`);
      }
    }

    results.push({
      tail_number: tail,
      role: entry.role,
      freeze_crew: entry.name,
      optimizer_crew: optimizerCrew,
      match: differences.length === 0,
      differences,
    });
  }

  // Check for tails in optimizer but missing from freeze
  const freezeTailRoles = new Set(
    freezeEntries
      .filter(e => e.tail_number)
      .map(e => `${e.tail_number}:${e.role}`),
  );

  for (const [tail, assignment] of Object.entries(swapAssignments)) {
    const a = assignment as { oncoming_pic?: string | null; oncoming_sic?: string | null };
    for (const role of ["PIC", "SIC"] as const) {
      const crew = role === "PIC" ? a.oncoming_pic : a.oncoming_sic;
      if (crew && !freezeTailRoles.has(`${tail}:${role}`)) {
        results.push({
          tail_number: tail,
          role,
          freeze_crew: "(missing from FREEZE)",
          optimizer_crew: crew,
          match: false,
          differences: [`${role} for ${tail} in optimizer but not in FREEZE tab`],
        });
      }
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

/**
 * GET /api/crew/freeze?tab=FREEZE APR 1-APR 8 (B)
 * Optional: &compare=true&swap_date=2026-04-01
 *
 * Parses the FREEZE tab from Google Sheets and optionally compares
 * against the active swap plan in Supabase.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (!isAuthed(auth)) return auth.error;

  const tab = req.nextUrl.searchParams.get("tab");
  if (!tab) {
    return NextResponse.json({ error: "tab query param required (e.g., tab=FREEZE APR 1-APR 8 (B))" }, { status: 400 });
  }

  try {
    // Fetch and parse freeze sheet
    const rows = await getSheetData(tab);
    const entries = parseFreezeTab(rows);

    const compare = req.nextUrl.searchParams.get("compare") === "true";
    const swapDate = req.nextUrl.searchParams.get("swap_date");

    // If compare requested, load active plan from Supabase
    let comparison: ComparisonResult[] | null = null;
    let planMeta: { id: string; version: number; swap_date: string } | null = null;

    if (compare && swapDate) {
      const supa = createServiceClient();
      const { data: plan } = await supa
        .from("swap_plans")
        .select("id, version, swap_date, plan_data, swap_assignments")
        .eq("swap_date", swapDate)
        .eq("status", "active")
        .maybeSingle();

      if (plan) {
        planMeta = { id: plan.id as string, version: plan.version as number, swap_date: plan.swap_date as string };

        // plan_data contains the full optimizer output; swap_assignments is the keyed record
        const assignments =
          (plan.swap_assignments as Record<string, unknown>) ??
          (plan.plan_data as Record<string, unknown>) ??
          {};

        // Wrap so comparison can find swap_assignments at top level
        const planObj = plan.swap_assignments
          ? { swap_assignments: assignments }
          : (plan.plan_data as Record<string, unknown>) ?? {};

        comparison = compareFreezeToPlan(entries, planObj);
      }
    }

    const stats = {
      total: entries.length,
      pic_count: entries.filter(e => e.role === "PIC").length,
      sic_count: entries.filter(e => e.role === "SIC").length,
      with_flights: entries.filter(e => e.flight_number).length,
      total_cost: entries.reduce((sum, e) => sum + (e.price ?? 0), 0),
    };

    const response: Record<string, unknown> = {
      tab,
      entries,
      stats,
    };

    if (comparison) {
      const matched = comparison.filter(c => c.match).length;
      const mismatched = comparison.filter(c => !c.match).length;
      response.comparison = {
        plan: planMeta,
        results: comparison,
        summary: { matched, mismatched, total: comparison.length },
      };
    } else if (compare && swapDate) {
      response.comparison = {
        plan: null,
        results: [],
        summary: { matched: 0, mismatched: 0, total: 0, note: "No active plan found for this swap_date" },
      };
    }

    return NextResponse.json(response);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed to parse freeze tab" },
      { status: 500 },
    );
  }
}
