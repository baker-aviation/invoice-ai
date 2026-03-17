/**
 * Shared fuel price CSV parsers.
 * Used by both the manual upload route and the automatic mailbox pull route.
 */

export type PriceRow = {
  fbo_vendor: string;
  airport_code: string;
  volume_tier: string;
  product: string;
  price: number;
  tail_numbers: string | null;
  week_start: string;
  upload_batch: string;
};

export type FuelFormat = "baker" | "everest" | "wfs" | "avfuel" | "titan" | "signature" | "signature_v2" | "jet_aviation" | "atlantic" | "evo" | "generic";

export type ParseResult = {
  rows: PriceRow[];
  vendor: string;
  format: FuelFormat;
  error?: string;
};

/**
 * Parse a fuel price CSV and return normalized rows.
 * This is the main entry point — detects format, parses, normalizes vendor name.
 */
export function parseFuelCSV(
  csvText: string,
  filename: string,
  batchId: string,
  vendorOverride?: string | null,
  weekStartRaw?: string | null,
): ParseResult {
  const lines = csvText.split("\n").filter((l) => l.trim());
  if (lines.length < 2) return { rows: [], vendor: "", format: "generic", error: "CSV has no data rows" };

  const headerFields = parseCSVLine(lines[0]).map((h) => h.toUpperCase().trim());
  const format = detectFormat(headerFields);

  let rows: PriceRow[];
  let detectedVendor: string | null = null;

  if (format === "baker") {
    detectedVendor = "AEG Fuels";
    let weekStart = resolveWeekStart(weekStartRaw ?? null, filename);
    if (!weekStart) weekStart = extractMostRecentDate(lines, headerFields, "UPDATED");
    if (!weekStart) return { rows: [], vendor: detectedVendor, format, error: "Could not determine week_start" };
    rows = parseBakerCSV(lines, headerFields, vendorOverride ?? detectedVendor, weekStart, batchId);
  } else if (format === "everest") {
    detectedVendor = "Everest Fuel";
    const weekStart = resolveWeekStart(weekStartRaw ?? null, filename);
    if (!weekStart) return { rows: [], vendor: detectedVendor, format, error: "Could not determine week_start" };
    rows = parseEverestCSV(lines, headerFields, vendorOverride ?? detectedVendor, weekStart, batchId);
  } else if (format === "wfs") {
    detectedVendor = "World Fuel Services";
    const wfsWeekStart = resolveWeekStart(weekStartRaw ?? null, filename);
    rows = parseWfsCSV(lines, headerFields, vendorOverride ?? detectedVendor, wfsWeekStart ?? weekStartRaw ?? null, batchId);
  } else if (format === "avfuel") {
    detectedVendor = "Avfuel";
    const avfuelWeekStart = resolveWeekStart(weekStartRaw ?? null, filename);
    rows = parseAvfuelCSV(lines, headerFields, vendorOverride ?? detectedVendor, avfuelWeekStart ?? weekStartRaw ?? null, batchId);
  } else if (format === "titan") {
    detectedVendor = "Titan Fuels";
    const weekStart = resolveWeekStart(weekStartRaw ?? null, filename);
    if (!weekStart) return { rows: [], vendor: detectedVendor, format, error: "Could not determine week_start" };
    rows = parseTitanCSV(lines, headerFields, vendorOverride ?? detectedVendor, weekStart, batchId);
  } else if (format === "signature") {
    detectedVendor = "Signature Flight Support";
    const weekStart = resolveWeekStart(weekStartRaw ?? null, filename);
    if (!weekStart) return { rows: [], vendor: detectedVendor, format, error: "Could not determine week_start" };
    rows = parseSignatureCSV(lines, headerFields, vendorOverride ?? detectedVendor, weekStart, batchId);
  } else if (format === "signature_v2") {
    detectedVendor = "Signature Flight Support";
    const weekStart = resolveWeekStart(weekStartRaw ?? null, filename);
    if (!weekStart) return { rows: [], vendor: detectedVendor, format, error: "Could not determine week_start" };
    rows = parseJetAviationCSV(lines, headerFields, vendorOverride ?? detectedVendor, weekStart, batchId);
  } else if (format === "jet_aviation") {
    detectedVendor = "Jet Aviation";
    const weekStart = resolveWeekStart(weekStartRaw ?? null, filename);
    if (!weekStart) return { rows: [], vendor: detectedVendor, format, error: "Could not determine week_start" };
    rows = parseJetAviationCSV(lines, headerFields, vendorOverride ?? detectedVendor, weekStart, batchId);
  } else if (format === "evo") {
    detectedVendor = "EVO";
    const evoWeekStart = resolveWeekStart(weekStartRaw ?? null, filename);
    rows = parseEvoCSV(lines, headerFields, vendorOverride ?? detectedVendor, evoWeekStart ?? weekStartRaw ?? null, batchId);
  } else if (format === "atlantic") {
    detectedVendor = "Atlantic Aviation";
    const weekStart = resolveWeekStart(weekStartRaw ?? null, filename);
    if (!weekStart) return { rows: [], vendor: detectedVendor, format, error: "Could not determine week_start" };
    rows = parseAtlanticCSV(lines, headerFields, vendorOverride ?? detectedVendor, weekStart, batchId);
  } else {
    if (!vendorOverride) return { rows: [], vendor: "", format, error: "vendor is required for this CSV format" };
    if (!weekStartRaw) return { rows: [], vendor: vendorOverride, format, error: "week_start is required for this CSV format" };
    const weekStart = normalizeToMonday(weekStartRaw);
    if (!weekStart) return { rows: [], vendor: vendorOverride, format, error: "Invalid week_start date" };
    rows = parseGenericCSV(lines, vendorOverride, weekStart, batchId);
    detectedVendor = vendorOverride;
  }

  const vendor = normalizeVendorName(vendorOverride ?? detectedVendor ?? "");
  for (const row of rows) {
    row.fbo_vendor = vendor;
  }

  return { rows, vendor, format };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Format detection
// ═══════════════════════════════════════════════════════════════════════════════

export function detectFormat(headers: string[]): FuelFormat {
  if (headers.includes("FUELER") && headers.includes("TOTAL PRICE")) return "baker";
  if (headers.includes("BASE_PRICE") && headers.includes("TOTAL PRICE USD")) return "evo";
  if (headers.includes("FBO") && headers.includes("TIER") && headers.includes("PRICE")) return "everest";
  if (headers.includes("SUPPLIER") && headers.includes("ESTIMATED TOTAL PRICE")) return "wfs";
  if (headers.includes("FIXED BASE OPERATOR") && headers.includes("EFF DATE")) return "avfuel";
  if (headers.includes("AIRPORT CODE") && headers.includes("JET A WITH ADD PRICE PER UNIT")) return "titan";
  if (headers.includes("BASE") && headers.includes("MIN QUANTITY") && headers.includes("MAX QUANTITY") && headers.includes("TOTAL")) return "signature";
  // New Signature format (v2): has FBO + PRODUCT columns (Jet Aviation format lacks PRODUCT or uses different headers)
  if (headers.includes("FBO") && headers.includes("VOLUME TIER") && headers.includes("PRODUCT") && headers.includes("TAIL NUMBERS")) return "signature_v2";
  if (headers.includes("VOLUME TIER") && headers.includes("TAIL NUMBERS")) return "jet_aviation";
  if (headers.includes("AIRPORTCODE") && headers.includes("CUSTOMEROTDPRICE")) return "atlantic";
  return "generic";
}

// ═══════════════════════════════════════════════════════════════════════════════
// Individual vendor parsers
// ═══════════════════════════════════════════════════════════════════════════════

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
    if (price === null || price <= 0) continue;
    const minGal = fields[minGalIdx]?.trim() || "1";
    const maxGal = fields[maxGalIdx]?.trim() || "";
    const volumeTier = maxGal && maxGal !== "99999" ? `${minGal}-${maxGal}` : `${minGal}+`;
    const fueler = fuelerIdx >= 0 ? fields[fuelerIdx]?.trim() || "" : "";
    rows.push({
      fbo_vendor: vendor,
      airport_code: normalizeAirportCode(icao),
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
      airport_code: normalizeAirportCode(icao),
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
    // Skip placeholder prices (99999 = "call for quote") and sub-$2 tax-only rows
    if (price < 2 || price > 50) continue;
    let weekStart: string | null = null;
    if (weekStartOverride) {
      weekStart = normalizeToMonday(weekStartOverride);
    } else if (expDateIdx >= 0) {
      const expRaw = fields[expDateIdx]?.trim();
      if (expRaw) weekStart = normalizeToMonday(expRaw);
    }
    if (!weekStart) continue;
    const galFrom = fields[galFromIdx]?.trim() || "1";
    const galTo = fields[galToIdx]?.trim() || "";
    const volumeTier = galTo && galTo !== "999999999" ? `${galFrom}-${galTo}` : `${galFrom}+`;
    const supplier = supplierIdx >= 0 ? fields[supplierIdx]?.trim() || "" : "";
    rows.push({
      fbo_vendor: vendor,
      airport_code: normalizeAirportCode(icao),
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
    let weekStart: string | null = null;
    if (weekStartOverride) {
      weekStart = normalizeToMonday(weekStartOverride);
    } else if (effDateIdx >= 0) {
      const effRaw = fields[effDateIdx]?.trim();
      if (effRaw) weekStart = normalizeToMonday(effRaw);
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
      airport_code: normalizeAirportCode(icao),
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

function parseTitanVolumeTier(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.toLowerCase() === "all quantities") return "1+";
  if (/^\d+\+$/.test(trimmed)) return trimmed;
  const range = trimmed.match(/(\d+)\s*-\s*(\d+)/);
  if (range) {
    const from = Math.max(1, Number(range[1]));
    return `${from}-${range[2]}`;
  }
  return trimmed;
}

function parseTitanCSV(lines: string[], headers: string[], vendor: string, weekStart: string, batchId: string): PriceRow[] {
  const col = (name: string) => headers.indexOf(name);
  const airportIdx = col("AIRPORT CODE");
  const fboIdx = col("FBO");
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
    for (const [qtyHeader, priceHeader, productLabel] of productCols) {
      const qtyIdx = col(qtyHeader);
      const priceIdx = col(priceHeader);
      if (qtyIdx < 0 || priceIdx < 0) continue;
      const price = parsePrice(fields[priceIdx]);
      if (price === null || price <= 0) continue;
      const volumeTier = parseTitanVolumeTier(fields[qtyIdx] || "");
      rows.push({
        fbo_vendor: vendor,
        airport_code: normalizeAirportCode(airport),
        volume_tier: volumeTier,
        product: fbo ? `${productLabel} (${fbo})` : productLabel,
        price,
        tail_numbers: null,
        week_start: weekStart,
        upload_batch: batchId,
      });
      break;
    }
  }
  return rows;
}

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
      airport_code: normalizeAirportCode(base),
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
    const rawAirport = fields[fboIdx]?.trim().toUpperCase();
    if (rawAirport) lastAirport = rawAirport;
    if (!lastAirport) continue;
    const price = parsePrice(fields[priceIdx]);
    if (price === null || price <= 0) continue;
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
    if (product.toUpperCase().includes("SAF")) continue;
    const rawTails = fields[tailIdx]?.trim() || "";
    const tailNumbers = (!rawTails || rawTails.toLowerCase() === "all tails") ? null : rawTails;
    rows.push({
      fbo_vendor: vendor,
      airport_code: normalizeAirportCode(lastAirport),
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

function parseAtlanticCSV(lines: string[], headers: string[], vendor: string, weekStart: string, batchId: string): PriceRow[] {
  const col = (name: string) => headers.indexOf(name);
  const airportIdx = col("AIRPORTCODE");
  const productIdx = col("PRODUCT");
  const priceIdx = col("CUSTOMEROTDPRICE");
  if (airportIdx < 0 || priceIdx < 0) return [];
  const rows: PriceRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const fields = parseCSVLine(lines[i]);
    const airport = fields[airportIdx]?.trim().toUpperCase();
    if (!airport) continue;
    const price = parsePrice(fields[priceIdx]);
    if (price === null || price <= 0) continue;
    const product = fields[productIdx]?.trim() || "Jet-A";
    rows.push({
      fbo_vendor: vendor,
      airport_code: normalizeAirportCode(airport),
      volume_tier: "1+",
      product,
      price,
      tail_numbers: null,
      week_start: weekStart,
      upload_batch: batchId,
    });
  }
  return rows;
}

function parseEvoCSV(lines: string[], headers: string[], vendor: string, weekStartOverride: string | null, batchId: string): PriceRow[] {
  const col = (name: string) => headers.indexOf(name);
  const icaoIdx = col("ICAO");
  const supplierIdx = col("SUPPLIER");
  const usgFromIdx = col("USG_FROM");
  const usgToIdx = col("USG_TO");
  const totalPriceIdx = col("TOTAL PRICE USD");
  const effDateIdx = col("EFFECTIVE DATE");
  if (icaoIdx < 0 || totalPriceIdx < 0) return [];
  const rows: PriceRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const fields = parseCSVLine(lines[i]);
    const icao = fields[icaoIdx]?.trim().toUpperCase();
    if (!icao) continue;
    const price = parsePrice(fields[totalPriceIdx]);
    if (price === null || price <= 0) continue;
    let weekStart: string | null = null;
    if (weekStartOverride) {
      weekStart = normalizeToMonday(weekStartOverride);
    } else if (effDateIdx >= 0) {
      const effRaw = fields[effDateIdx]?.trim();
      if (effRaw) weekStart = normalizeToMonday(effRaw);
    }
    if (!weekStart) continue;
    const galFrom = fields[usgFromIdx]?.trim() || "1";
    const galTo = fields[usgToIdx]?.trim() || "";
    const volumeTier = galTo && galTo !== "99999" && galTo !== "999999999" ? `${galFrom}-${galTo}` : `${galFrom}+`;
    const supplier = supplierIdx >= 0 ? fields[supplierIdx]?.trim() || "" : "";
    rows.push({
      fbo_vendor: vendor,
      airport_code: normalizeAirportCode(icao),
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
      airport_code: normalizeAirportCode(lastAirport),
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

// ═══════════════════════════════════════════════════════════════════════════════
// Shared helpers
// ═══════════════════════════════════════════════════════════════════════════════

export function parseCSVLine(line: string): string[] {
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

export const VENDOR_ALIASES: Record<string, string> = {
  "signature": "Signature Flight Support",
  "sig": "Signature Flight Support",
  "sfs": "Signature Flight Support",
  "aeg": "AEG Fuels",
  "aeg fuels": "AEG Fuels",
  "wfs": "World Fuel Services",
  "world fuel": "World Fuel Services",
  "everest": "Everest Fuel",
  "titan": "Titan Fuels",
  "jet aviation": "Jet Aviation",
  "avfuel": "Avfuel",
  "atlantic": "Atlantic Aviation",
  "atlantic aviation": "Atlantic Aviation",
  "evo": "EVO",
};

export function normalizeVendorName(vendor: string): string {
  return VENDOR_ALIASES[vendor.toLowerCase().trim()] ?? vendor;
}

export function normalizeAirportCode(raw: string): string {
  const code = raw.trim().toUpperCase();
  if (!code) return code;
  if (/\d/.test(code)) return code;
  if (code.length >= 4) return code;
  if (/^[A-Z]{3}$/.test(code)) return `K${code}`;
  return code;
}

export function parsePrice(raw: string): number | null {
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

export function parseDate(raw: string): string | null {
  const abbr = raw.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{2})$/);
  if (abbr) {
    const [, dd, mon, yy] = abbr;
    const mm = MONTH_ABBR[mon.toUpperCase()];
    if (mm) return `20${yy}-${mm}-${dd.padStart(2, "0")}`;
  }
  const abbrFull = raw.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/);
  if (abbrFull) {
    const [, dd, mon, yyyy] = abbrFull;
    const mm = MONTH_ABBR[mon.toUpperCase()];
    if (mm) return `${yyyy}-${mm}-${dd.padStart(2, "0")}`;
  }
  const slash = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (slash) {
    const [, mm, dd, yyyy] = slash;
    return `${yyyy}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`;
  }
  const d = new Date(raw + "T12:00:00");
  if (!isNaN(d.getTime())) return d.toISOString().split("T")[0];
  return null;
}

export function normalizeToMonday(raw: string): string | null {
  const iso = parseDate(raw);
  if (!iso) return null;
  const d = new Date(iso + "T12:00:00");
  if (isNaN(d.getTime())) return null;
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  return d.toISOString().split("T")[0];
}

export function extractDateFromFilename(name: string): string | null {
  const iso = name.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (iso) {
    const [, yyyy, mm, dd] = iso;
    const d = new Date(`${yyyy}-${mm}-${dd}T12:00:00`);
    if (!isNaN(d.getTime())) return d.toISOString().split("T")[0];
  }
  const compact = name.match(/(\d{4})(\d{2})(\d{2})/);
  if (compact) {
    const [, yyyy, mm, dd] = compact;
    const d = new Date(`${yyyy}-${mm}-${dd}T12:00:00`);
    if (!isNaN(d.getTime()) && Number(mm) >= 1 && Number(mm) <= 12) return d.toISOString().split("T")[0];
  }
  const m = name.match(/(\d{1,2})[_-](\d{1,2})[_-](\d{4})/);
  if (m) {
    const [, mm, dd, yyyy] = m;
    const d = new Date(`${yyyy}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}T12:00:00`);
    if (!isNaN(d.getTime())) return d.toISOString().split("T")[0];
  }
  const mmddyy = name.match(/(?<!\d)(\d{2})(\d{2})(\d{2})(?!\d)/);
  if (mmddyy) {
    const [, mm2, dd2, yy] = mmddyy;
    const month = Number(mm2);
    const day = Number(dd2);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      const d = new Date(`20${yy}-${mm2}-${dd2}T12:00:00`);
      if (!isNaN(d.getTime())) return d.toISOString().split("T")[0];
    }
  }
  return null;
}

export function resolveWeekStart(raw: string | null, filename: string): string | null {
  const dateStr = raw || extractDateFromFilename(filename);
  if (!dateStr) return null;
  return normalizeToMonday(dateStr);
}

export function extractMostRecentDate(lines: string[], headers: string[], colName: string): string | null {
  const idx = headers.indexOf(colName);
  if (idx < 0) return null;
  let latest: string | null = null;
  for (let i = 1; i < lines.length; i++) {
    const fields = parseCSVLine(lines[i]);
    const raw = fields[idx]?.trim();
    if (!raw) continue;
    const iso = parseDate(raw);
    if (iso && (!latest || iso > latest)) latest = iso;
  }
  return latest ? normalizeToMonday(latest) : null;
}
