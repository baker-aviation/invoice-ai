import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, isRateLimited } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";

type PriceRow = {
  fbo_vendor: string;
  airport_code: string;
  volume_tier: string;
  product: string;
  price: number;
  tail_numbers: string | null;
  week_start: string;
  upload_batch: string;
};

/**
 * POST /api/fuel-prices/advertised/upload
 *
 * Upload a CSV of FBO-advertised fuel prices.
 * FormData: file (CSV), vendor (string, optional for auto-detected formats),
 *           week_start (date string, optional for auto-detected formats)
 *
 * Auto-detects Baker/AEG Fuels, Everest Fuel, and WFS CSV formats by header row.
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
  const vendorOverride = (formData.get("vendor") as string | null)?.trim() || null;
  const weekStartRaw = (formData.get("week_start") as string | null)?.trim() || null;

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

  const batchId = `adv-${Date.now()}-${auth.email}`;
  const headerFields = parseCSVLine(lines[0]).map((h) => h.toUpperCase().trim());

  // Detect CSV format by header
  const format = detectFormat(headerFields);

  let rows: PriceRow[];
  let detectedVendor: string | null = null;

  if (format === "baker") {
    // Baker/AEG Fuels format
    detectedVendor = "AEG Fuels";
    const weekStart = resolveWeekStart(weekStartRaw, file.name);
    if (!weekStart) {
      return NextResponse.json({ error: "Could not determine week_start — please provide it" }, { status: 400 });
    }
    rows = parseBakerCSV(lines, headerFields, vendorOverride ?? detectedVendor, weekStart, batchId);
  } else if (format === "everest") {
    // Everest Fuel format
    detectedVendor = "Everest Fuel";
    const weekStart = resolveWeekStart(weekStartRaw, file.name);
    if (!weekStart) {
      return NextResponse.json({ error: "Could not determine week_start — please provide it" }, { status: 400 });
    }
    rows = parseEverestCSV(lines, headerFields, vendorOverride ?? detectedVendor, weekStart, batchId);
  } else if (format === "wfs") {
    // World Fuel Services format — each row has its own Exp Date
    detectedVendor = "World Fuel Services";
    rows = parseWfsCSV(lines, headerFields, vendorOverride ?? detectedVendor, weekStartRaw, batchId);
  } else {
    // Original/generic format — vendor and week_start required
    if (!vendorOverride) return NextResponse.json({ error: "vendor is required for this CSV format" }, { status: 400 });
    if (!weekStartRaw) return NextResponse.json({ error: "week_start is required for this CSV format" }, { status: 400 });
    const weekStart = normalizeToMonday(weekStartRaw);
    if (!weekStart) return NextResponse.json({ error: "Invalid week_start date" }, { status: 400 });
    rows = parseGenericCSV(lines, vendorOverride, weekStart, batchId);
  }

  if (rows.length === 0) {
    return NextResponse.json({ error: "No valid rows found in CSV" }, { status: 400 });
  }

  const supa = createServiceClient();

  // Insert in batches of 500, upsert with ignoreDuplicates
  let inserted = 0;
  let skipped = 0;
  const batchSize = 500;

  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    const { data, error } = await supa
      .from("fbo_advertised_prices")
      .upsert(batch, {
        onConflict: "fbo_vendor,airport_code,volume_tier,tail_numbers,week_start",
        ignoreDuplicates: false,
      })
      .select("id");

    if (error) {
      console.error("[advertised/upload] Supabase error:", error);
      return NextResponse.json(
        { error: "Database insert failed", inserted, skipped, totalParsed: rows.length },
        { status: 500 },
      );
    }

    const batchInserted = data?.length ?? 0;
    inserted += batchInserted;
    skipped += batch.length - batchInserted;
  }

  return NextResponse.json({
    ok: true,
    inserted,
    skipped,
    totalParsed: rows.length,
    uploadBatch: batchId,
    detectedFormat: format,
    vendor: vendorOverride ?? detectedVendor,
  });
}

// --- Format detection ---

function detectFormat(headers: string[]): "baker" | "everest" | "wfs" | "generic" {
  // Baker/AEG: has ICAO, FUELER, TOTAL PRICE columns
  if (headers.includes("FUELER") && headers.includes("TOTAL PRICE")) return "baker";
  // Everest: has ICAO, FBO, TIER, PRICE columns
  if (headers.includes("FBO") && headers.includes("TIER") && headers.includes("PRICE")) return "everest";
  // WFS (World Fuel Services): has SUPPLIER, GAL FROM, GAL TO, ESTIMATED TOTAL PRICE
  if (headers.includes("SUPPLIER") && headers.includes("ESTIMATED TOTAL PRICE")) return "wfs";
  return "generic";
}

/** Try to extract a date from the filename (e.g. "Everest Fuel_03_06_2026.csv" → 2026-03-06) */
function extractDateFromFilename(name: string): string | null {
  // Pattern: MM_DD_YYYY or MM-DD-YYYY
  const m = name.match(/(\d{1,2})[_-](\d{1,2})[_-](\d{4})/);
  if (m) {
    const [, mm, dd, yyyy] = m;
    const d = new Date(`${yyyy}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}T12:00:00`);
    if (!isNaN(d.getTime())) return d.toISOString().split("T")[0];
  }
  return null;
}

