import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, isRateLimited } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";

/**
 * POST /api/fuel-prices/advertised/upload
 *
 * Upload a CSV of FBO-advertised fuel prices.
 * FormData: file (CSV), vendor (string), week_start (date string)
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
  const vendor = (formData.get("vendor") as string | null)?.trim();
  const weekStartRaw = (formData.get("week_start") as string | null)?.trim();

  if (!file) return NextResponse.json({ error: "file is required" }, { status: 400 });
  if (!vendor) return NextResponse.json({ error: "vendor is required" }, { status: 400 });
  if (!weekStartRaw) return NextResponse.json({ error: "week_start is required" }, { status: 400 });

  if (!file.name.endsWith(".csv")) {
    return NextResponse.json({ error: "Only CSV files are accepted" }, { status: 400 });
  }
  if (file.size > 10 * 1024 * 1024) {
    return NextResponse.json({ error: "File too large (max 10MB)" }, { status: 400 });
  }

  // Normalize week_start to the Monday of that week
  const weekStart = normalizeToMonday(weekStartRaw);
  if (!weekStart) {
    return NextResponse.json({ error: "Invalid week_start date" }, { status: 400 });
  }

  const text = await file.text();
  const lines = text.split("\n").filter((l) => l.trim());

  if (lines.length < 2) {
    return NextResponse.json({ error: "CSV has no data rows" }, { status: 400 });
  }

  // Parse CSV rows
  const rows = [];
  const batchId = `adv-${Date.now()}-${auth.email}`;
  let lastAirport = "";

  for (let i = 1; i < lines.length; i++) {
    const fields = parseCSVLine(lines[i]);
    if (fields.length < 5) continue;

    // Airport may be blank on continuation rows → carry forward
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
        ignoreDuplicates: true,
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
  });
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
