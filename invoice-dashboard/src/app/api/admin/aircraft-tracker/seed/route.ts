import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { requireSuperAdmin, isAuthed } from "@/lib/api-auth";
import * as XLSX from "xlsx";
import { readFileSync } from "fs";
import { join } from "path";

function getServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Missing Supabase config");
  return createClient(url, key);
}

/** Convert Excel serial date number → ISO date string */
function excelDateToISO(serial: number): string {
  // Excel epoch is 1900-01-01 but has a leap year bug (day 60 = Feb 29, 1900)
  const epoch = new Date(1899, 11, 30); // Dec 30, 1899
  const ms = epoch.getTime() + serial * 86400000;
  return new Date(ms).toISOString().split("T")[0];
}

// Column indices in the "Aircraft Tracker" sheet (0-based, after tail_number at 0)
const TRACKER_COLS = [
  "tail_number",        // 0
  "aircraft_type",      // 1
  "part_135_flying",    // 2
  "wb_date",            // 3
  "wb_on_jet_insight",  // 4
  "foreflight_wb_built",// 5
  "starlink_on_wb",     // 6
  "initial_foreflight_build", // 7
  "foreflight_subscription",  // 8
  "foreflight_config_built",  // 9
  "validation_complete",      // 10
  "beta_tested",              // 11
  "go_live_approved",         // 12
  "genesis_removed",          // 13
  "overall_status",           // 14
  "notes",                    // 15
] as const;

export async function POST(req: NextRequest) {
  const auth = await requireSuperAdmin(req);
  if (!isAuthed(auth)) return auth.error;

  try {
    // Read the Excel file from the public directory
    const filePath = join(process.cwd(), "public", "Charlies Examples", "Aircraft Tracker.xlsx");
    const fileBuffer = readFileSync(filePath);
    const workbook = XLSX.read(fileBuffer, { type: "buffer" });

    // ── Parse "Aircraft Tracker" sheet ──────────────────────────────────────
    const trackerSheet = workbook.Sheets["Aircraft Tracker"];
    if (!trackerSheet) {
      return NextResponse.json({ error: "Sheet 'Aircraft Tracker' not found" }, { status: 400 });
    }

    const trackerRows: unknown[][] = XLSX.utils.sheet_to_json(trackerSheet, {
      header: 1,
      defval: null,
    });

    // Skip header row (index 0), filter rows with a tail_number
    const aircraft: Record<string, string | null>[] = [];

    for (let i = 1; i < trackerRows.length; i++) {
      const row = trackerRows[i];
      if (!row || !row[0] || String(row[0]).trim() === "") continue;

      const record: Record<string, string | null> = {};

      for (let c = 0; c < TRACKER_COLS.length; c++) {
        const col = TRACKER_COLS[c];
        let val = row[c] ?? null;

        if (val === null || val === undefined) {
          record[col] = null;
        } else if (col === "wb_date" && typeof val === "number") {
          // Convert Excel serial date to ISO string
          record[col] = excelDateToISO(val);
        } else {
          record[col] = String(val).trim();
        }
      }

      // Handle extra columns (17+) — append to notes
      if (row.length > TRACKER_COLS.length) {
        const extras: string[] = [];
        for (let c = TRACKER_COLS.length; c < row.length; c++) {
          if (row[c] != null && String(row[c]).trim() !== "") {
            extras.push(String(row[c]).trim());
          }
        }
        if (extras.length > 0) {
          record.notes = [record.notes, ...extras].filter(Boolean).join(" | ");
        }
      }

      aircraft.push(record);
    }

    // ── Parse "Sheet1" for KOW callsign + Jet Insight URL ───────────────────
    const sheet1 = workbook.Sheets["Sheet1"];
    const sheet1Map = new Map<string, { kow_callsign: string | null; jet_insight_url: string | null }>();

    if (sheet1) {
      const sheet1Rows: unknown[][] = XLSX.utils.sheet_to_json(sheet1, {
        header: 1,
        defval: null,
      });

      for (const row of sheet1Rows) {
        // Sheet1 layout: col0 = KOW callsign, col1 = tail number, col2 = Jet Insight URL
        if (!row || !row[1] || String(row[1]).trim() === "") continue;
        const tail = String(row[1]).trim();
        sheet1Map.set(tail, {
          kow_callsign: row[0] ? String(row[0]).trim() : null,
          jet_insight_url: row[2] ? String(row[2]).trim() : null,
        });
      }
    }

    // ── Merge Sheet1 data into aircraft records ─────────────────────────────
    for (const record of aircraft) {
      const extra = sheet1Map.get(record.tail_number!);
      if (extra) {
        record.kow_callsign = extra.kow_callsign;
        record.jet_insight_url = extra.jet_insight_url;
      }
    }

    // ── Upsert into Supabase ────────────────────────────────────────────────
    const sb = getServiceClient();
    const { data, error } = await sb
      .from("aircraft_tracker")
      .upsert(aircraft, { onConflict: "tail_number" })
      .select();

    if (error) {
      console.error("Seed upsert error:", error);
      return NextResponse.json({ error: "Database upsert failed", details: error.message }, { status: 500 });
    }

    return NextResponse.json({ ok: true, count: data?.length ?? 0 });
  } catch (err) {
    console.error("Seed error:", err);
    return NextResponse.json(
      { error: "Failed to seed data", details: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 },
    );
  }
}
