import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { getSheetDataFromSpreadsheet, listSheetsFromSpreadsheet } from "@/lib/googleSheets";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const HIRING_SHEET_ID = "1SvFOdwjKKEf6i_3ce1mSbTUTJ0elulUIoSTzM1qMbr0";
const TARGET_GID = 1175474762;

const PIC_SOFT_GATE_TT = 3000;
const PIC_SOFT_GATE_PIC = 1500;

function verifyCronSecret(req: NextRequest): boolean {
  const secret = req.headers.get("authorization")?.replace("Bearer ", "");
  return secret === process.env.CRON_SECRET;
}

function parseHours(val: unknown): number | null {
  if (val == null || val === "") return null;
  const n = Number(String(val).replace(/,/g, "").trim());
  return isNaN(n) ? null : n;
}

function mapCategory(position: string | null): string {
  if (!position) return "other";
  const lower = position.toLowerCase();
  if (lower.includes("captain") || lower.includes("pic")) return "pilot_pic";
  if (lower.includes("sic") || lower.includes("first officer") || lower.includes("fo")) return "pilot_sic";
  if (lower.includes("maintenance") || lower.includes("mechanic")) return "maintenance";
  if (lower.includes("dispatch")) return "dispatcher";
  return "other";
}

function hasCitationX(ce750Answer: string | null, otherTypes: string | null): boolean {
  if (ce750Answer && /yes/i.test(ce750Answer)) return true;
  if (otherTypes) {
    const lower = otherTypes.toLowerCase();
    if (lower.includes("ce-750") || lower.includes("c750") || lower.includes("citation x")) return true;
  }
  return false;
}

function hasChallenger300(cl30Answer: string | null, otherTypes: string | null): boolean {
  if (cl30Answer && /yes/i.test(cl30Answer)) return true;
  if (otherTypes) {
    const lower = otherTypes.toLowerCase();
    if (lower.includes("cl-30") || lower.includes("cl30") || lower.includes("challenger 3")) return true;
  }
  return false;
}

/** Build the enrichment payload from a sheet row. */
function buildSheetProfile(r: unknown[], ix: Record<string, number>) {
  const firstName = String(r[ix.firstName] ?? "").trim();
  const lastName = String(r[ix.lastName] ?? "").trim();
  const email = String(r[ix.email] ?? "").trim().toLowerCase();
  const candidateName = `${firstName} ${lastName}`.trim();

  const phone = ix.phone !== -1 ? String(r[ix.phone] ?? "").trim() || null : null;
  const address = ix.address !== -1 ? String(r[ix.address] ?? "").trim() || null : null;
  const airport = ix.airport !== -1 ? String(r[ix.airport] ?? "").trim() || null : null;
  const location = address || airport || null;

  const totalTime = parseHours(ix.totalTime !== -1 ? r[ix.totalTime] : null);
  const turbineTime = parseHours(ix.turbineTime !== -1 ? r[ix.turbineTime] : null);
  const picTime = parseHours(ix.picTime !== -1 ? r[ix.picTime] : null);

  const ce750Answer = ix.ce750 !== -1 ? String(r[ix.ce750] ?? "") : null;
  const cl30Answer = ix.cl30 !== -1 ? String(r[ix.cl30] ?? "") : null;
  const otherTypes = ix.otherTypes !== -1 ? String(r[ix.otherTypes] ?? "").trim() || null : null;
  const position = ix.position !== -1 ? String(r[ix.position] ?? "").trim() || null : null;
  const timestamp = ix.timestamp !== -1 && r[ix.timestamp] ? String(r[ix.timestamp]) : null;

  const citX = hasCitationX(ce750Answer, otherTypes);
  const chal300 = hasChallenger300(cl30Answer, otherTypes);
  const category = mapCategory(position);

  const tt = totalTime ?? 0;
  const pic = picTime ?? 0;
  const softGateMet = tt >= PIC_SOFT_GATE_TT && pic >= PIC_SOFT_GATE_PIC;

  const typeRatings: string[] = [];
  if (citX) typeRatings.push("CE-750");
  if (chal300) typeRatings.push("CL-30");
  if (otherTypes) {
    // Split comma-separated "other type ratings" into individual entries
    for (const t of otherTypes.split(",")) {
      const trimmed = t.trim();
      if (trimmed && !typeRatings.includes(trimmed.toUpperCase())) {
        typeRatings.push(trimmed);
      }
    }
  }

  return {
    firstName, lastName, email, candidateName,
    phone, location, totalTime, turbineTime, picTime,
    citX, chal300, category, softGateMet,
    typeRatings: typeRatings.length > 0 ? typeRatings : null,
    position, timestamp,
  };
}

