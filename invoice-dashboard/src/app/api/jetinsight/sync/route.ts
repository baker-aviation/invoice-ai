import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { requireAdmin, isRateLimited } from "@/lib/api-auth";
import {
  syncCrewIndex,
  syncCrewDocs,
  syncAircraftDocs,
} from "@/lib/jetinsight/scraper";

export const maxDuration = 300; // Vercel Pro: 5 min max

const BATCH_SIZE = 5; // Process 5 entities per API call

/**
 * POST /api/jetinsight/sync — Trigger a JetInsight sync
 *
 * Sync types:
 *   crew_index  — scrape crew list, match to pilot_profiles (fast, 1 request)
 *   crew_batch  — process a batch of crew doc pages + downloads (offset-based)
 *   aircraft_batch — process a batch of aircraft doc pages + downloads (offset-based)
 *   crew_docs   — single crew member (entityId required)
 *   aircraft_docs — single aircraft (entityId required)
 *   full        — crew_index + all crew_batch + all aircraft_batch (client loops)
 */
export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if ("error" in auth) return auth.error;

  if (await isRateLimited(auth.userId, 3, 10_000)) {
    return NextResponse.json(
      { error: "Too many requests. Please wait a moment." },
      { status: 429 },
    );
  }

  let body: { type?: string; entityId?: string; offset?: number };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const syncType = body.type ?? "full";
  const supa = createServiceClient();

  // Get session cookie
  const { data: cookieRow } = await supa
    .from("jetinsight_config")
    .select("config_value")
    .eq("config_key", "session_cookie")
    .single();

  const cookie = cookieRow?.config_value;
  if (!cookie) {
    return NextResponse.json(
      { error: "No session cookie configured. Paste one in the JetInsight config." },
      { status: 400 },
    );
  }

  try {
    // ── Crew index (fast — 1 request) ──────────────────────────────
    if (syncType === "crew_index") {
      const crew = await syncCrewIndex(cookie);
      return NextResponse.json({ ok: true, crew, count: crew.length });
    }

    // ── Crew batch (offset-based) ──────────────────────────────────
    if (syncType === "crew_batch") {
      const offset = body.offset ?? 0;

      // Get all pilots with JetInsight UUIDs
      const { data: profiles } = await supa
        .from("pilot_profiles")
        .select("id, jetinsight_uuid, full_name")
        .not("jetinsight_uuid", "is", null)
        .order("id")
        .range(offset, offset + BATCH_SIZE - 1);

      if (!profiles || profiles.length === 0) {
        return NextResponse.json({
          ok: true,
          done: true,
          offset,
          processed: 0,
          message: "All crew processed",
        });
      }

      let docsDownloaded = 0;
      let docsSkipped = 0;
      const errors: Array<{ entity: string; message: string }> = [];

      for (const p of profiles) {
        const result = await syncCrewDocs(
          String(p.id),
          p.jetinsight_uuid,
          cookie,
        );
        docsDownloaded += result.docsDownloaded;
        docsSkipped += result.docsSkipped;
        for (const err of result.errors) {
          errors.push({ entity: p.full_name ?? String(p.id), message: err });
        }
      }

      return NextResponse.json({
        ok: true,
        done: false,
        nextOffset: offset + profiles.length,
        processed: profiles.length,
        docsDownloaded,
        docsSkipped,
        errors,
      });
    }

    // ── Aircraft batch (offset-based) ──────────────────────────────
    if (syncType === "aircraft_batch") {
      const offset = body.offset ?? 0;

      const { data: sources } = await supa
        .from("ics_sources")
        .select("label")
        .eq("enabled", true)
        .order("label");

      const tails = (sources ?? [])
        .map((s) => s.label)
        .filter((l): l is string => !!l && l.startsWith("N"));

      const batch = tails.slice(offset, offset + BATCH_SIZE);

      if (batch.length === 0) {
        return NextResponse.json({
          ok: true,
          done: true,
          offset,
          processed: 0,
          message: "All aircraft processed",
        });
      }

      let docsDownloaded = 0;
      let docsSkipped = 0;
      const errors: Array<{ entity: string; message: string }> = [];

      for (const tail of batch) {
        const result = await syncAircraftDocs(tail, cookie);
        docsDownloaded += result.docsDownloaded;
        docsSkipped += result.docsSkipped;
        for (const err of result.errors) {
          errors.push({ entity: tail, message: err });
        }
      }

      return NextResponse.json({
        ok: true,
        done: false,
        nextOffset: offset + batch.length,
        processed: batch.length,
        total: tails.length,
        docsDownloaded,
        docsSkipped,
        errors,
      });
    }

    // ── Single crew member ─────────────────────────────────────────
    if (syncType === "crew_docs" && body.entityId) {
      const { data: profile } = await supa
        .from("pilot_profiles")
        .select("id, jetinsight_uuid")
        .eq("id", body.entityId)
        .single();

      if (!profile?.jetinsight_uuid) {
        return NextResponse.json(
          { error: "Pilot not linked to JetInsight" },
          { status: 400 },
        );
      }

      const result = await syncCrewDocs(
        String(profile.id),
        profile.jetinsight_uuid,
        cookie,
      );
      return NextResponse.json({ ok: true, result });
    }

    // ── Single aircraft ────────────────────────────────────────────
    if (syncType === "aircraft_docs" && body.entityId) {
      const result = await syncAircraftDocs(body.entityId, cookie);
      return NextResponse.json({ ok: true, result });
    }

    return NextResponse.json(
      { error: `Unknown sync type: ${syncType}` },
      { status: 400 },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[jetinsight/sync] error:", msg);

    if (msg === "SESSION_EXPIRED") {
      return NextResponse.json(
        { error: "JetInsight session expired. Please paste a new cookie." },
        { status: 401 },
      );
    }

    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
