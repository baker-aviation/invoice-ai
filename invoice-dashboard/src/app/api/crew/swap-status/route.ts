import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, isAuthed } from "@/lib/api-auth";
import { listSheets, getSheetData } from "@/lib/googleSheets";

export const dynamic = "force-dynamic";

type CrewTravel = {
  name: string;
  role: "PIC" | "SIC";
  direction: "oncoming" | "offgoing";
  aircraft_type: string;
  tail_number: string;
  swap_location: string;
  transport_type: "commercial" | "uber" | "rental" | "brightline" | "staying" | "standby" | "unknown";
  flight_number: string | null;
  flight_numbers: string[];
  date: string | null;
  duty_on: string | null;
  arrival_time: string | null;
  price: string | null;
  notes: string | null;
  is_early_volunteer: boolean;
  is_skillbridge: boolean;
  is_checkairman: boolean;
  verified_ticket: boolean;
  home_airports: string[];
  status: "scheduled" | "boarding" | "departed" | "en_route" | "landed" | "arrived_fbo" | "delayed" | "cancelled" | "unknown";
  status_detail: string | null;
  live_departure: string | null;
  live_arrival: string | null;
  delay_minutes: number | null;
};

const EMOJI_TYPE: Record<string, string> = {
  "🟢": "citation_x",
  "🟡": "challenger",
  "🟣": "dual",
};

function parseTransportType(flightNum: string | null, notes: string | null): CrewTravel["transport_type"] {
  if (!flightNum) return "unknown";
  const fn = flightNum.trim().toLowerCase();
  if (fn === "uber" || fn.includes("uber")) return "uber";
  if (fn === "rental" || fn.includes("rental")) return "rental";
  if (fn.includes("brightline")) return "brightline";
  if (fn === "staying on" || fn.includes("staying")) return "staying";
  // Check notes for standby
  if (notes?.toUpperCase().includes("STANDBY")) return "standby";
  // If it has letters + numbers, likely a flight number
  if (/[A-Z]{1,3}\d+/i.test(fn)) return "commercial";
  return "unknown";
}

function parseFlightNumbers(raw: string | null): string[] {
  if (!raw) return [];
  // Split on "/" for connections: "UA1232/UA5369" → ["UA1232", "UA5369"]
  // Also handle "DL2216/DL1271", "AA5904/AA1419"
  return raw.split(/[\/,]/)
    .map(s => s.trim())
    .filter(s => /^[A-Z]{1,3}\d+/i.test(s));
}

function parseCrewCell(raw: string): { name: string; aircraft_type: string; home_airports: string[]; is_checkairman: boolean } | null {
  if (!raw || typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  let aircraft_type = "unknown";
  for (const [emoji, type] of Object.entries(EMOJI_TYPE)) {
    if (trimmed.includes(emoji)) { aircraft_type = type; break; }
  }

  const is_checkairman = /[✔✓]/.test(trimmed);
  const cleaned = trimmed
    .replace(/^[\u{1F7E0}-\u{1F7FF}\s]+/u, "")
    .replace(/[✔✓\s]+$/u, "")
    .trim();

  const match = cleaned.match(/^(.+?)\s*\(([^)]+)\)\s*$/);
  if (!match) return null;

  const name = match[1].trim();
  const home_airports = match[2].split(/[\/,]/).map(a => a.trim().toUpperCase()).filter(a => a.length >= 2 && a.length <= 5);

  return { name, aircraft_type, home_airports, is_checkairman };
}

function guessStatus(crew: CrewTravel): CrewTravel["status"] {
  // Simple time-based guess (will be replaced by real flight status API later)
  if (crew.transport_type === "standby") return "unknown";
  if (crew.transport_type === "staying") return "arrived_fbo";
  if (!crew.date) return "unknown";

  // For today's flights, estimate based on current time vs scheduled times
  const now = new Date();
  const today = now.toLocaleDateString("en-CA"); // YYYY-MM-DD

  // Parse date like "3/25" or "3/24"
  const dateMatch = crew.date.match(/(\d{1,2})\/(\d{1,2})/);
  if (!dateMatch) return "scheduled";
  const crewDate = `2026-${dateMatch[1].padStart(2, "0")}-${dateMatch[2].padStart(2, "0")}`;

  if (crewDate < today) {
    // Yesterday's travel — should be arrived
    return "arrived_fbo";
  }
  if (crewDate > today) {
    return "scheduled";
  }

  // Today — estimate from times
  if (!crew.arrival_time) return "scheduled";
  const arrMatch = crew.arrival_time.match(/^(\d{2})(\d{2})/);
  if (!arrMatch) return "scheduled";
  const arrHour = parseInt(arrMatch[1]);
  const arrMin = parseInt(arrMatch[2]);

  // Very rough: current hour in ET
  const etHour = parseInt(now.toLocaleString("en-US", { timeZone: "America/New_York", hour: "numeric", hour12: false }));
  const etMin = parseInt(now.toLocaleString("en-US", { timeZone: "America/New_York", minute: "numeric" }));
  const nowMinutes = etHour * 60 + etMin;
  const arrMinutes = arrHour * 60 + arrMin;

  if (nowMinutes > arrMinutes + 60) return "arrived_fbo"; // >1hr after arrival → at FBO
  if (nowMinutes > arrMinutes) return "landed";
  if (nowMinutes > arrMinutes - 120) return "en_route"; // within 2hr of arrival
  if (crew.duty_on) {
    const dutyMatch = crew.duty_on.match(/^(\d{2})(\d{2})/);
    if (dutyMatch) {
      const dutyMinutes = parseInt(dutyMatch[1]) * 60 + parseInt(dutyMatch[2]);
      if (nowMinutes > dutyMinutes) return "departed";
    }
  }
  return "scheduled";
}