/** Resolve week_start: use explicit value, or extract from filename, then normalize to Monday */
function resolveWeekStart(raw: string | null, filename: string): string | null {
  const dateStr = raw || extractDateFromFilename(filename);
  if (!dateStr) return null;
  return normalizeToMonday(dateStr);
}

// --- Baker/AEG Fuels parser ---

function parseBakerCSV(lines: string[], headers: string[], vendor: string, weekStart: string, batchId: string): PriceRow[] {
  const col = (name: string) => headers.indexOf(name);
  const icaoIdx = col("ICAO");
  const fuelerIdx = col("FUELER");
  const totalPriceIdx = col("TOTAL PRICE");
  const minGalIdx = col("MIN GALLONS");
  const maxGalIdx = col("MAX GALLONS");

  if (icaoIdx < 0 || totalPriceIdx < 0) return [];

  const rows: PriceRow[] = [];

  for (let i = 1; i < lines.length; i++) {
    const fields = parseCSVLine(lines[i]);
    const icao = fields[icaoIdx]?.trim().toUpperCase();
    if (!icao) continue;

    const price = parsePrice(fields[totalPriceIdx]);
    if (price === null || price <= 0) continue; // skip "CALL" and invalid

    const minGal = fields[minGalIdx]?.trim() || "1";
    const maxGal = fields[maxGalIdx]?.trim() || "";
    const volumeTier = maxGal && maxGal !== "99999" ? `${minGal}-${maxGal}` : `${minGal}+`;
    const fueler = fuelerIdx >= 0 ? fields[fuelerIdx]?.trim() || "" : "";

    rows.push({
      fbo_vendor: vendor,
      airport_code: icao,
      volume_tier: volumeTier,
      product: fueler ? `Jet-A (${fueler})` : "Jet-A",
      price,
      tail_numbers: null,
      week_start: weekStart,
      upload_batch: batchId,
    });
  }

  return rows;
}

// --- Everest Fuel parser ---

function parseEverestCSV(lines: string[], headers: string[], vendor: string, weekStart: string, batchId: string): PriceRow[] {
  const col = (name: string) => headers.indexOf(name);
  const icaoIdx = col("ICAO");
  const fboIdx = col("FBO");
  const tierIdx = col("TIER");
  const priceIdx = col("PRICE");

  if (icaoIdx < 0 || priceIdx < 0) return [];

  const rows: PriceRow[] = [];

  for (let i = 1; i < lines.length; i++) {
    const fields = parseCSVLine(lines[i]);
    const icao = fields[icaoIdx]?.trim().toUpperCase();
    if (!icao) continue;

    const price = parsePrice(fields[priceIdx]);
    if (price === null || price <= 0) continue;

    const tier = fields[tierIdx]?.trim() || "1";
    const fbo = fboIdx >= 0 ? fields[fboIdx]?.trim() || "" : "";

    rows.push({
      fbo_vendor: vendor,
      airport_code: icao,
      volume_tier: `${tier}+`,
      product: fbo ? `Jet-A (${fbo})` : "Jet-A",
      price,
      tail_numbers: null,
      week_start: weekStart,
      upload_batch: batchId,
    });
  }

  return rows;
}