export async function GET(req: NextRequest) {
  if (!verifyCronSecret(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const sheets = await listSheetsFromSpreadsheet(HIRING_SHEET_ID);
    const targetSheet = sheets.find((s) => s.sheetId === TARGET_GID);
    if (!targetSheet) {
      return NextResponse.json({ error: `Sheet with gid ${TARGET_GID} not found` }, { status: 500 });
    }

    const rows = await getSheetDataFromSpreadsheet(HIRING_SHEET_ID, targetSheet.title);
    if (rows.length < 2) {
      return NextResponse.json({ ok: true, message: "No data rows", created: 0, updated: 0, skipped: 0 });
    }

    // Build header index — normalize whitespace for fuzzy matching
    const headers = (rows[0] as string[]).map((h) =>
      String(h).replace(/\s+/g, " ").trim(),
    );
    const col = (fragment: string): number => {
      const lower = fragment.toLowerCase();
      return headers.findIndex((h) => h.toLowerCase().includes(lower));
    };
    const colExact = (name: string): number => {
      const lower = name.toLowerCase();
      return headers.findIndex((h) => h.toLowerCase() === lower);
    };

    const ix = {
      firstName: col("First Name"),
      lastName: col("Last Name"),
      email: col("Email Address"),
      phone: col("Phone Number"),
      address: colExact("Address"),
      airport: col("Nearest Commercial Airport"),
      totalTime: colExact("Total Time"),
      turbineTime: col("Total Time Multiengine Turbine"),
      picTime: col("Total PIC time"),
      ce750: col("CE-750"),
      cl30: col("CL-30 Type Rating"),
      otherTypes: col("What other type ratings"),
      position: col("Position Applying For"),
      timestamp: colExact("Timestamp"),
    };

    if (ix.firstName === -1 || ix.lastName === -1 || ix.email === -1) {
      return NextResponse.json({ error: "Required columns not found", headers }, { status: 500 });
    }

    const supa = createServiceClient();

    // Fetch existing candidates keyed by email for matching
    const { data: existing } = await supa
      .from("job_application_parse")
      .select("id, email, candidate_name, total_time_hours, pic_time_hours, turbine_time_hours, has_citation_x, has_challenger_300_type_rating, category, location, phone")
      .is("deleted_at", null);

    const byEmail = new Map<string, (typeof existing extends (infer T)[] | null ? T : never)>();
    for (const row of existing ?? []) {
      if (row.email) byEmail.set(row.email.toLowerCase().trim(), row);
    }

    let created = 0;
    let updated = 0;
    let skipped = 0;
    const seenEmails = new Set<string>();
    const errors: string[] = [];

    for (let i = 1; i < rows.length; i++) {
      const r = rows[i] as unknown[];
      const profile = buildSheetProfile(r, ix);

      if (!profile.firstName && !profile.lastName) { skipped++; continue; }
      if (!profile.email) { skipped++; continue; }
      // Skip duplicate rows within the same sheet (some people submit twice)
      if (seenEmails.has(profile.email)) { skipped++; continue; }
      seenEmails.add(profile.email);

      const existingRow = byEmail.get(profile.email);

      if (existingRow) {
        // ---- UPDATE existing record with authoritative sheet data ----
        const updates: Record<string, unknown> = {};

        // Sheet has self-reported exact hours — always prefer over resume parse
        if (profile.totalTime != null) updates.total_time_hours = profile.totalTime;
        if (profile.picTime != null) updates.pic_time_hours = profile.picTime;
        if (profile.turbineTime != null) updates.turbine_time_hours = profile.turbineTime;

        // Sheet has explicit Yes/No on type ratings — authoritative
        updates.has_citation_x = profile.citX;
        updates.has_challenger_300_type_rating = profile.chal300;

        // Category from explicit "Position Applying For"
        if (profile.category !== "other") updates.category = profile.category;

        // Soft gate from the now-accurate hours
        if (profile.totalTime != null && profile.picTime != null) {
          updates.soft_gate_pic_met = profile.softGateMet;
        }

        // Fill gaps — don't overwrite if DB already has a value
        if (!existingRow.location && profile.location) updates.location = profile.location;
        if (!existingRow.phone && profile.phone) updates.phone = profile.phone;

        // Merge type ratings
        if (profile.typeRatings) updates.type_ratings = profile.typeRatings;

        // Notes: append position info
        if (profile.position) {
          updates.notes = `Position: ${profile.position}`;
        }

        updates.updated_at = new Date().toISOString();

        if (Object.keys(updates).length > 1) {
          const { error: upErr } = await supa
            .from("job_application_parse")
            .update(updates)
            .eq("id", existingRow.id);
          if (upErr) {
            errors.push(`${profile.candidateName}: update failed — ${upErr.message}`);
          } else {
            updated++;
          }
        } else {
          skipped++;
        }
      } else {
        // ---- CREATE new record ----
        try {
          const { data: appRow, error: appErr } = await supa
            .from("job_applications")
            .insert({
              mailbox: "google-form",
              role_bucket: profile.category,
              subject: `Google Form: ${profile.candidateName}`,
              received_at: profile.timestamp
                ? new Date(profile.timestamp).toISOString()
                : new Date().toISOString(),
              source_message_id: `gform-${profile.email}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            })
            .select("id")
            .single();

          if (appErr || !appRow) {
            errors.push(`${profile.candidateName}: app insert — ${appErr?.message}`);
            continue;
          }

          // Check for previous rejections
          const orClauses: string[] = [`email.eq.${profile.email}`];
          orClauses.push(`candidate_name.eq.${profile.candidateName}`);
          let previouslyRejected = false;
          const { data: rejMatches } = await supa
            .from("job_application_parse")
            .select("id")
            .or(orClauses.join(","))
            .not("rejected_at", "is", null)
            .is("deleted_at", null)
            .limit(1);
          previouslyRejected = (rejMatches?.length ?? 0) > 0;

          const { error: parseErr } = await supa
            .from("job_application_parse")
            .insert({
              application_id: appRow.id,
              candidate_name: profile.candidateName,
              email: profile.email || null,
              phone: profile.phone,
              location: profile.location,
              category: profile.category,
              total_time_hours: profile.totalTime,
              turbine_time_hours: profile.turbineTime,
              pic_time_hours: profile.picTime,
              has_citation_x: profile.citX,
              has_challenger_300_type_rating: profile.chal300,
              type_ratings: profile.typeRatings,
              soft_gate_pic_met: profile.softGateMet,
              pipeline_stage: "screening",
              model: "google-form",
              needs_review: true,
              previously_rejected: previouslyRejected,
              notes: profile.position ? `Position: ${profile.position}` : null,
            });

          if (parseErr) {
            errors.push(`${profile.candidateName}: parse insert — ${parseErr.message}`);
            continue;
          }

          created++;
        } catch (err: any) {
          errors.push(`${profile.candidateName}: ${err.message}`);
        }
      }
    }

    return NextResponse.json({
      ok: true,
      total_rows: rows.length - 1,
      created,
      updated,
      skipped,
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (err: any) {
    console.error("[hiring-sheet-sync] Error:", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
