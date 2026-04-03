import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { requireAdmin } from "@/lib/api-auth";
import { getFlightTrack } from "@/lib/flightaware";

export const maxDuration = 300;

const BATCH_SIZE = 5; // FA rate limit is ~1/sec, 5 with 1.2s delay = ~6s per batch
const DELAY_MS = 1200;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * POST /api/fuel-planning/sync-tracks
 *
 * Two modes:
 *   1. { action: "list" }   — find completed flights with fa_flight_id but no stored track
 *   2. { action: "fetch" }  — fetch and store tracks for next batch of unsynced flights
 */
export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if ("error" in auth) return auth.error;

  if (!process.env.FLIGHTAWARE_API_KEY) {
    return NextResponse.json({ error: "FLIGHTAWARE_API_KEY not configured" }, { status: 500 });
  }

  let body: { action?: string };
  try { body = await req.json(); } catch { body = {}; }

  const supa = createServiceClient();

  try {
    // Find fa_flights that have landed and don't have stored tracks yet
    const { data: faFlights } = await supa
      .from("fa_flights")
      .select("fa_flight_id, tail, origin_icao, destination_icao, departure_time")
      .or("status.eq.Landed,status.eq.Arrived")
      .not("fa_flight_id", "is", null)
      .order("departure_time", { ascending: false })
      .limit(5000);

    const { data: existingTracks } = await supa
      .from("flightaware_tracks")
      .select("fa_flight_id")
      .limit(10000);

    const existingIds = new Set((existingTracks ?? []).map((t: { fa_flight_id: string }) => t.fa_flight_id));
    const needsSync = (faFlights ?? []).filter((f: { fa_flight_id: string }) => !existingIds.has(f.fa_flight_id));

    if (body.action === "list") {
      return NextResponse.json({
        ok: true,
        total: (faFlights ?? []).length,
        alreadySynced: existingIds.size,
        needsSync: needsSync.length,
      });
    }

    // Fetch mode — process next batch
    if (needsSync.length === 0) {
      return NextResponse.json({ ok: true, done: true, stored: 0, total: existingIds.size });
    }

    const batch = needsSync.slice(0, BATCH_SIZE);
    let stored = 0;
    let skipped = 0;
    const errors: string[] = [];

    for (const flight of batch) {
      await sleep(DELAY_MS);

      try {
        const positions = await getFlightTrack(flight.fa_flight_id);

        if (!positions || positions.length === 0) {
          // Write tombstone so we don't retry
          await supa.from("flightaware_tracks").upsert({
            fa_flight_id: flight.fa_flight_id,
            tail_number: flight.tail ?? "UNKNOWN",
            origin_icao: flight.origin_icao,
            destination_icao: flight.destination_icao,
            flight_date: flight.departure_time
              ? new Date(flight.departure_time).toISOString().split("T")[0]
              : new Date().toISOString().split("T")[0],
            positions: [],
            position_count: 0,
          }, { onConflict: "fa_flight_id" });
          skipped++;
          continue;
        }

        // Compute summary stats from positions
        const altitudes = positions
          .map((p) => p.altitude ?? 0)
          .filter((a) => a > 0);
        const maxAlt = altitudes.length > 0 ? Math.max(...altitudes) : null;

        // Climb duration: time from first position to first time at max altitude
        let climbDurationSec: number | null = null;
        if (maxAlt && positions.length >= 2) {
          const firstTime = new Date(positions[0].timestamp).getTime();
          const maxAltPos = positions.find((p) => (p.altitude ?? 0) >= maxAlt! - 5); // within 500ft
          if (maxAltPos) {
            climbDurationSec = Math.round((new Date(maxAltPos.timestamp).getTime() - firstTime) / 1000);
          }
        }

        // Total duration
        let totalDurationSec: number | null = null;
        if (positions.length >= 2) {
          const first = new Date(positions[0].timestamp).getTime();
          const last = new Date(positions[positions.length - 1].timestamp).getTime();
          totalDurationSec = Math.round((last - first) / 1000);
        }

        const flightDate = flight.departure_time
          ? new Date(flight.departure_time).toISOString().split("T")[0]
          : new Date().toISOString().split("T")[0];

        // Store compact positions (only fields we need for chart)
        const compactPositions = positions.map((p) => ({
          t: p.timestamp,
          alt: p.altitude,
          gs: p.groundspeed,
          lat: Math.round((p.latitude ?? 0) * 10000) / 10000,
          lon: Math.round((p.longitude ?? 0) * 10000) / 10000,
        }));

        await supa.from("flightaware_tracks").upsert({
          fa_flight_id: flight.fa_flight_id,
          tail_number: flight.tail ?? "UNKNOWN",
          origin_icao: flight.origin_icao,
          destination_icao: flight.destination_icao,
          flight_date: flightDate,
          positions: compactPositions,
          position_count: positions.length,
          max_altitude: maxAlt ? Math.round(maxAlt) : null,
          climb_duration_sec: climbDurationSec,
          total_duration_sec: totalDurationSec,
        }, { onConflict: "fa_flight_id" });

        stored++;
      } catch (err) {
        errors.push(`${flight.fa_flight_id}: ${err instanceof Error ? err.message : String(err)}`);
        // Tombstone on error
        await supa.from("flightaware_tracks").upsert({
          fa_flight_id: flight.fa_flight_id,
          tail_number: flight.tail ?? "UNKNOWN",
          flight_date: flight.departure_time
            ? new Date(flight.departure_time).toISOString().split("T")[0]
            : new Date().toISOString().split("T")[0],
          positions: [],
          position_count: 0,
        }, { onConflict: "fa_flight_id" });
      }
    }

    return NextResponse.json({
      ok: true,
      done: needsSync.length <= BATCH_SIZE,
      stored,
      skipped,
      remaining: needsSync.length - batch.length,
      total: (faFlights ?? []).length,
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
