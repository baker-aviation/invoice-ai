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
    const aircraft = row[4] ? String(row[4]).trim() : null;
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

  // Build rotation assignments from entries that have aircraft assigned
  const rotationEntries = entries.filter((e) => e.aircraft);
  let rotationsCreated = 0;

  for (const e of rotationEntries) {
    try {
      // Look up crew member ID
      const { data: member } = await supa
        .from("crew_members")
        .select("id")
        .eq("name", e.name)
        .eq("role", e.role)
        .limit(1);

      if (!member || member.length === 0) continue;

      // Determine rotation dates from the swap date (file name might hint at this)
      // For now, use the section to determine if they're coming on or going off
      const isOncoming = e.section.startsWith("oncoming");

      // Check if rotation already exists
      const { data: existingRot } = await supa
        .from("crew_rotations")
        .select("id")
        .eq("crew_member_id", member[0].id)
        .eq("tail_number", e.aircraft!)
        .order("rotation_start", { ascending: false })
        .limit(1);

      if (!existingRot || existingRot.length === 0) {
        await supa.from("crew_rotations").insert({
          crew_member_id: member[0].id,
          tail_number: e.aircraft,
          rotation_start: new Date().toISOString().slice(0, 10),
          is_early_volunteer: e.volunteer.isEarly,
          is_late_volunteer: e.volunteer.isLate,
          standby: e.volunteer.isStandby,
        });
        rotationsCreated++;
      }
    } catch {
      // Non-critical
    }
  }

  // Summary by section
  const summary = {
    oncoming_pic: entries.filter((e) => e.section === "oncoming_pic").length,
    oncoming_sic: entries.filter((e) => e.section === "oncoming_sic").length,
    offgoing_pic: entries.filter((e) => e.section === "offgoing_pic").length,
    offgoing_sic: entries.filter((e) => e.section === "offgoing_sic").length,
  };

  return NextResponse.json({
    ok: true,
    total_parsed: entries.length,
    unique_crew: crewMap.size,
    upserted: upserted.length,
    rotations_created: rotationsCreated,
    errors: errors.length > 0 ? errors : undefined,
    summary,
  });
}
