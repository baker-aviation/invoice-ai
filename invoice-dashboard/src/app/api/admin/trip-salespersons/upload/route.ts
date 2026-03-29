import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, isRateLimited } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";

/**
 * POST /api/admin/trip-salespersons/upload
 *
 * Upload a JetInsight "Aircraft Activity" CSV.
 * FormData: file (CSV)
 *
 * Expected CSV columns:
 *   Start Z, Start time Z, End time Z, Tail #, Trip, Salesperson, Customer, Orig, Orig FBO, Dest, Dest FBO, Passengers
 */
export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if ("error" in auth) return auth.error;
  if (await isRateLimited(auth.userId, 5)) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return NextResponse.json({ error: "Invalid form data" }, { status: 400 });
  }

  const file = formData.get("file") as File | null;
  if (!file) return NextResponse.json({ error: "file is required" }, { status: 400 });
  if (!file.name.endsWith(".csv")) {
    return NextResponse.json({ error: "Only CSV files are accepted" }, { status: 400 });
  }
  if (file.size > 10 * 1024 * 1024) {
    return NextResponse.json({ error: "File too large (max 10MB)" }, { status: 400 });
  }

  const text = await file.text();
  const lines = text.split("\n").filter((l) => l.trim());

  if (lines.length < 2) {
    return NextResponse.json({ error: "CSV has no data rows" }, { status: 400 });
  }

  const headerFields = parseCSVLine(lines[0]);
  const colMap = findColumns(headerFields);
  if (!colMap) {
    return NextResponse.json(
      { error: "CSV missing required columns. Expected: Start Z, Start time Z, End time Z, Tail #, Trip, Salesperson, Customer, Orig, Dest (Orig FBO and Dest FBO are optional)" },
      { status: 400 },
    );
  }

  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const fields = parseCSVLine(lines[i]);
    if (fields.length < 6) continue;

    const tripId = fields[colMap.trip]?.trim();
    const salesperson = fields[colMap.salesperson]?.trim();
    const tail = fields[colMap.tail]?.trim().toUpperCase();
    if (!tripId || !salesperson || !tail) continue;

    const startDate = fields[colMap.startZ]?.trim();
    const startTime = fields[colMap.startTimeZ]?.trim();
    const endTime = fields[colMap.endTimeZ]?.trim();
    if (!startDate || !startTime) continue;

    const originRaw = fields[colMap.orig]?.trim().toUpperCase() ?? "";
    const destRaw = fields[colMap.dest]?.trim().toUpperCase() ?? "";
    const originIcao = toIcao(originRaw);
    const destIcao = toIcao(destRaw);
    const customer = fields[colMap.customer]?.trim() ?? null;
    const originFbo = colMap.origFbo !== -1 ? (fields[colMap.origFbo]?.trim() || null) : null;
    const destFbo = colMap.destFbo !== -1 ? (fields[colMap.destFbo]?.trim() || null) : null;
    const passengersRaw = colMap.passengers !== -1 ? (fields[colMap.passengers]?.trim() || null) : null;
    const passengers = passengersRaw && passengersRaw !== "null" ? passengersRaw : null;

    const departure = parseZuluDateTime(startDate, startTime);
    const arrival = endTime ? parseZuluDateTime(startDate, endTime, departure) : null;

    rows.push({
      trip_id: tripId,
      tail_number: tail,
      origin_icao: originIcao,
      destination_icao: destIcao,
      scheduled_departure: departure,
      scheduled_arrival: arrival,
      salesperson_name: salesperson,
      customer,
      origin_fbo: originFbo,
      destination_fbo: destFbo,
      passengers,
      updated_at: new Date().toISOString(),
    });
  }

  if (rows.length === 0) {
    return NextResponse.json({ error: "No valid rows found in CSV" }, { status: 400 });
  }

  // Dedupe: keep last occurrence per unique key (same trip/tail/origin/dest)
  const deduped = new Map<string, (typeof rows)[0]>();
  for (const r of rows) {
    deduped.set(`${r.trip_id}|${r.tail_number}|${r.origin_icao}|${r.destination_icao}`, r);
  }
  const uniqueRows = [...deduped.values()];

  const supa = createServiceClient();

  // Clear existing data before inserting fresh upload
  await supa.from("trip_salespersons").delete().neq("id", 0);

  let inserted = 0;
  const batchSize = 500;

  for (let i = 0; i < uniqueRows.length; i += batchSize) {
    const batch = uniqueRows.slice(i, i + batchSize);
    const { data, error } = await supa
      .from("trip_salespersons")
      .upsert(batch, { onConflict: "trip_id,tail_number,origin_icao,destination_icao" })
      .select("id");

    if (error) {
      console.error("[trip-salespersons/upload] Supabase error:", error);
      return NextResponse.json(
        { error: "Database upsert failed", detail: error.message, inserted, totalParsed: uniqueRows.length },
        { status: 500 },
      );
    }
    inserted += data?.length ?? 0;
  }

  return NextResponse.json({ ok: true, inserted, totalParsed: uniqueRows.length });
}

