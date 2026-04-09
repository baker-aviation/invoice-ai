import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";
import { buildSubject } from "@/lib/fbo-fee-request-email";

/**
 * POST /api/fbo-fees/queue-all
 *
 * Queues draft fee request rows for every FBO that:
 *   - has an email address
 *   - hasn't already been queued/sent
 *
 * Deduplicates by airport_code + normalized chain so we don't email
 * the same FBO twice (e.g. "Atlantic Aviation" and "Atlantic Aviation TEB").
 *
 * Body: { batchId?: string }
 */
export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if ("error" in auth) return auth.error;

  const body = await req.json().catch(() => ({}));
  const batchId = body.batchId || `batch_${Date.now()}`;
  const aircraftTypes = ["Challenger 300", "Citation X"];

  const supa = createServiceClient();

  // Get all FBOs with email
  const { data: fbos } = await supa
    .from("fbo_handling_fees")
    .select("airport_code, fbo_name, email")
    .neq("email", "")
    .not("email", "is", null)
    .order("airport_code");

  if (!fbos?.length) {
    return NextResponse.json({ error: "No FBOs with email found" }, { status: 404 });
  }

  // Get already queued/sent airports+emails to skip
  const { data: existing } = await supa
    .from("fbo_fee_requests")
    .select("airport_code, fbo_email")
    .in("status", ["draft", "sent", "replied", "parsed"]);

  const alreadySent = new Set(
    (existing || []).map((r) => `${r.airport_code}|${r.fbo_email.toLowerCase()}`),
  );

  // Deduplicate: one email per airport+email combo (not per aircraft type or name variant)
  const seen = new Set<string>();
  const toQueue: Array<{ airport_code: string; fbo_name: string; fbo_email: string }> = [];

  for (const fbo of fbos) {
    const key = `${fbo.airport_code}|${fbo.email.toLowerCase()}`;
    if (seen.has(key) || alreadySent.has(key)) continue;
    seen.add(key);
    toQueue.push({
      airport_code: fbo.airport_code,
      fbo_name: fbo.fbo_name,
      fbo_email: fbo.email,
    });
  }

  if (!toQueue.length) {
    return NextResponse.json({ ok: true, queued: 0, message: "All FBOs already queued or sent" });
  }

  // Batch insert drafts
  const rows = toQueue.map((t) => ({
    airport_code: t.airport_code,
    fbo_name: t.fbo_name,
    fbo_email: t.fbo_email,
    aircraft_types: aircraftTypes,
    status: "draft",
    subject: buildSubject({ ...t, aircraft_types: aircraftTypes }),
    batch_id: batchId,
  }));

  // Insert in chunks of 500
  let inserted = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const { error } = await supa.from("fbo_fee_requests").insert(chunk);
    if (error) {
      return NextResponse.json({
        error: `Insert failed at chunk ${i}: ${error.message}`,
        inserted,
      }, { status: 500 });
    }
    inserted += chunk.length;
  }

  return NextResponse.json({
    ok: true,
    batchId,
    queued: inserted,
    skippedAlreadySent: alreadySent.size,
    totalFbosWithEmail: fbos.length,
  });
}
