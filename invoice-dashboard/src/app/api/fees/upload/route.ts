import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, isRateLimited } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";

/**
 * POST /api/fees/upload — upload an expense CSV
 *
 * Parses the CSV, deduplicates against existing rows (same date+airport+vendor+amount),
 * and inserts only new rows. Returns counts of inserted vs skipped.
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
  if (!file) {
    return NextResponse.json({ error: "file is required" }, { status: 400 });
  }

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

  // Parse CSV
  const rows = [];
  const batchId = `upload-${Date.now()}-${auth.email}`;

  for (let i = 1; i < lines.length; i++) {
    const fields = parseCSVLine(lines[i]);
    if (fields.length < 11) continue;

    const amount = parseAmount(fields[9]);
    if (amount === null || amount <= 0) continue;

    const dateStr = fields[0];
    const expenseDate = parseDate(dateStr);
    if (!expenseDate) continue;

    const airport = fields[4] === "null" ? "" : fields[4];
    const fbo = fields[5] === "null" ? "" : fields[5];

    rows.push({
      expense_date: expenseDate,
      vendor: fields[1] || "",
      category: fields[2] || "",
      receipts: fields[3] || "",
      airport,
      fbo,
      bill_to: fields[6] === "Not set" ? "" : (fields[6] || ""),
      created_by: fields[7] || "",
      gallons: parseGallons(fields[8]),
      amount,
      repeats: fields[10] || "No",
      upload_batch: batchId,
    });
  }

  if (rows.length === 0) {
    return NextResponse.json({ error: "No valid rows found in CSV" }, { status: 400 });
  }

  const supa = createServiceClient();

  // Insert in batches of 500, using upsert with ignoreDuplicates
  let inserted = 0;
  let skipped = 0;
  const batchSize = 500;

  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    const { data, error } = await supa
      .from("expenses")
      .upsert(batch, {
        onConflict: "idx_expenses_dedup",
        ignoreDuplicates: true,
        count: "exact",
      })
      .select("id");

    if (error) {
      console.error("[fees/upload] Supabase error:", error);
      return NextResponse.json(
        {
          error: "Database insert failed",
          inserted,
          skipped,
          totalParsed: rows.length,
        },
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

// --- CSV parsing helpers (same logic as old route) ---

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

function parseAmount(raw: string): number | null {
  if (!raw || raw === "null" || raw === "TBD" || raw === "N/A") return null;
  const cleaned = raw.replace(/[$,]/g, "").trim();
  const num = parseFloat(cleaned);
  return isNaN(num) ? null : num;
}

function parseGallons(raw: string): number | null {
  if (!raw || raw === "null") return null;
  const num = parseFloat(raw.replace(/,/g, ""));
  return isNaN(num) ? null : num;
}

/** Parse "MM/DD/YY" or "MM/DD/YYYY" → "YYYY-MM-DD" */
function parseDate(raw: string): string | null {
  const parts = raw.split("/");
  if (parts.length !== 3) return null;
  let [mm, dd, yy] = parts;
  if (yy.length === 2) yy = `20${yy}`;
  const d = new Date(`${yy}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`);
  if (isNaN(d.getTime())) return null;
  return d.toISOString().split("T")[0];
}
