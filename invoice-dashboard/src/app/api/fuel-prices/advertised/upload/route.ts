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
 * Auto-detects Baker/AEG Fuels, Everest Fuel, WFS, and Avfuel CSV formats by header row.
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
  } else if (format === "avfuel") {
    // Avfuel/BAKAV format — each row has its own EFF DATE
    detectedVendor = "Avfuel";
    rows = parseAvfuelCSV(lines, headerFields, vendorOverride ?? detectedVendor, weekStartRaw, batchId);
  } else if (format === "titan") {
    // Titan Fuels format — no date column, extract from filename
    detectedVendor = "Titan Fuels";
    const weekStart = resolveWeekStart(weekStartRaw, file.name);
    if (!weekStart) {
      return NextResponse.json({ error: "Could not determine week_start — please provide it" }, { status: 400 });
    }
    rows = parseTitanCSV(lines, headerFields, vendorOverride ?? detectedVendor, weekStart, batchId);
  } else if (format === "signature") {
    // Signature Flight Support format — no date column, extract from filename
    detectedVendor = "Signature Flight Support";
    const weekStart = resolveWeekStart(weekStartRaw, file.name);
    if (!weekStart) {
      return NextResponse.json({ error: "Could not determine week_start — please provide it" }, { status: 400 });
    }
    rows = parseSignatureCSV(lines, headerFields, vendorOverride ?? detectedVendor, weekStart, batchId);
  } else if (format === "jet_aviation") {
    // Jet Aviation format — no date column, extract from filename or default to current week
    detectedVendor = "Jet Aviation";
    const weekStart = resolveWeekStart(weekStartRaw, file.name) ?? normalizeToMonday(new Date().toISOString().split("T")[0]);
    if (!weekStart) {
      return NextResponse.json({ error: "Could not determine week_start — please provide it" }, { status: 400 });
    }
    rows = parseJetAviationCSV(lines, headerFields, vendorOverride ?? detectedVendor, weekStart, batchId);
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
  const vendor = vendorOverride ?? detectedVendor ?? "";

  // Delete old records for this vendor before inserting fresh data
  const { error: delError } = await supa
    .from("fbo_advertised_prices")
    .delete()
    .eq("fbo_vendor", vendor);
  if (delError) {
    console.error("[advertised/upload] Delete old records failed:", delError);
  }

  // Insert in batches of 500
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

function detectFormat(headers: string[]): "baker" | "everest" | "wfs" | "avfuel" | "titan" | "signature" | "jet_aviation" | "generic" {
  // Baker/AEG: has ICAO, FUELER, TOTAL PRICE columns
  if (headers.includes("FUELER") && headers.includes("TOTAL PRICE")) return "baker";
  // Everest: has ICAO, FBO, TIER, PRICE columns
  if (headers.includes("FBO") && headers.includes("TIER") && headers.includes("PRICE")) return "everest";
  // WFS (World Fuel Services): has SUPPLIER, GAL FROM, GAL TO, ESTIMATED TOTAL PRICE
  if (headers.includes("SUPPLIER") && headers.includes("ESTIMATED TOTAL PRICE")) return "wfs";
  // Avfuel/BAKAV: has FIXED BASE OPERATOR, EFF DATE, FROM, TO
  if (headers.includes("FIXED BASE OPERATOR") && headers.includes("EFF DATE")) return "avfuel";
  // Titan: has AIRPORT CODE, FBO, JET A WITH ADD PRICE PER UNIT
  if (headers.includes("AIRPORT CODE") && headers.includes("JET A WITH ADD PRICE PER UNIT")) return "titan";
  // Signature: has BASE, MIN QUANTITY, MAX QUANTITY, TOTAL
  if (headers.includes("BASE") && headers.includes("MIN QUANTITY") && headers.includes("MAX QUANTITY") && headers.includes("TOTAL")) return "signature";
  // Jet Aviation: has FBO, VOLUME TIER, PRODUCT, PRICE, TAIL NUMBERS
  if (headers.includes("VOLUME TIER") && headers.includes("TAIL NUMBERS")) return "jet_aviation";
  return "generic";
}

/** Try to extract a date from the filename */
function extractDateFromFilename(name: string): string | null {
  // YYYY-MM-DD (e.g. "2026-03-09T162604")
  const iso = name.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (iso) {
    const [, yyyy, mm, dd] = iso;
    const d = new Date(`${yyyy}-${mm}-${dd}T12:00:00`);
    if (!isNaN(d.getTime())) return d.toISOString().split("T")[0];
  }
  // YYYYMMDD (e.g. "20260304")
  const compact = name.match(/(\d{4})(\d{2})(\d{2})/);
  if (compact) {
    const [, yyyy, mm, dd] = compact;
    const d = new Date(`${yyyy}-${mm}-${dd}T12:00:00`);
    if (!isNaN(d.getTime()) && Number(mm) >= 1 && Number(mm) <= 12) return d.toISOString().split("T")[0];
  }
  // MM_DD_YYYY or MM-DD-YYYY (e.g. "Everest Fuel_03_06_2026.csv")
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

// --- Avfuel/BAKAV parser ---

function parseAvfuelCSV(lines: string[], headers: string[], vendor: string, weekStartOverride: string | null, batchId: string): PriceRow[] {
  const col = (name: string) => headers.indexOf(name);
  const icaoIdx = col("ICAO");
  const fboIdx = col("FIXED BASE OPERATOR");
  const fromIdx = col("FROM");
  const toIdx = col("TO");
  const priceIdx = col("PRICE");
  const effDateIdx = col("EFF DATE");
  const productIdx = col("PRODUCT");
  const tailIdx = col("TAIL NUMBER");

  if (icaoIdx < 0 || priceIdx < 0) return [];

  const rows: PriceRow[] = [];

  for (let i = 1; i < lines.length; i++) {
    const fields = parseCSVLine(lines[i]);
    const icao = fields[icaoIdx]?.trim().toUpperCase();
    if (!icao) continue;

    const price = parsePrice(fields[priceIdx]);
    if (price === null || price <= 0) continue;

    // Determine week_start: use override, or per-row EFF DATE
    let weekStart: string | null = null;
    if (weekStartOverride) {
      weekStart = normalizeToMonday(weekStartOverride);
    } else if (effDateIdx >= 0) {
      const effRaw = fields[effDateIdx]?.trim();
      if (effRaw) {
        weekStart = normalizeToMonday(effRaw);
      }
    }
    if (!weekStart) continue;

    const galFrom = fields[fromIdx]?.trim() || "1";
    const galTo = fields[toIdx]?.trim() || "";
    const volumeTier = galTo && galTo !== "99999" && galTo !== "999999999" ? `${galFrom}-${galTo}` : `${galFrom}+`;
    const fbo = fboIdx >= 0 ? fields[fboIdx]?.trim() || "" : "";
    const product = productIdx >= 0 ? fields[productIdx]?.trim() || "Jet-A" : "Jet-A";
    const rawTail = tailIdx >= 0 ? fields[tailIdx]?.trim() || "" : "";
    const tailNumbers = rawTail || null;

    rows.push({
      fbo_vendor: vendor,
      airport_code: icao,
      volume_tier: volumeTier,
      product: fbo ? `${product} (${fbo})` : product,
      price,
      tail_numbers: tailNumbers,
      week_start: weekStart,
      upload_batch: batchId,
    });
  }

  return rows;
}

// --- Titan Fuels parser ---

function parseTitanVolumeTier(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.toLowerCase() === "all quantities") return "1+";
  // Already formatted like "1+" or "1000+"
  if (/^\d+\+$/.test(trimmed)) return trimmed;
  // Range like "0 - 249" or "250 - 499"
  const range = trimmed.match(/(\d+)\s*-\s*(\d+)/);
  if (range) {
    const from = Math.max(1, Number(range[1])); // normalize 0 to 1
    return `${from}-${range[2]}`;
  }
  return trimmed;
}

function parseTitanCSV(lines: string[], headers: string[], vendor: string, weekStart: string, batchId: string): PriceRow[] {
  const col = (name: string) => headers.indexOf(name);
  const airportIdx = col("AIRPORT CODE");
  const fboIdx = col("FBO");

  // Product column pairs: [quantity header, price header, product label]
  const productCols: [string, string, string][] = [
    ["JET A WITH ADD QUANTITY", "JET A WITH ADD PRICE PER UNIT", "Jet-A+FSII"],
    ["JET A QUANTITY", "JET A PRICE PER UNIT", "Jet-A"],
  ];

  if (airportIdx < 0) return [];

  const rows: PriceRow[] = [];

  for (let i = 1; i < lines.length; i++) {
    const fields = parseCSVLine(lines[i]);
    const airport = fields[airportIdx]?.trim().toUpperCase();
    if (!airport) continue;

    const fbo = fboIdx >= 0 ? fields[fboIdx]?.trim() || "" : "";

    // Try Jet A with additive first, fall back to plain Jet A
    for (const [qtyHeader, priceHeader, productLabel] of productCols) {
      const qtyIdx = col(qtyHeader);
      const priceIdx = col(priceHeader);
      if (qtyIdx < 0 || priceIdx < 0) continue;

      const price = parsePrice(fields[priceIdx]);
      if (price === null || price <= 0) continue;

      const volumeTier = parseTitanVolumeTier(fields[qtyIdx] || "");

      rows.push({
        fbo_vendor: vendor,
        airport_code: airport,
        volume_tier: volumeTier,
        product: fbo ? `${productLabel} (${fbo})` : productLabel,
        price,
        tail_numbers: null,
        week_start: weekStart,
        upload_batch: batchId,
      });
      break; // prefer first match (Jet-A+FSII over plain Jet-A)
    }
  }

  return rows;
}

// --- Signature Flight Support parser ---

function parseSignatureCSV(lines: string[], headers: string[], vendor: string, weekStart: string, batchId: string): PriceRow[] {
  const col = (name: string) => headers.indexOf(name);
  const baseIdx = col("BASE");
  const tailIdx = col("TAIL NUMBER");
  const minQtyIdx = col("MIN QUANTITY");
  const maxQtyIdx = col("MAX QUANTITY");
  const totalIdx = col("TOTAL");

  if (baseIdx < 0 || totalIdx < 0) return [];

  const rows: PriceRow[] = [];

  for (let i = 1; i < lines.length; i++) {
    const fields = parseCSVLine(lines[i]);
    const rawBase = fields[baseIdx]?.trim().toUpperCase();
    if (!rawBase) continue;
    // Strip trailing digits only from 4+ char codes (3 letters + digit suffix)
    // e.g. SAT2→SAT, TEB4→TEB, but keep AP3, DA5, BU1, SU2 as-is
    const base = /^[A-Z]{3}\d+$/.test(rawBase) ? rawBase.replace(/\d+$/, "") : rawBase;

    const price = parsePrice(fields[totalIdx]);
    if (price === null || price <= 0) continue;

    const minQty = fields[minQtyIdx]?.trim().replace(/\.0$/, "") || "1";
    const maxQty = fields[maxQtyIdx]?.trim().replace(/\.0$/, "") || "";
    const volumeTier = maxQty && maxQty !== "999999" && maxQty !== "999999999" ? `${minQty}-${maxQty}` : `${minQty}+`;
    const rawTail = tailIdx >= 0 ? fields[tailIdx]?.trim() || "" : "";
    const tailNumbers = rawTail || null;

    rows.push({
      fbo_vendor: vendor,
      airport_code: base,
      volume_tier: volumeTier,
      product: "Jet-A",
      price,
      tail_numbers: tailNumbers,
      week_start: weekStart,
      upload_batch: batchId,
    });
  }

  return rows;
}

// --- Jet Aviation parser ---

function parseJetAviationCSV(lines: string[], headers: string[], vendor: string, weekStart: string, batchId: string): PriceRow[] {
  const col = (name: string) => headers.indexOf(name);
  const fboIdx = col("FBO");
  const tierIdx = col("VOLUME TIER");
  const productIdx = col("PRODUCT");
  const priceIdx = col("PRICE");
  const tailIdx = col("TAIL NUMBERS");

  if (fboIdx < 0 || priceIdx < 0) return [];

  const rows: PriceRow[] = [];
  let lastAirport = "";

  for (let i = 1; i < lines.length; i++) {
    const fields = parseCSVLine(lines[i]);
    // FBO column is the airport ICAO — blank means same airport as previous row
    const rawAirport = fields[fboIdx]?.trim().toUpperCase();
    if (rawAirport) lastAirport = rawAirport;
    if (!lastAirport) continue;

    const price = parsePrice(fields[priceIdx]);
    if (price === null || price <= 0) continue;

    // Volume tier: strip commas from numbers, normalize format
    const rawTier = (fields[tierIdx] || "").replace(/,/g, "").trim();
    let volumeTier = "1+";
    if (rawTier) {
      const range = rawTier.match(/(\d+)\s*-\s*(\d+)/);
      if (range) {
        volumeTier = `${Math.max(1, Number(range[1]))}-${range[2]}`;
      } else if (/^\d+\+/.test(rawTier)) {
        volumeTier = rawTier.replace(/\s/g, "");
      } else {
        volumeTier = rawTier;
      }
    }

    const product = fields[productIdx]?.trim() || "Jet A";
    // Skip SAF rows — only import Jet A
    if (product.toUpperCase().includes("SAF")) continue;
    const rawTails = fields[tailIdx]?.trim() || "";
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

const MONTH_ABBR: Record<string, string> = {
  JAN: "01", FEB: "02", MAR: "03", APR: "04", MAY: "05", JUN: "06",
  JUL: "07", AUG: "08", SEP: "09", OCT: "10", NOV: "11", DEC: "12",
};

/** Parse various date formats into YYYY-MM-DD */
function parseDate(raw: string): string | null {
  // DD-Mon-YY (e.g. "02-Mar-26")
  const abbr = raw.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{2})$/);
  if (abbr) {
    const [, dd, mon, yy] = abbr;
    const mm = MONTH_ABBR[mon.toUpperCase()];
    if (mm) return `20${yy}-${mm}-${dd.padStart(2, "0")}`;
  }
  // DD-Mon-YYYY (e.g. "02-Mar-2026")
  const abbrFull = raw.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/);
  if (abbrFull) {
    const [, dd, mon, yyyy] = abbrFull;
    const mm = MONTH_ABBR[mon.toUpperCase()];
    if (mm) return `${yyyy}-${mm}-${dd.padStart(2, "0")}`;
  }
  // M/D/YYYY or MM/DD/YYYY (e.g. "3/3/2026")
  const slash = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (slash) {
    const [, mm, dd, yyyy] = slash;
    return `${yyyy}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`;
  }
  // Already ISO or parseable by Date
  const d = new Date(raw + "T12:00:00");
  if (!isNaN(d.getTime())) return d.toISOString().split("T")[0];
  return null;
}

/** Normalize a date string to the Monday of that week (YYYY-MM-DD) */
function normalizeToMonday(raw: string): string | null {
  const iso = parseDate(raw);
  if (!iso) return null;
  const d = new Date(iso + "T12:00:00");
  if (isNaN(d.getTime())) return null;
  const day = d.getDay(); // 0=Sun, 1=Mon, ...
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  return d.toISOString().split("T")[0];
}
