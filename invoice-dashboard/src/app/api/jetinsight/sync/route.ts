import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { requireAdmin, isRateLimited } from "@/lib/api-auth";
import {
  syncCrewIndex,
  syncCrewDocs,
  syncAircraftDocs,
  syncCompanyDocs,
} from "@/lib/jetinsight/scraper";
import { runScheduleSync } from "@/lib/jetinsight/schedule-sync";
import { syncTripDocs } from "@/lib/jetinsight/trip-sync";
import { syncPostFlightData } from "@/lib/jetinsight/postflight-sync";

export const maxDuration = 300; // Vercel Pro: 5 min max

const BATCH_SIZE = 3; // Process 3 entities per API call (fits in 300s Vercel limit)

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

  // No rate limit during batch syncs — the client loops automatically

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

      // Read the full crew list saved by crew_index sync
      const { data: crewListRow } = await supa
        .from("jetinsight_config")
        .select("config_value")
        .eq("config_key", "crew_list")
        .single();

      if (!crewListRow?.config_value) {
        return NextResponse.json({
          error: "Run crew_index sync first to discover crew members.",
          status: 400,
        });
      }

      const allCrew: Array<{ name: string; uuid: string }> = JSON.parse(
        crewListRow.config_value,
      );
      const batch = allCrew.slice(offset, offset + BATCH_SIZE);

      if (batch.length === 0) {
        return NextResponse.json({
          ok: true,
          done: true,
          offset,
          processed: 0,
          total: allCrew.length,
          message: "All crew processed",
        });
      }

      // Look up which crew have matching pilot_profiles
      const { data: profiles } = await supa
        .from("pilot_profiles")
        .select("id, jetinsight_uuid")
        .not("jetinsight_uuid", "is", null);

      const profileByUuid = new Map(
        (profiles ?? []).map((p) => [p.jetinsight_uuid, String(p.id)]),
      );

      let docsDownloaded = 0;
      let docsSkipped = 0;
      const errors: Array<{ entity: string; message: string }> = [];

      for (const c of batch) {
        // Use pilot_profile.id if matched, otherwise JI UUID
        const entityId = profileByUuid.get(c.uuid) ?? c.uuid;
        const result = await syncCrewDocs(entityId, c.uuid, cookie);
        docsDownloaded += result.docsDownloaded;
        docsSkipped += result.docsSkipped;
        for (const err of result.errors) {
          errors.push({ entity: c.name, message: err });
        }
      }

      return NextResponse.json({
        ok: true,
        done: false,
        nextOffset: offset + batch.length,
        processed: batch.length,
        total: allCrew.length,
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

    // ── Schedule JSON enrichment ──────────────────────────────────
    if (syncType === "schedule") {
      const result = await runScheduleSync();
      return NextResponse.json({ ok: !result.sessionExpired, result });
    }

    // ── Trip documents batch (offset-based) ───────────────────────
    if (syncType === "trip_batch") {
      const offset = body.offset ?? 0;

      // Get international trip IDs from enriched flights
      const { data: intlFlights } = await supa
        .from("flights")
        .select("jetinsight_trip_id")
        .eq("international_leg", true)
        .not("jetinsight_trip_id", "is", null)
        .order("jetinsight_trip_id");

      // Deduplicate trip IDs
      const allTripIds = [
        ...new Set(
          (intlFlights ?? [])
            .map((f) => f.jetinsight_trip_id as string)
            .filter(Boolean),
        ),
      ];

      const batch = allTripIds.slice(offset, offset + BATCH_SIZE);

      if (batch.length === 0) {
        return NextResponse.json({
          ok: true,
          done: true,
          offset,
          processed: 0,
          total: allTripIds.length,
          message: "All trips processed",
        });
      }

      let docsDownloaded = 0;
      let docsSkipped = 0;
      const errors: Array<{ entity: string; message: string }> = [];

      for (const tripId of batch) {
        const result = await syncTripDocs(tripId, cookie);
        docsDownloaded += result.docsDownloaded;
        docsSkipped += result.docsSkipped;
        for (const err of result.errors) {
          errors.push({ entity: tripId, message: err });
        }
      }

      return NextResponse.json({
        ok: true,
        done: false,
        nextOffset: offset + batch.length,
        processed: batch.length,
        total: allTripIds.length,
        docsDownloaded,
        docsSkipped,
        errors,
      });
    }

    // ── Post-flight data sync ──────────────────────────────────────
    if (syncType === "post_flight") {
      const pfMonths = body.offset ?? 3; // reuse offset field for months
      const result = await syncPostFlightData(pfMonths);
      return NextResponse.json({ ok: !result.sessionExpired, result });
    }

    // ── Company documents ─────────────────────────────────────────
    if (syncType === "company_docs") {
      const result = await syncCompanyDocs(cookie);
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
