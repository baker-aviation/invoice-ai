import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, isRateLimited } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";
import { parsePostFlightCSV } from "@/lib/postFlightParser";

/**
 * POST /api/fuel-planning/post-flight/upload
 *
 * Upload a JetInsight post-flight CSV.
 * FormData: file (CSV), optional flight_date (YYYY-MM-DD override)
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
  const dateOverride = (formData.get("flight_date") as string | null)?.trim() || undefined;

  if (!file) return NextResponse.json({ error: "file is required" }, { status: 400 });
  if (!file.name.endsWith(".csv")) {
    return NextResponse.json({ error: "Only CSV files are accepted" }, { status: 400 });
  }
  if (file.size > 10 * 1024 * 1024) {
    return NextResponse.json({ error: "File too large (max 10MB)" }, { status: 400 });
  }

  const text = await file.text();
  const batchId = `pf-${Date.now()}-${auth.email}`;

  const result = parsePostFlightCSV(text, batchId, dateOverride);
  if (result.error) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }
  if (result.rows.length === 0) {
    return NextResponse.json({ error: "No valid rows found in CSV" }, { status: 400 });
  }

  const supa = createServiceClient();

  // Delete existing records for the same date + batch overlap (re-upload scenario)
  const dates = [...new Set(result.rows.map((r) => r.flight_date))];
  for (const d of dates) {
    await supa.from("post_flight_data").delete().eq("flight_date", d);
  }

  // Insert in batches of 500
  let inserted = 0;
  const batchSize = 500;

  for (let i = 0; i < result.rows.length; i += batchSize) {
    const batch = result.rows.slice(i, i + batchSize);
    const { data, error } = await supa
      .from("post_flight_data")
      .upsert(batch, {
        onConflict: "tail_number,origin,destination,flight_date,segment_number",
        ignoreDuplicates: false,
      })
      .select("id");

    if (error) {
      console.error("[post-flight/upload] Supabase error:", error);
      return NextResponse.json(
        { error: "Database insert failed", detail: error.message, inserted, totalParsed: result.rows.length },
        { status: 500 },
      );
    }
    inserted += data?.length ?? 0;
  }

  // Summarize what we got
  const tails = [...new Set(result.rows.map((r) => r.tail_number))];
  const shutdownByTail: Record<string, { fuel: number; airport: string }> = {};
  for (const tail of tails) {
    const tailRows = result.rows.filter((r) => r.tail_number === tail);
    const lastLeg = tailRows[tailRows.length - 1];
    if (lastLeg?.fuel_end_lbs != null) {
      shutdownByTail[tail] = { fuel: lastLeg.fuel_end_lbs, airport: lastLeg.destination };
    }
  }

  return NextResponse.json({
    ok: true,
    inserted,
    skipped: result.skipped,
    totalParsed: result.rows.length,
    dates,
    tails,
    shutdownByTail,
    uploadBatch: batchId,
  });
}
