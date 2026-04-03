import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { requireAdmin } from "@/lib/api-auth";
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
  const auth = await requireAdmin(req);
  if ("error" in auth) return auth.error;

  if (!process.env.FLIGHTAWARE_API_KEY) {
    return NextResponse.json({ error: "FLIGHTAWARE_API_KEY not configured" }, { status: 500 });
  }

  let body: { action?: string; faFlightIds?: Array<{ id: string; tail: string; origin: string; dest: string; date: string }> };
  try { body = await req.json(); } catch { body = {}; }

  const supa = createServiceClient();

  try {
    // ─── Step 1: Discover FA flights matching our fleet ───
    if (body.action === "discover") {
      // Get tail→callsign mapping
      const { data: faFlights } = await supa
        .from("fa_flights")
        .select("tail, ident")
        .limit(500);

      const callsignMap = new Map<string, string>();
      for (const f of (faFlights ?? []) as Array<{ tail: string; ident: string }>) {
        if (f.tail && f.ident && !callsignMap.has(f.tail)) {
          callsignMap.set(f.tail, f.ident);
        }
      }

      // Already-stored tracks
      const { data: existingTracks } = await supa
        .from("flightaware_tracks")
        .select("fa_flight_id")
        .limit(10000);
      const existingIds = new Set((existingTracks ?? []).map((t: { fa_flight_id: string }) => t.fa_flight_id));

      // Last 2 months
      const endDate = new Date();
      const startDate = new Date();
      startDate.setMonth(startDate.getMonth() - 2);

      const discovered: Array<{ id: string; tail: string; origin: string; dest: string; date: string }> = [];
      const errors: string[] = [];

      for (const [tail, callsign] of callsignMap) {
        await sleep(DELAY_MS);
        try {
          const res = await fetch(
            `${FA_BASE}/flights/${callsign}?start=${startDate.toISOString()}&end=${endDate.toISOString()}`,
            { headers: faHeaders(), signal: AbortSignal.timeout(15_000) },
          );
          if (!res.ok) continue;
          const data = await res.json();
          const flights = (data.flights ?? []) as Array<{
            fa_flight_id: string;
            origin?: { code_icao?: string };
            destination?: { code_icao?: string };
            actual_off?: string;
            scheduled_off?: string;
            status?: string;
          }>;

          for (const f of flights) {
            if (existingIds.has(f.fa_flight_id)) continue;
            const status = (f.status ?? "").toLowerCase();
            if (!status.includes("arrived") && !status.includes("landed")) continue;

            const depTime = f.actual_off ?? f.scheduled_off;
            discovered.push({
              id: f.fa_flight_id,
              tail,
              origin: f.origin?.code_icao ?? "",
              dest: f.destination?.code_icao ?? "",
              date: depTime ? new Date(depTime).toISOString().split("T")[0] : "",
            });
          }
        } catch (err) {
          errors.push(`${callsign}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      return NextResponse.json({
        ok: true,
        callsigns: callsignMap.size,
        discovered: discovered.length,
        alreadySynced: existingIds.size,
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