// --- World Fuel Services parser ---

function parseWfsCSV(lines: string[], headers: string[], vendor: string, weekStartOverride: string | null, batchId: string): PriceRow[] {
  const col = (name: string) => headers.indexOf(name);
  const icaoIdx = col("ICAO");
  const supplierIdx = col("SUPPLIER");
  const galFromIdx = col("GAL FROM");
  const galToIdx = col("GAL TO");
  const expDateIdx = col("EXP DATE");
  const totalPriceIdx = col("ESTIMATED TOTAL PRICE");

  if (icaoIdx < 0 || totalPriceIdx < 0) return [];

  const rows: PriceRow[] = [];

  for (let i = 1; i < lines.length; i++) {
    const fields = parseCSVLine(lines[i]);
    const icao = fields[icaoIdx]?.trim().toUpperCase();
    if (!icao) continue;

    const price = parsePrice(fields[totalPriceIdx]);
    if (price === null || price <= 0) continue;

    // Determine week_start: use override, or per-row Exp Date
    let weekStart: string | null = null;
    if (weekStartOverride) {
      weekStart = normalizeToMonday(weekStartOverride);
    } else if (expDateIdx >= 0) {
      const expRaw = fields[expDateIdx]?.trim();
      if (expRaw) {
        weekStart = normalizeToMonday(expRaw);
      }
    }
    if (!weekStart) continue; // skip rows with no usable date

    const galFrom = fields[galFromIdx]?.trim() || "1";
    const galTo = fields[galToIdx]?.trim() || "";
    const volumeTier = galTo && galTo !== "999999999" ? `${galFrom}-${galTo}` : `${galFrom}+`;
    const supplier = supplierIdx >= 0 ? fields[supplierIdx]?.trim() || "" : "";

    rows.push({
      fbo_vendor: vendor,
      airport_code: icao,
      volume_tier: volumeTier,
      product: supplier ? `Jet-A (${supplier})` : "Jet-A",
      price,
      tail_numbers: null,
      week_start: weekStart,
      upload_batch: batchId,
    });
  }

  return rows;
}

// --- Generic CSV parser (original format) ---

function parseGenericCSV(lines: string[], vendor: string, weekStart: string, batchId: string): PriceRow[] {
  const rows: PriceRow[] = [];
  let lastAirport = "";

  for (let i = 1; i < lines.length; i++) {
    const fields = parseCSVLine(lines[i]);
    if (fields.length < 5) continue;

    const rawAirport = fields[0].trim();
    if (rawAirport) lastAirport = rawAirport.toUpperCase();
    if (!lastAirport) continue;

    const volumeTier = fields[1].trim() || "1+";
    const product = fields[2].trim() || "Jet-A";
    const price = parsePrice(fields[3]);
    if (price === null || price <= 0) continue;
    const rawTails = fields[4]?.trim() ?? "";
    const tailNumbers = (!rawTails || rawTails.toLowerCase() === "all tails") ? null : rawTails;

    rows.push({
      fbo_vendor: vendor,
      airport_code: lastAirport,
      volume_tier: volumeTier,
      product,
      price,
      tail_numbers: tailNumbers,
      week_start: weekStart,
      upload_batch: batchId,
    });
  }

  return rows;
}

// --- Shared helpers ---

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
      fields.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  fields.push(current.trim());
  return fields;
}

function parsePrice(raw: string): number | null {
  if (!raw) return null;
  const cleaned = raw.replace(/[$,]/g, "").trim();
  if (cleaned.toUpperCase() === "CALL") return null;
  const num = parseFloat(cleaned);
  return isNaN(num) ? null : num;
}

/** Normalize a date string to the Monday of that week (YYYY-MM-DD) */
function normalizeToMonday(raw: string): string | null {
  const d = new Date(raw + "T12:00:00");
  if (isNaN(d.getTime())) return null;
  const day = d.getDay(); // 0=Sun, 1=Mon, ...
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  return d.toISOString().split("T")[0];
}
