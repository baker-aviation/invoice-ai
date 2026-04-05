import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { getFlightTrack } from "@/lib/flightaware";
import { fetchAdsbxTrace, FLEET_HEX } from "@/lib/adsbExchange";

export const maxDuration = 300;

const FA_BASE = "https://aeroapi.flightaware.com/aeroapi";
const DELAY_MS = 1200;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function faHeaders() {
  return { "x-apikey": process.env.FLIGHTAWARE_API_KEY!, Accept: "application/json; charset=UTF-8" };
}

/**
 * GET /api/cron/sync-tracks
 * Daily cron — discovers yesterday's flights and pulls ADS-B tracks.
 * Called by Vercel Cron or Cloud Scheduler.
 */
export async function GET(req: NextRequest) {
  // Allow cron secret or no auth for scheduled jobs
  const cronSecret = req.headers.get("x-cron-secret") ?? req.nextUrl.searchParams.get("secret");
  if (cronSecret !== process.env.CRON_SECRET && process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!process.env.FLIGHTAWARE_API_KEY) {
    return NextResponse.json({ error: "FLIGHTAWARE_API_KEY not configured" }, { status: 500 });
  }

  const supa = createServiceClient();

  // Look back 2 days to catch anything missed
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 2);

  try {
    // Get flights with fa_flight_id from last 2 days that don't have tracks yet
    const { data: recentFlights } = await supa
      .from("flights")
      .select("fa_flight_id, tail_number, departure_icao, arrival_icao, scheduled_departure")
      .not("fa_flight_id", "is", null)
      .gte("scheduled_departure", cutoff.toISOString())
      .limit(500);

    // Also check fa_flights for anything the webhook captured
    const { data: faActive } = await supa
      .from("fa_flights")
      .select("fa_flight_id, tail, origin_icao, destination_icao, departure_time")
      .or("status.eq.Landed,status.eq.Arrived")
      .not("fa_flight_id", "is", null)
      .gte("departure_time", cutoff.toISOString())
      .limit(500);

    // Already stored
    const { data: existingTracks } = await supa
      .from("flightaware_tracks")
      .select("fa_flight_id")
      .limit(10000);
    const existingIds = new Set((existingTracks ?? []).map((t: { fa_flight_id: string }) => t.fa_flight_id));

    // Dedupe and filter
    const toFetch = new Map<string, { tail: string; origin: string; dest: string; date: string }>();

    for (const f of (recentFlights ?? []) as Array<Record<string, string>>) {
      if (!f.fa_flight_id || existingIds.has(f.fa_flight_id)) continue;
      toFetch.set(f.fa_flight_id, {
        tail: f.tail_number ?? "",
        origin: f.departure_icao ?? "",
        dest: f.arrival_icao ?? "",
        date: f.scheduled_departure ? new Date(f.scheduled_departure).toISOString().split("T")[0] : "",
      });
    }

    for (const f of (faActive ?? []) as Array<Record<string, string>>) {
      if (!f.fa_flight_id || existingIds.has(f.fa_flight_id) || toFetch.has(f.fa_flight_id)) continue;
      toFetch.set(f.fa_flight_id, {
        tail: f.tail ?? "",
        origin: f.origin_icao ?? "",
        dest: f.destination_icao ?? "",
        date: f.departure_time ? new Date(f.departure_time).toISOString().split("T")[0] : "",
      });
    }

    // Also discover via FA API (last 2 days by callsign)
    const { data: callsignData } = await supa
      .from("fa_flights").select("tail, ident").limit(500);
    const callsignMap = new Map<string, string>();
    for (const f of (callsignData ?? []) as Array<{ tail: string; ident: string }>) {
      if (f.tail && f.ident && !callsignMap.has(f.tail)) callsignMap.set(f.tail, f.ident);
    }

    for (const [tail, callsign] of callsignMap) {
      await sleep(DELAY_MS);
      try {
        const res = await fetch(
          `${FA_BASE}/flights/${callsign}?start=${cutoff.toISOString()}&end=${new Date().toISOString()}`,
          { headers: faHeaders(), signal: AbortSignal.timeout(10_000) },
        );
        if (!res.ok) continue;
        const data = await res.json();
        for (const f of (data.flights ?? []) as Array<Record<string, unknown>>) {
          const fid = f.fa_flight_id as string;
          if (!fid || existingIds.has(fid) || toFetch.has(fid)) continue;
          const status = ((f.status as string) ?? "").toLowerCase();
          if (!status.includes("arrived") && !status.includes("landed")) continue;
          const depTime = (f.actual_off ?? f.scheduled_off) as string;
          toFetch.set(fid, {
            tail,
            origin: (f.origin as Record<string, string>)?.code_icao ?? "",
            dest: (f.destination as Record<string, string>)?.code_icao ?? "",
            date: depTime ? new Date(depTime).toISOString().split("T")[0] : "",
          });
        }
      } catch { /* skip on error */ }
    }

    // Pull tracks
    let stored = 0;
    let skipped = 0;

    for (const [fid, flight] of toFetch) {
      await sleep(DELAY_MS);
      try {
        let positions = await getFlightTrack(fid);

        // Fallback: try ADS-B Exchange if FlightAware returns empty
        if (!positions?.length && flight.tail && flight.date && FLEET_HEX[flight.tail]) {
          const adsbxFlights = await fetchAdsbxTrace(flight.tail, flight.date);
          if (adsbxFlights.length > 0) {
            // Use the longest flight from that day
            const best = adsbxFlights.sort((a, b) => (b.positions.length) - (a.positions.length))[0];
            positions = best.positions.map((p) => ({
              latitude: p.lat, longitude: p.lon, altitude: p.alt,
              groundspeed: p.gs, heading: null, timestamp: p.t,
            }));
          }
        }

        if (!positions?.length) {
          await supa.from("flightaware_tracks").upsert({
            fa_flight_id: fid, tail_number: flight.tail,
            origin_icao: flight.origin, destination_icao: flight.dest,
            flight_date: flight.date || new Date().toISOString().split("T")[0],
            positions: [], position_count: 0,
          }, { onConflict: "fa_flight_id" });
          skipped++;
          continue;
        }

        const altitudes = positions.map((p) => p.altitude ?? 0).filter((a) => a > 0);
        const maxAlt = altitudes.length > 0 ? Math.max(...altitudes) : null;

        let climbSec: number | null = null;
        if (maxAlt && positions.length >= 2) {
          const first = new Date(positions[0].timestamp).getTime();
          const maxPos = positions.find((p) => (p.altitude ?? 0) >= maxAlt! - 5);
          if (maxPos) climbSec = Math.round((new Date(maxPos.timestamp).getTime() - first) / 1000);
        }

        let totalSec: number | null = null;
        if (positions.length >= 2) {
          totalSec = Math.round(
            (new Date(positions[positions.length - 1].timestamp).getTime() - new Date(positions[0].timestamp).getTime()) / 1000,
          );
        }

        await supa.from("flightaware_tracks").upsert({
          fa_flight_id: fid, tail_number: flight.tail,
          origin_icao: flight.origin, destination_icao: flight.dest,
          flight_date: flight.date || new Date().toISOString().split("T")[0],
          positions: positions.map((p) => ({
            t: p.timestamp, alt: p.altitude, gs: p.groundspeed,
            lat: Math.round((p.latitude ?? 0) * 10000) / 10000,
            lon: Math.round((p.longitude ?? 0) * 10000) / 10000,
          })),
          position_count: positions.length,
          max_altitude: maxAlt ? Math.round(maxAlt) : null,
          climb_duration_sec: climbSec,
          total_duration_sec: totalSec,
        }, { onConflict: "fa_flight_id" });
        stored++;
      } catch {
        await supa.from("flightaware_tracks").upsert({
          fa_flight_id: fid, tail_number: flight.tail,
          flight_date: flight.date || new Date().toISOString().split("T")[0],
          positions: [], position_count: 0,
        }, { onConflict: "fa_flight_id" });
      }
    }

    return NextResponse.json({
      ok: true,
      discovered: toFetch.size,
      stored,
      skipped,
      alreadySynced: existingIds.size,
    });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