// --- Helpers ---

function parseCSVLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && i + 1 < line.length && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === "," && !inQuotes) {
      fields.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields;
}

type ColMap = {
  startZ: number;
  startTimeZ: number;
  endTimeZ: number;
  tail: number;
  trip: number;
  salesperson: number;
  customer: number;
  orig: number;
  dest: number;
  origFbo: number;
  destFbo: number;
  passengers: number;
};

function findColumns(headers: string[]): ColMap | null {
  const norm = headers.map((h) => h.trim().toLowerCase());
  const startZ = norm.findIndex((h) => h === "start z");
  const startTimeZ = norm.findIndex((h) => h === "start time z");
  const endTimeZ = norm.findIndex((h) => h === "end time z");
  const tail = norm.findIndex((h) => h === "tail #");
  const trip = norm.findIndex((h) => h === "trip");
  const salesperson = norm.findIndex((h) => h === "salesperson");
  const customer = norm.findIndex((h) => h === "customer");
  const orig = norm.findIndex((h) => h === "orig");
  const dest = norm.findIndex((h) => h === "dest");
  const origFbo = norm.findIndex((h) => h === "orig fbo");
  const destFbo = norm.findIndex((h) => h === "dest fbo");
  const passengers = norm.findIndex((h) => h === "passengers");

  if ([startZ, startTimeZ, endTimeZ, tail, trip, salesperson, customer, orig, dest].some((i) => i === -1)) {
    return null;
  }
  return { startZ, startTimeZ, endTimeZ, tail, trip, salesperson, customer, orig, dest, origFbo, destFbo, passengers };
}

/**
 * Convert airport code to ICAO.
 * 3-letter codes get K prefix (US domestic). 4-letter already ICAO.
 */
function toIcao(code: string): string | null {
  if (!code) return null;
  if (code.length === 3) return `K${code}`;
  return code;
}

/**
 * Parse "03/11/26" + "11:30 pm" into a Zulu ISO string.
 * If the result is before `afterRef`, assume it crossed midnight and add a day.
 */
function parseZuluDateTime(dateStr: string, timeStr: string, afterRef?: string | null): string {
  // Parse date: MM/DD/YY or MM/DD/YYYY
  const dm = dateStr.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (!dm) return new Date().toISOString();
  let [, month, day, year] = dm;
  if (year.length === 2) year = `20${year}`;
  const dateISO = `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;

  // Parse time: "11:30 pm" or "03:36 am"
  const tm = timeStr.match(/^(\d{1,2}):(\d{2})\s*(am|pm)$/i);
  if (!tm) return `${dateISO}T00:00:00Z`;
  let hours = parseInt(tm[1]);
  const minutes = tm[2];
  const ampm = tm[3].toLowerCase();
  if (ampm === "pm" && hours < 12) hours += 12;
  if (ampm === "am" && hours === 12) hours = 0;

  const isoStr = `${dateISO}T${hours.toString().padStart(2, "0")}:${minutes}:00Z`;

  // If arrival is before departure, it crossed midnight
  if (afterRef && isoStr < afterRef) {
    const d = new Date(isoStr);
    d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString();
  }

  return isoStr;
}
