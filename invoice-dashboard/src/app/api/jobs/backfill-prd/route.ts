import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

function verifyCronSecret(req: NextRequest): boolean {
  const secret = req.headers.get("authorization")?.replace("Bearer ", "");
  return secret === process.env.CRON_SECRET;
}

/**
 * GET /api/jobs/backfill-prd
 * One-time backfill: parse all PRD files that haven't been parsed yet.
 * Protected by CRON_SECRET.
 */
export async function GET(req: NextRequest) {
  if (!verifyCronSecret(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supa = createServiceClient();

  // Find all PRD files
  const { data: prdFiles } = await supa
    .from("job_application_files")
    .select("application_id, filename")
    .eq("file_category", "prd")
    .order("created_at", { ascending: true });

  if (!prdFiles || prdFiles.length === 0) {
    return NextResponse.json({ ok: true, message: "No PRD files found", parsed: 0 });
  }

  // Get unique application IDs
  const uniqueAppIds = [...new Set(prdFiles.map((f) => f.application_id))];

  // Check which have already been parsed
  const { data: parseRows } = await supa
    .from("job_application_parse")
    .select("application_id, prd_parsed_at")
    .in("application_id", uniqueAppIds)
    .is("deleted_at", null);

  const alreadyParsed = new Set(
    (parseRows ?? []).filter((p) => p.prd_parsed_at).map((p) => p.application_id),
  );

  const needsParse = uniqueAppIds.filter((id) => !alreadyParsed.has(id));

  if (needsParse.length === 0) {
    return NextResponse.json({ ok: true, message: "All PRDs already parsed", parsed: 0 });
  }

  // Parse each one sequentially (to avoid overwhelming OpenAI)
  const origin = new URL(req.url).origin;
  let parsed = 0;
  const errors: string[] = [];

  for (const appId of needsParse) {
    try {
      const res = await fetch(`${origin}/api/jobs/${appId}/parse-prd`, {
        method: "POST",
        headers: {
          authorization: req.headers.get("authorization") ?? "",
          // Use cron secret as admin auth bypass — the parse route uses requireAdmin
          // So we pass it along; if the parse route rejects, that's fine
          cookie: req.headers.get("cookie") ?? "",
        },
      });
      const data = await res.json();
      if (data.ok) {
        parsed++;
        console.log(`[backfill-prd] Parsed app ${appId}`);
      } else {
        errors.push(`${appId}: ${data.error}`);
        console.error(`[backfill-prd] Failed app ${appId}:`, data.error);
      }
    } catch (err: any) {
      errors.push(`${appId}: ${err.message}`);
    }
  }

  return NextResponse.json({
    ok: true,
    total_prd_files: prdFiles.length,
    needed_parse: needsParse.length,
    parsed,
    errors: errors.length > 0 ? errors : undefined,
  });
}