export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (!isAuthed(auth)) return auth.error;

  try {
    // Find the current swap sheet (closest to today with "MAR 25" or next swap)
    const sheets = await listSheets();
    const sheetNames = sheets.map(s => s.title);

    // Find the sheet that starts with "MAR 25" or the most recent weekly sheet
    let targetSheet = sheetNames.find(s => s.includes("MAR 25"));
    if (!targetSheet) {
      // Find weekly sheets and pick the closest to today
      const weeklySheets = sheetNames.filter(n =>
        /^[A-Z]{3}\s+\d+-[A-Z]{3}\s+\d+\s*\([AB]\)$/i.test(n)
      );
      targetSheet = weeklySheets[0] ?? null;
    }

    if (!targetSheet) {
      return NextResponse.json({ error: "No swap sheet found" }, { status: 404 });
    }

    const rows = await getSheetData(targetSheet);
    const oncoming: CrewTravel[] = [];
    const offgoing: CrewTravel[] = [];

    let inOncoming = true;
    let currentRole: "PIC" | "SIC" = "PIC";

    for (const row of rows) {
      const col2 = String(row[2] ?? "").trim();
      const col2Upper = col2.toUpperCase();

      if (col2Upper === "ONCOMING PILOTS") { inOncoming = true; continue; }
      if (col2Upper === "OFFGOING PILOTS") { inOncoming = false; continue; }
      if (col2Upper === "PILOT IN-COMMAND") { currentRole = "PIC"; continue; }
      if (col2Upper === "SECOND IN-COMMAND") { currentRole = "SIC"; continue; }
      if (col2Upper.startsWith("NAME (HOME") || col2Upper === "SKILLBRIDGE" || !col2) continue;

      const parsed = parseCrewCell(col2);
      if (!parsed) continue;

      const flightRaw = String(row[5] ?? "").trim() || null;
      const notes = String(row[10] ?? "").trim() || null;
      const transport_type = parseTransportType(flightRaw, notes);

      // Skip empty standby entries with no tail
      const tail = String(row[4] ?? "").trim();
      if (!tail && transport_type !== "standby" && !notes?.toUpperCase().includes("STANDBY")) continue;

      const entry: CrewTravel = {
        name: parsed.name,
        role: currentRole,
        direction: inOncoming ? "oncoming" : "offgoing",
        aircraft_type: parsed.aircraft_type,
        tail_number: tail,
        swap_location: String(row[3] ?? "").trim(),
        transport_type,
        flight_number: flightRaw,
        flight_numbers: transport_type === "commercial" ? parseFlightNumbers(flightRaw) : [],
        date: String(row[6] ?? "").trim() || null,
        duty_on: String(row[7] ?? "").trim() || null,
        arrival_time: String(row[8] ?? "").trim() || null,
        price: String(row[9] ?? "").trim() || null,
        notes,
        is_early_volunteer: String(row[1] ?? "").trim().toUpperCase() === "E",
        is_skillbridge: String(row[0] ?? "").trim().toUpperCase() === "TRUE",
        is_checkairman: parsed.is_checkairman,
        verified_ticket: String(row[11] ?? "").trim().toUpperCase() === "TRUE",
        home_airports: parsed.home_airports,
        status: "scheduled",
        status_detail: null,
        live_departure: null,
        live_arrival: null,
        delay_minutes: null,
      };

      // Guess status based on time
      entry.status = guessStatus(entry);

      // Standby crew
      if (notes?.toUpperCase().includes("STANDBY") && !tail) {
        entry.transport_type = "standby";
        entry.status = "unknown";
      }

      if (inOncoming) {
        oncoming.push(entry);
      } else {
        offgoing.push(entry);
      }
    }

    // Extract swap date from sheet name: "MAR 25-APR 1 (A)" → "2026-03-25"
    const dateMatch = targetSheet.match(/([A-Z]{3})\s+(\d+)/i);
    const monthMap: Record<string, string> = { JAN: "01", FEB: "02", MAR: "03", APR: "04", MAY: "05", JUN: "06", JUL: "07", AUG: "08", SEP: "09", OCT: "10", NOV: "11", DEC: "12" };
    const swapDate = dateMatch
      ? `2026-${monthMap[dateMatch[1].toUpperCase()] ?? "01"}-${dateMatch[2].padStart(2, "0")}`
      : new Date().toISOString().slice(0, 10);

    return NextResponse.json({
      swap_date: swapDate,
      sheet_name: targetSheet,
      oncoming,
      offgoing,
      last_updated: new Date().toISOString(),
    });
  } catch (e) {
    console.error("[SwapStatus] Error:", e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed to load swap status" },
      { status: 500 },
    );
  }
}
