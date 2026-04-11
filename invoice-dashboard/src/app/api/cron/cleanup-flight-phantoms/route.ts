import { NextRequest, NextResponse } from "next/server";
import { verifyCronSecret } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";

export const maxDuration = 60;

/**
 * GET /api/cron/cleanup-flight-phantoms
 *
 * The ops-monitor Python service syncs JetInsight's ICS calendar feed
 * into the `flights` table every 30 minutes. That feed occasionally
 * drops in legs that don't exist in the richer JSON feed (wrong
 * duration, no FBO, flight_type = "Other", no `jetinsight_event_uuid`).
 * Those phantoms collide with the real JSON-sourced legs and cause
 * duplicates in places that read the flights table (fuel plans,
 * duty calculations, crew swap, etc.).
 *
 * This cron finds phantoms (no `jetinsight_event_uuid`, not prefixed
 * `ji:`) in the next 30 days that collide with a real JSON leg
 * (same tail + dep + arr + date) and deletes the phantom. Orphan
 * phantoms with no corresponding JSON leg are preserved — they may
 * be the only record of a flight the JSON feed hasn't caught yet.
 *
 * Scheduled: every hour at :37
 */
export async function GET(req: NextRequest) {
  const isCron = verifyCronSecret(req);
  if (!isCron) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supa = createServiceClient();
  const now = new Date();
  const horizon = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

  const { data: rows, error } = await supa
    .from("flights")
    .select("id, tail_number, departure_icao, arrival_icao, scheduled_departure, jetinsight_event_uuid, ics_uid")
    .gte("scheduled_departure", now.toISOString())
    .lte("scheduled_departure", horizon.toISOString());

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  type Row = {
    id: string;
    tail_number: string | null;
    departure_icao: string | null;
    arrival_icao: string | null;
    scheduled_departure: string;
    jetinsight_event_uuid: string | null;
    ics_uid: string | null;
  };

  const realKeys = new Set<string>();
  const phantomCandidates: Row[] = [];
  for (const r of (rows ?? []) as Row[]) {
    if (!r.tail_number || !r.departure_icao || !r.arrival_icao) continue;
    const date = r.scheduled_departure.slice(0, 10);
    const key = `${r.tail_number.toUpperCase()}|${r.departure_icao}|${r.arrival_icao}|${date}`;
    if (r.jetinsight_event_uuid) {
      realKeys.add(key);
    } else if (!r.ics_uid || !r.ics_uid.startsWith("ji:")) {
      phantomCandidates.push(r);
    }
  }

  const redundantIds: string[] = [];
  const orphanCount = phantomCandidates.reduce((count, r) => {
    const date = r.scheduled_departure.slice(0, 10);
    const key = `${r.tail_number!.toUpperCase()}|${r.departure_icao}|${r.arrival_icao}|${date}`;
    if (realKeys.has(key)) {
      redundantIds.push(r.id);
      return count;
    }
    return count + 1;
  }, 0);

  let deleted = 0;
  if (redundantIds.length > 0) {
    const { error: delErr, count } = await supa
      .from("flights")
      .delete({ count: "exact" })
      .in("id", redundantIds);
    if (delErr) {
      return NextResponse.json(
        { error: delErr.message, considered: redundantIds.length },
        { status: 500 },
      );
    }
    deleted = count ?? redundantIds.length;
  }

  return NextResponse.json({
    ok: true,
    scanned: rows?.length ?? 0,
    real_legs: realKeys.size,
    phantoms_considered: phantomCandidates.length,
    redundant_deleted: deleted,
    orphans_preserved: orphanCount,
  });
}
