import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { requireAuth, isAuthed } from "@/lib/api-auth";
import { getFlightTrack } from "@/lib/flightaware";

export const maxDuration = 300;

const FA_BASE = "https://aeroapi.flightaware.com/aeroapi";
const BATCH_SIZE = 5;
const DELAY_MS = 1200;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function faHeaders() {
  return { "x-apikey": process.env.FLIGHTAWARE_API_KEY!, Accept: "application/json; charset=UTF-8" };
}

/**
 * POST /api/fuel-planning/sync-tracks
 *
 * Two-step flow:
 *   1. { action: "discover" } — query FA historical flights by callsign, return new IDs
 *   2. { faFlightIds: [...] } — pull and store tracks for specific flights
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;

  if (!process.env.FLIGHTAWARE_API_KEY) {
    return NextResponse.json({ error: "FLIGHTAWARE_API_KEY not configured" }, { status: 500 });
  }

  let body: { action?: string; faFlightIds?: Array<{ id: string; tail: string; origin: string; dest: string; date: string }> };
  try { body = await req.json(); } catch { body = {}; }

  const supa = createServiceClient();

  try {
    // ─── Step 1: Discover FA flights needing track pulls ───
    if (body.action === "discover") {
      // Already-stored tracks
      const { data: existingTracks } = await supa
        .from("flightaware_tracks")
        .select("fa_flight_id")
        .limit(10000);
      const existingIds = new Set((existingTracks ?? []).map((t: { fa_flight_id: string }) => t.fa_flight_id));

      const cutoff = new Date();
      cutoff.setMonth(cutoff.getMonth() - 2);

      // Source 1: flights table (webhook-captured, goes back weeks/months — FREE, no FA API calls)
      const { data: icsFlights } = await supa
        .from("flights")
        .select("fa_flight_id, tail_number, departure_icao, arrival_icao, scheduled_departure")
        .not("fa_flight_id", "is", null)
        .gte("scheduled_departure", cutoff.toISOString())
        .limit(5000);

      const discovered: Array<{ id: string; tail: string; origin: string; dest: string; date: string }> = [];

      for (const f of (icsFlights ?? []) as Array<Record<string, string>>) {
        if (!f.fa_flight_id || existingIds.has(f.fa_flight_id)) continue;
        const depDate = f.scheduled_departure ? new Date(f.scheduled_departure).toISOString().split("T")[0] : "";
        discovered.push({
          id: f.fa_flight_id,
          tail: f.tail_number ?? "",
          origin: f.departure_icao ?? "",
          dest: f.arrival_icao ?? "",
          date: depDate,
        });
      }

      // Source 2: fa_flights table (recent active flights)
      const { data: faActive } = await supa
        .from("fa_flights")
        .select("fa_flight_id, tail, origin_icao, destination_icao, departure_time")
        .or("status.eq.Landed,status.eq.Arrived")
        .not("fa_flight_id", "is", null)
        .gte("departure_time", cutoff.toISOString())
        .limit(5000);

      const seenIds = new Set(discovered.map((d) => d.id));
      for (const f of (faActive ?? []) as Array<Record<string, string>>) {
        if (!f.fa_flight_id || existingIds.has(f.fa_flight_id) || seenIds.has(f.fa_flight_id)) continue;
        const depDate = f.departure_time ? new Date(f.departure_time).toISOString().split("T")[0] : "";
        discovered.push({
          id: f.fa_flight_id,
          tail: f.tail ?? "",
          origin: f.origin_icao ?? "",
          dest: f.destination_icao ?? "",
          date: depDate,
        });
      }

      // Source 3: FA /history/flights/ API — walk back in 7-day windows
      // Discovers flights the webhook missed (goes back months)
      const { data: faFlightsForCallsign } = await supa
        .from("fa_flights").select("tail, ident").limit(500);
      const callsignMap = new Map<string, string>();
      for (const f of (faFlightsForCallsign ?? []) as Array<{ tail: string; ident: string }>) {
        if (f.tail && f.ident && !callsignMap.has(f.tail)) callsignMap.set(f.tail, f.ident);
      }

      const seenIds2 = new Set(discovered.map((d) => d.id));
      const errors: string[] = [];

      // Walk back from today in 7-day chunks
      // FA track data is only available for ~3 weeks back, so don't discover older flights
      // (discovery itself is cheap but every track pull on an empty flight wastes $0.01)
      const trackRetentionDays = 21;
      const trackCutoff = new Date();
      trackCutoff.setDate(trackCutoff.getDate() - trackRetentionDays);
      const effectiveCutoff = cutoff > trackCutoff ? cutoff : trackCutoff;

      const now = new Date();
      const weekChunks: Array<{ start: string; end: string }> = [];
      const walkDate = new Date(now);
      while (walkDate > effectiveCutoff) {
        const chunkEnd = new Date(walkDate);
        walkDate.setDate(walkDate.getDate() - 7);
        const chunkStart = walkDate < effectiveCutoff ? new Date(effectiveCutoff) : new Date(walkDate);
        weekChunks.push({
          start: chunkStart.toISOString(),
          end: chunkEnd.toISOString(),
        });
      }

      let faApiCalls = 0;
      for (const [tail, callsign] of callsignMap) {
        for (const chunk of weekChunks) {
          await sleep(DELAY_MS);
          faApiCalls++;
          try {
            const res = await fetch(
              `${FA_BASE}/history/flights/${callsign}?start=${chunk.start}&end=${chunk.end}`,
              { headers: faHeaders(), signal: AbortSignal.timeout(15_000) },
            );
            if (!res.ok) continue;
            const data = await res.json();
            for (const f of (data.flights ?? []) as Array<Record<string, unknown>>) {
              const fid = f.fa_flight_id as string;
              if (!fid || existingIds.has(fid) || seenIds2.has(fid)) continue;
              const status = ((f.status as string) ?? "").toLowerCase();
              if (!status.includes("arrived") && !status.includes("landed")) continue;
              const depTime = (f.actual_off ?? f.scheduled_off) as string;
              discovered.push({
                id: fid, tail,
                origin: (f.origin as Record<string, string>)?.code_icao ?? "",
                dest: (f.destination as Record<string, string>)?.code_icao ?? "",
                date: depTime ? new Date(depTime).toISOString().split("T")[0] : "",
              });
              seenIds2.add(fid);
            }
          } catch (err) {
            errors.push(`${callsign}/${chunk.start.slice(0, 10)}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }

      return NextResponse.json({
        ok: true,
        discovered: discovered.length,
        alreadySynced: existingIds.size,
        sources: { icsFlights: (icsFlights ?? []).length, faActive: (faActive ?? []).length, faApiCalls },
        flights: discovered,
        errors: errors.length > 0 ? errors : undefined,
      });
    }

    // ─── Step 2: Fetch tracks for specific flights ───
    const faFlightIds = body.faFlightIds ?? [];
    if (faFlightIds.length === 0) {
      return NextResponse.json({ ok: true, done: true, stored: 0 });
    }

    const batch = faFlightIds.slice(0, BATCH_SIZE);
    let stored = 0;
    let skipped = 0;
    const errors: string[] = [];

    for (const flight of batch) {
      await sleep(DELAY_MS);
      try {
        const positions = await getFlightTrack(flight.id);

        if (!positions || positions.length === 0) {
          await supa.from("flightaware_tracks").upsert({
            fa_flight_id: flight.id, tail_number: flight.tail,
            origin_icao: flight.origin, destination_icao: flight.dest,
            flight_date: flight.date || new Date().toISOString().split("T")[0],
            positions: [], position_count: 0,
          }, { onConflict: "fa_flight_id" });
          skipped++;
          continue;
        }

        const altitudes = positions.map((p) => p.altitude ?? 0).filter((a) => a > 0);
        const maxAlt = altitudes.length > 0 ? Math.max(...altitudes) : null;

        let climbDurationSec: number | null = null;
        if (maxAlt && positions.length >= 2) {
          const firstTime = new Date(positions[0].timestamp).getTime();
          const maxAltPos = positions.find((p) => (p.altitude ?? 0) >= maxAlt! - 5);
          if (maxAltPos) {
            climbDurationSec = Math.round((new Date(maxAltPos.timestamp).getTime() - firstTime) / 1000);
          }
        }

        let totalDurationSec: number | null = null;
        if (positions.length >= 2) {
          totalDurationSec = Math.round(
            (new Date(positions[positions.length - 1].timestamp).getTime() - new Date(positions[0].timestamp).getTime()) / 1000,
          );
        }

        const compactPositions = positions.map((p) => ({
          t: p.timestamp, alt: p.altitude, gs: p.groundspeed,
          lat: Math.round((p.latitude ?? 0) * 10000) / 10000,
          lon: Math.round((p.longitude ?? 0) * 10000) / 10000,
        }));

        await supa.from("flightaware_tracks").upsert({
          fa_flight_id: flight.id, tail_number: flight.tail,
          origin_icao: flight.origin, destination_icao: flight.dest,
          flight_date: flight.date || new Date().toISOString().split("T")[0],
          positions: compactPositions, position_count: positions.length,
          max_altitude: maxAlt ? Math.round(maxAlt) : null,
          climb_duration_sec: climbDurationSec, total_duration_sec: totalDurationSec,
        }, { onConflict: "fa_flight_id" });

        stored++;
      } catch (err) {
        errors.push(`${flight.id}: ${err instanceof Error ? err.message : String(err)}`);
        await supa.from("flightaware_tracks").upsert({
          fa_flight_id: flight.id, tail_number: flight.tail,
          flight_date: flight.date || new Date().toISOString().split("T")[0],
          positions: [], position_count: 0,
        }, { onConflict: "fa_flight_id" });
      }
    }

    return NextResponse.json({
      ok: true,
      stored, skipped,
      remaining: faFlightIds.length - batch.length,
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
