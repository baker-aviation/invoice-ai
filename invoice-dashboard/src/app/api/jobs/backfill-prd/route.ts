import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { requireAdmin, isAuthed, verifyCronSecret } from "@/lib/api-auth";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// One-time backfill bypass token (expires 2026-04-04T06:00:00Z)
const BACKFILL_TOKEN = "prd-backfill-2026-04-02";
const BACKFILL_EXPIRES = new Date("2026-04-04T06:00:00Z");

/**
 * GET /api/jobs/backfill-prd
 * One-time backfill: parse all PRD files that haven't been parsed yet.
 * Protected by CRON_SECRET, admin auth, or time-limited backfill token.
 */
export async function GET(req: NextRequest) {
  // Check time-limited backfill token
  const qToken = new URL(req.url).searchParams.get("token");
  let authed = qToken === BACKFILL_TOKEN && new Date() < BACKFILL_EXPIRES;

  // Check cron secret from header
  if (!authed) authed = verifyCronSecret(req);

  // Check cron secret from query param (?secret=...)
  if (!authed) {
    const qSecret = new URL(req.url).searchParams.get("secret");
    if (qSecret && process.env.CRON_SECRET && qSecret === process.env.CRON_SECRET) {
      authed = true;
    }
  }

  // Fall back to admin auth
  if (!authed) {
    const auth = await requireAdmin(req);
    if (!isAuthed(auth)) return auth.error;
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
      // Use cron secret for internal parse-prd calls
      const headers: Record<string, string> = {};
      if (process.env.CRON_SECRET) {
        headers.authorization = `Bearer ${process.env.CRON_SECRET}`;
      }
      const cookie = req.headers.get("cookie");
      if (cookie) headers.cookie = cookie;
      const res = await fetch(`${origin}/api/jobs/${appId}/parse-prd`, {
        method: "POST",
        headers,
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
