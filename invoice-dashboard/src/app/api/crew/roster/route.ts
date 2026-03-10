import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, isAuthed } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";
import * as XLSX from "xlsx";

export const dynamic = "force-dynamic";

// ─── Emoji → aircraft type mapping ──────────────────────────────────────────

const EMOJI_TYPE: Record<string, string> = {
  "🟢": "citation_x",
  "🟡": "challenger",
  "🟣": "dual",
};

// ─── Parse crew name cell: "🟢 Wesley Williamson (IAH/HOU)   ✔" ────────────

type ParsedCrew = {
  name: string;
  homeAirports: string[];
  aircraftType: string;
  isCheckairman: boolean;
};

function parseCrewCell(raw: string): ParsedCrew | null {
  if (!raw || typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // Detect aircraft type from emoji
  let aircraftType = "unknown";
  for (const [emoji, type] of Object.entries(EMOJI_TYPE)) {
    if (trimmed.includes(emoji)) {
      aircraftType = type;
      break;
    }
  }

  // Detect checkairman (✔ or ✓)
  const isCheckairman = /[✔✓]/.test(trimmed);

  // Extract name and home airports: "Wesley Williamson (IAH/HOU)"
  // Strip emoji prefix and checkmark suffix
  const cleaned = trimmed
    .replace(/^[🟢🟡🟣\s]+/, "")
    .replace(/[✔✓\s]+$/, "")
    .trim();

  const match = cleaned.match(/^(.+?)\s*\(([^)]+)\)\s*$/);
  if (!match) return null;

  const name = match[1].trim();
  const airportStr = match[2].trim();
  // Split on / and normalize: "IAH/HOU" → ["IAH", "HOU"]
  const homeAirports = airportStr
    .split("/")
    .map((a) => a.trim().toUpperCase())
    .filter((a) => a.length >= 2 && a.length <= 4);

  if (!name || homeAirports.length === 0) return null;

  return { name, homeAirports, aircraftType, isCheckairman };
}

// ─── Parse volunteer column ─────────────────────────────────────────────────

type VolunteerFlags = {
  isEarly: boolean;
  isLate: boolean;
  isStandby: boolean;
};

function parseVolunteer(val: unknown): VolunteerFlags {
  const s = String(val ?? "").trim().toUpperCase();
  return {
    isEarly: s === "E",
    isLate: s === "L",
    isStandby: s === "SB",
  };
}

// ─── GET: list current crew roster ──────────────────────────────────────────

export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (!isAuthed(auth)) return auth.error;

  const supa = createServiceClient();
  const { data, error } = await supa
    .from("crew_members")
    .select("*")
    .eq("active", true)
    .order("role")
    .order("name");

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ crew: data, count: data.length });
}

