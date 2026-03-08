import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, isRateLimited } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";

/**
 * POST /api/admin/trip-salespersons/upload
 *
 * Upload a JetInsight CSV of trip-salesperson assignments.
 * FormData: file (CSV)
 *
 * Expected CSV columns:
 *   Trip, Customer, Trip start, Trip end, Aircraft, From, To, Salesperson
 *
 * Airport format from JetInsight: "Teterboro (TEB)" → extract IATA, prefix K for domestic.
 */
export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if ("error" in auth) return auth.error;
  if (isRateLimited(auth.userId, 5)) {
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

  // Parse header to find column indices
  const headerFields = parseCSVLine(lines[0]);
  const colMap = findColumns(headerFields);
  if (!colMap) {
    return NextResponse.json(
      { error: "CSV missing required columns. Expected: Trip, Customer, Trip start, Trip end, Aircraft, From, To, Salesperson" },
      { status: 400 },
    );
  }

  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const fields = parseCSVLine(lines[i]);
    if (fields.length < headerFields.length) continue;

    const tripId = fields[colMap.trip]?.trim();
    const salesperson = fields[colMap.salesperson]?.trim();
    if (!tripId || !salesperson) continue;

    const tripStart = fields[colMap.tripStart]?.trim();
    const tripEnd = fields[colMap.tripEnd]?.trim();
    if (!tripStart || !tripEnd) continue;

    const tail = extractTailNumber(fields[colMap.aircraft]?.trim() ?? "");
    const originIcao = extractIcao(fields[colMap.from]?.trim() ?? "");
    const destIcao = extractIcao(fields[colMap.to]?.trim() ?? "");
    const customer = fields[colMap.customer]?.trim() ?? null;

    rows.push({
      trip_id: tripId,
      tail_number: tail,
      origin_icao: originIcao,
      destination_icao: destIcao,
      trip_start: normalizeDate(tripStart),
      trip_end: normalizeDate(tripEnd),
      salesperson_name: salesperson,
      customer,
      updated_at: new Date().toISOString(),
    });
  }

  if (rows.length === 0) {
    return NextResponse.json({ error: "No valid rows found in CSV" }, { status: 400 });
  }

  const supa = createServiceClient();
  let upserted = 0;
  const batchSize = 500;

  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    const { data, error } = await supa
      .from("trip_salespersons")
      .upsert(batch, { onConflict: "trip_id" })
      .select("id");

    if (error) {
      console.error("[trip-salespersons/upload] Supabase error:", error);
      return NextResponse.json(
        { error: "Database upsert failed", detail: error.message, upserted, totalParsed: rows.length },
        { status: 500 },
      );
    }
    upserted += data?.length ?? 0;
  }

  return NextResponse.json({ ok: true, upserted, totalParsed: rows.length });
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
  trip: number;
  customer: number;
  tripStart: number;
  tripEnd: number;
  aircraft: number;
  from: number;
  to: number;
  salesperson: number;
};

function findColumns(headers: string[]): ColMap | null {
  const norm = headers.map((h) => h.trim().toLowerCase());
  const trip = norm.findIndex((h) => h === "trip");
  const customer = norm.findIndex((h) => h === "customer");
  const tripStart = norm.findIndex((h) => h === "trip start");
  const tripEnd = norm.findIndex((h) => h === "trip end");
  const aircraft = norm.findIndex((h) => h === "aircraft");
  const from = norm.findIndex((h) => h === "from");
  const to = norm.findIndex((h) => h === "to");
  const salesperson = norm.findIndex((h) => h === "salesperson");

  if ([trip, customer, tripStart, tripEnd, aircraft, from, to, salesperson].some((i) => i === -1)) {
    return null;
  }
  return { trip, customer, tripStart, tripEnd, aircraft, from, to, salesperson };
}

/**
 * Extract ICAO code from JetInsight format: "Teterboro (TEB)" → "KTEB"
 * For 3-letter domestic IATA codes, prefix with K.
 * If already 4 chars (e.g. "KTEB"), return as-is.
 */
function extractIcao(raw: string): string | null {
  if (!raw) return null;
  // Try to match parenthesized code: "Teterboro (TEB)"
  const match = raw.match(/\(([A-Z0-9]{3,4})\)/);
  const code = match ? match[1] : raw.replace(/[^A-Z0-9]/gi, "").toUpperCase();
  if (!code) return null;
  // 3-letter code → prefix K for domestic US
  if (code.length === 3) return `K${code}`;
  return code;
}

/**
 * Extract tail number from aircraft string.
 * JetInsight may include type: "N51GB (CL30)" → "N51GB"
 */
function extractTailNumber(raw: string): string {
  if (!raw) return "";
  // Take the first word (before any parenthesized type)
  const parts = raw.split(/\s+/);
  return parts[0].toUpperCase();
}

/**
 * Normalize date strings like "02/15/2026" or "2026-02-15" to "YYYY-MM-DD"
 */
function normalizeDate(raw: string): string {
  // Try MM/DD/YYYY format
  const slashMatch = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (slashMatch) {
    const [, m, d, y] = slashMatch;
    return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }
  // Already ISO or other parseable format
  return raw;
}
