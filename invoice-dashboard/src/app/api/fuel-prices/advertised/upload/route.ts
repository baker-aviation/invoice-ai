import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, isRateLimited } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";
import { parseFuelCSV } from "@/lib/fuelParsers";

/**
 * POST /api/fuel-prices/advertised/upload
 *
 * Upload a CSV of FBO-advertised fuel prices.
 * FormData: file (CSV), vendor (string, optional for auto-detected formats),
 *           week_start (date string, optional for auto-detected formats)
 *
 * Auto-detects Baker/AEG Fuels, Everest Fuel, WFS, Avfuel, Titan, Signature,
 * Jet Aviation, EVO, Atlantic, and generic CSV formats by header row.
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
  const batchId = `adv-${Date.now()}-${auth.email}`;

  const result = parseFuelCSV(text, file.name, batchId, vendorOverride, weekStartRaw);

  if (result.error) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }
  if (result.rows.length === 0) {
    return NextResponse.json({ error: "No valid rows found in CSV" }, { status: 400 });
  }

  const supa = createServiceClient();

  // Delete old records for this vendor + week_start(s) being uploaded (preserve other weeks)
  const weekStarts = [...new Set(result.rows.map((r) => r.week_start))];
  for (const ws of weekStarts) {
    const { error: delError } = await supa
      .from("fbo_advertised_prices")
      .delete()
      .eq("fbo_vendor", result.vendor)
      .eq("week_start", ws);
    if (delError) {
      console.error(`[advertised/upload] Delete old records failed for ${result.vendor} week ${ws}:`, delError);
    }
  }

  // Insert in batches of 500
  let inserted = 0;
  let skipped = 0;
  const batchSize = 500;

  for (let i = 0; i < result.rows.length; i += batchSize) {
    const batch = result.rows.slice(i, i + batchSize);
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
        { error: "Database insert failed", inserted, skipped, totalParsed: result.rows.length },
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
    totalParsed: result.rows.length,
    uploadBatch: batchId,
    detectedFormat: result.format,
    vendor: result.vendor,
  });
}