// ─── POST: upload Excel roster ──────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (!isAuthed(auth)) return auth.error;

  const formData = await req.formData();
  const file = formData.get("file") as File | null;
  if (!file) return NextResponse.json({ error: "No file uploaded" }, { status: 400 });

  const buffer = Buffer.from(await file.arrayBuffer());
  const wb = XLSX.read(buffer, { type: "buffer" });

  // Use first sheet
  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws) return NextResponse.json({ error: "Empty workbook" }, { status: 400 });

  const rows = XLSX.utils.sheet_to_json(ws, { header: 1 }) as unknown as unknown[][];

  // Parse sections: find section headers
  type Section = "oncoming_pic" | "oncoming_sic" | "offgoing_pic" | "offgoing_sic";
  type CrewEntry = ParsedCrew & {
    role: "PIC" | "SIC";
    section: Section;
    isSkillbridge: boolean;
    volunteer: VolunteerFlags;
    aircraft: string | null;
    notes: string | null;
  };

  const entries: CrewEntry[] = [];
  let currentSection: Section | null = null;
  let inOncoming = true;

  for (const row of rows) {
    const col2 = String(row[2] ?? "").trim();
    const col2Upper = col2.toUpperCase();

    // Detect section transitions
    if (col2Upper === "ONCOMING PILOTS") {
      inOncoming = true;
      continue;
    }
    if (col2Upper === "OFFGOING PILOTS") {
      inOncoming = false;
      continue;
    }
    if (col2Upper === "PILOT IN-COMMAND") {
      currentSection = inOncoming ? "oncoming_pic" : "offgoing_pic";
      continue;
    }
    if (col2Upper === "SECOND IN-COMMAND") {
      currentSection = inOncoming ? "oncoming_sic" : "offgoing_sic";
      continue;
    }
    // Skip header rows
    if (col2Upper.startsWith("NAME (HOME")) continue;

    if (!currentSection) continue;

    // Parse crew member
    const parsed = parseCrewCell(col2);
    if (!parsed) continue;

    const role: "PIC" | "SIC" = currentSection.includes("pic") ? "PIC" : "SIC";
    const isSkillbridge = String(row[0] ?? "").trim().toUpperCase() === "TRUE";
    const volunteer = parseVolunteer(row[1]);

    // Find aircraft/tail number: scan columns 3-6 for N-number pattern (e.g. N988TX, N125DZ)
    let aircraft: string | null = null;
    for (let col = 3; col <= 6 && col < row.length; col++) {
      const val = String(row[col] ?? "").trim();
      if (/^N\d{1,5}[A-Z]{0,2}$/i.test(val)) {
        aircraft = val.toUpperCase();
        break;
      }
    }
    // Fallback: check row[4] as before (might not match N-number pattern)
    if (!aircraft && row[4]) {
      const val = String(row[4]).trim();
      if (val.length >= 3) aircraft = val;
    }

    const notes = row[10] ? String(row[10]).trim() : null;

    entries.push({
      ...parsed,
      role,
      section: currentSection,
      isSkillbridge,
      volunteer,
      aircraft,
      notes,
    });
  }

  if (entries.length === 0) {
    return NextResponse.json({ error: "No crew members found in file" }, { status: 400 });
  }

  // Upsert into crew_members table
  const supa = createServiceClient();

  // Build unique crew members (same person can appear in oncoming and offgoing sections across weeks)
  const crewMap = new Map<string, CrewEntry>();
  for (const e of entries) {
    const key = `${e.name}|${e.role}`;
    // Prefer the entry with more data (aircraft assigned, etc.)
    if (!crewMap.has(key) || e.aircraft) {
      crewMap.set(key, e);
    }
  }

  const upserted: string[] = [];
  const errors: string[] = [];

  for (const [, crew] of crewMap) {
    try {
      // Check if crew member exists by name + role
      const { data: existing } = await supa
        .from("crew_members")
        .select("id")
        .eq("name", crew.name)
        .eq("role", crew.role)
        .limit(1);

      const record = {
        name: crew.name,
        role: crew.role,
        home_airports: crew.homeAirports,
        aircraft_types: [crew.aircraftType],
        is_checkairman: crew.isCheckairman,
        is_skillbridge: crew.isSkillbridge,
        active: true,
        notes: crew.notes,
        updated_at: new Date().toISOString(),
      };

      if (existing && existing.length > 0) {
        await supa
          .from("crew_members")
          .update(record)
          .eq("id", existing[0].id);
      } else {
        await supa
          .from("crew_members")
          .insert(record);
      }
      upserted.push(crew.name);
    } catch (e) {
      errors.push(`${crew.name}: ${e instanceof Error ? e.message : "Unknown error"}`);
    }
  }

  // ─── Build swap data for optimizer ──────────────────────────────────────────
  // Offgoing crew have tail numbers in the Excel → build offgoing assignments
  // Oncoming crew mostly DON'T have tails → they go into a pool for optimizer to assign

  type SwapAssignment = {
    oncoming_pic: string | null;
    oncoming_sic: string | null;
    offgoing_pic: string | null;
    offgoing_sic: string | null;
  };
  const swapByTail = new Map<string, SwapAssignment>();

  // 1. Build offgoing assignments (they have aircraft in column 4)
  for (const e of entries.filter((e) => e.section.startsWith("offgoing") && e.aircraft)) {
    const tail = e.aircraft!;
    if (!swapByTail.has(tail)) {
      swapByTail.set(tail, { oncoming_pic: null, oncoming_sic: null, offgoing_pic: null, offgoing_sic: null });
    }
    const sa = swapByTail.get(tail)!;
    if (e.section === "offgoing_pic") sa.offgoing_pic = e.name;
    else if (e.section === "offgoing_sic") sa.offgoing_sic = e.name;
  }

  // 2. Handle rare oncoming crew WITH tails (e.g., "Staying on")
  for (const e of entries.filter((e) => e.section.startsWith("oncoming") && e.aircraft)) {
    const tail = e.aircraft!;
    if (!swapByTail.has(tail)) {
      swapByTail.set(tail, { oncoming_pic: null, oncoming_sic: null, offgoing_pic: null, offgoing_sic: null });
    }
    const sa = swapByTail.get(tail)!;
    if (e.section === "oncoming_pic") sa.oncoming_pic = e.name;
    else if (e.section === "oncoming_sic") sa.oncoming_sic = e.name;
  }

  // 3. Build oncoming pools (crew without tail assignments → optimizer assigns them)
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

  const assignedOncomingNames = new Set<string>();
  for (const [, sa] of swapByTail) {
    if (sa.oncoming_pic) assignedOncomingNames.add(sa.oncoming_pic);
    if (sa.oncoming_sic) assignedOncomingNames.add(sa.oncoming_sic);
  }

  const oncomingPool: { pic: PoolEntry[]; sic: PoolEntry[] } = { pic: [], sic: [] };
  for (const e of entries.filter((e) => e.section.startsWith("oncoming") && !e.aircraft)) {
    if (assignedOncomingNames.has(e.name)) continue;
    const entry: PoolEntry = {
      name: e.name,
      aircraft_type: e.aircraftType,
      home_airports: e.homeAirports,
      is_checkairman: e.isCheckairman,
      is_skillbridge: e.isSkillbridge,
      early_volunteer: e.volunteer.isEarly,
      late_volunteer: e.volunteer.isLate,
      standby_volunteer: e.volunteer.isStandby,
      notes: e.notes,
    };
    if (e.section === "oncoming_pic") oncomingPool.pic.push(entry);
    else if (e.section === "oncoming_sic") oncomingPool.sic.push(entry);
  }

  // Summary
  const summary = {
    oncoming_pic: entries.filter((e) => e.section === "oncoming_pic").length,
    oncoming_sic: entries.filter((e) => e.section === "oncoming_sic").length,
    offgoing_pic: entries.filter((e) => e.section === "offgoing_pic").length,
    offgoing_sic: entries.filter((e) => e.section === "offgoing_sic").length,
  };

  // Convert swap assignments to plain object for JSON
  const swapAssignments: Record<string, SwapAssignment> = {};
  for (const [tail, sa] of swapByTail) {
    swapAssignments[tail] = sa;
  }

  return NextResponse.json({
    ok: true,
    total_parsed: entries.length,
    unique_crew: crewMap.size,
    upserted: upserted.length,
    errors: errors.length > 0 ? errors : undefined,
    summary,
    swap_assignments: swapAssignments,
    oncoming_pool: oncomingPool,
  });
}
