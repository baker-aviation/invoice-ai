import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin, isAuthed } from "@/lib/api-auth";
import { getSheetData } from "@/lib/googleSheets";
import { validateRawSheetData } from "@/lib/sheetValidation";

export const dynamic = "force-dynamic";

const RequestSchema = z.object({
  sheet_name: z.string().min(1),
});

/**
 * POST /api/crew/validate-sheet
 * Validates a weekly swap tab's raw data before parsing/optimization.
 */
export async function POST(req: NextRequest) {
  const serviceKey = req.headers.get("x-service-key");
  const envKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const isServiceAuth = serviceKey && envKey && serviceKey.trim() === envKey.trim();
  if (!isServiceAuth) {
    const auth = await requireAdmin(req);
    if (!isAuthed(auth)) return auth.error;
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = RequestSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: "Validation failed", details: parsed.error.issues }, { status: 400 });
  }

  try {
    const rows = await getSheetData(parsed.data.sheet_name);
    const result = validateRawSheetData(rows, parsed.data.sheet_name);

    return NextResponse.json({
      valid: result.valid,
      errors: result.errors,
      warnings: result.warnings,
      row_count: rows.length,
      sheet_name: parsed.data.sheet_name,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed to validate sheet" },
      { status: 500 },
    );
  }
}
