import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthed, isRateLimited } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";
import { isInternationalIcao } from "@/lib/intlUtils";
import { getAirportInfo } from "@/lib/airportCoords";
import { detectOverflightsFromIcao } from "@/lib/overflightDetector";

// ---------------------------------------------------------------------------
// Trip detection: group flights into US → INTL(s) → US trips
// ---------------------------------------------------------------------------

type MinFlight = {
  id: string;
  tail_number: string | null;
  departure_icao: string | null;
  arrival_icao: string | null;
  scheduled_departure: string;
};

type DetectedTrip = {
  tail_number: string;
  route_icaos: string[];
  flight_ids: string[];
  trip_date: string;
};

function detectTrips(flights: MinFlight[]): DetectedTrip[] {
  // Sort by tail then departure time
  const sorted = [...flights].sort((a, b) => {
    const tailCmp = (a.tail_number ?? "").localeCompare(b.tail_number ?? "");
    if (tailCmp !== 0) return tailCmp;
    return new Date(a.scheduled_departure).getTime() - new Date(b.scheduled_departure).getTime();
  });

  const trips: DetectedTrip[] = [];
  // Group by tail
  const byTail = new Map<string, MinFlight[]>();
  for (const f of sorted) {
    if (!f.tail_number || !f.departure_icao || !f.arrival_icao) continue;
    if (!byTail.has(f.tail_number)) byTail.set(f.tail_number, []);
    byTail.get(f.tail_number)!.push(f);
  }

  for (const [tail, tailFlights] of byTail) {
    let i = 0;
    while (i < tailFlights.length) {
      const f = tailFlights[i];
      const depIntl = isInternationalIcao(f.departure_icao);
      const arrIntl = isInternationalIcao(f.arrival_icao);

      // Look for US → INTL (outbound leg starts a trip)
      if (!depIntl && arrIntl) {
        const route: string[] = [f.departure_icao!];
        const flightIds: string[] = [f.id];
        let lastArrival = f.arrival_icao!;
        route.push(lastArrival);

        // Walk forward on same tail, collecting legs until we return to US
        let j = i + 1;
        while (j < tailFlights.length) {
          const next = tailFlights[j];
          // Gap check: if more than 7 days between legs, break
          const gap = new Date(next.scheduled_departure).getTime() -
            new Date(tailFlights[j - 1].scheduled_departure).getTime();
          if (gap > 7 * 24 * 60 * 60 * 1000) break;

          // Check continuity: next departure should match last arrival (or same airport area)
          if (next.departure_icao !== lastArrival) {
            // Allow if both are at the same international location (repositioning)
            // Otherwise break the chain
            if (!isInternationalIcao(next.departure_icao)) break;
          }

          flightIds.push(next.id);
          route.push(next.arrival_icao!);
          lastArrival = next.arrival_icao!;
          j++;

          // If we've returned to a US airport, trip is complete
          if (!isInternationalIcao(lastArrival)) break;
        }

        trips.push({
          tail_number: tail,
          route_icaos: route,
          flight_ids: flightIds,
          trip_date: new Date(f.scheduled_departure).toISOString().slice(0, 10),
        });

        i = j;
      } else {
        i++;
      }
    }
  }

  return trips;
}

// ---------------------------------------------------------------------------
// Build default clearances for a trip (including auto-detected overflights)
// ---------------------------------------------------------------------------

type ClearanceRow = {
  clearance_type: string;
  airport_icao: string;
  status: string;
  sort_order: number;
  notes?: string | null;
};

type CountryRow = {
  iso_code: string;
  name: string;
  overflight_permit_required: boolean;
};

function buildDefaultClearances(trip: DetectedTrip, countriesWithOvfReq: CountryRow[]) {
  const clearances: ClearanceRow[] = [];
  const route = trip.route_icaos;
  let order = 0;

  // First airport = US departure → outbound clearance
  clearances.push({
    clearance_type: "outbound_clearance",
    airport_icao: route[0],
    status: "not_started",
    sort_order: order++,
  });

  // For each leg, detect overflights and add overflight permits if needed
  const ovfCountriesSeen = new Set<string>();

  for (let k = 0; k < route.length - 1; k++) {
    const dep = route[k];
    const arr = route[k + 1];

    // Detect overflown countries for this leg
    const depInfo = getAirportInfo(dep) ?? getAirportInfo(dep.replace(/^K/, ""));
    const arrInfo = getAirportInfo(arr) ?? getAirportInfo(arr.replace(/^K/, ""));

    if (depInfo && arrInfo) {
      try {
        const overflights = detectOverflightsFromIcao(
          dep, depInfo.lat, depInfo.lon,
          arr, arrInfo.lat, arrInfo.lon
        );

        for (const ovf of overflights) {
          // Skip if we already added this country
          if (ovfCountriesSeen.has(ovf.country_iso)) continue;
          ovfCountriesSeen.add(ovf.country_iso);

          // Check if this country requires an overflight permit
          const country = countriesWithOvfReq.find((c) => c.iso_code === ovf.country_iso);
          if (country?.overflight_permit_required) {
            clearances.push({
              clearance_type: "overflight_permit",
              airport_icao: ovf.fir_id || ovf.country_iso,
              status: "not_started",
              sort_order: order++,
              notes: `${ovf.country_name} (${ovf.country_iso}) — auto-detected on ${dep}→${arr}`,
            });
          }
        }
      } catch {
        // Overflight detection can fail for unknown airports — skip silently
      }
    }

    // If the arrival is international and not the last airport, add landing permit
    if (k < route.length - 2 && isInternationalIcao(arr)) {
      clearances.push({
        clearance_type: "landing_permit",
        airport_icao: arr,
        status: "not_started",
        sort_order: order++,
      });
    }
  }

  // Last international stop gets a landing permit too
  const secondToLast = route[route.length - 2];
  if (route.length >= 3 && isInternationalIcao(secondToLast)) {
    // Check if we already added it (for 3-airport trips it's the only middle one)
    const alreadyAdded = clearances.some(
      (c) => c.clearance_type === "landing_permit" && c.airport_icao === secondToLast
    );
    if (!alreadyAdded) {
      clearances.push({
        clearance_type: "landing_permit",
        airport_icao: secondToLast,
        status: "not_started",
        sort_order: order++,
      });
    }
  }

  // Last airport = US return → inbound clearance (only if it's a US airport)
  const lastIcao = route[route.length - 1];
  if (!isInternationalIcao(lastIcao)) {
    clearances.push({
      clearance_type: "inbound_clearance",
      airport_icao: lastIcao,
      status: "not_started",
      sort_order: order++,
    });
  }

  return clearances;
}

// ---------------------------------------------------------------------------
// GET — list trips (auto-detect from flights if needed)
// ---------------------------------------------------------------------------

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;

  const supa = createServiceClient();
  const autoDetect = req.nextUrl.searchParams.get("auto_detect") !== "false";

  if (autoDetect) {
    // Fetch flights for the next 30 days
    const now = new Date();
    const lookback = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
    const lookahead = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();

    const { data: flights } = await supa
      .from("flights")
      .select("id, tail_number, departure_icao, arrival_icao, scheduled_departure, scheduled_arrival")
      .gte("scheduled_departure", lookback)
      .lte("scheduled_departure", lookahead)
      .order("scheduled_departure");

    if (flights && flights.length > 0) {
      const detected = detectTrips(flights as MinFlight[]);

      // Fetch countries that require overflight permits (for auto-tagging)
      const { data: countriesData } = await supa
        .from("countries")
        .select("iso_code, name, overflight_permit_required")
        .eq("overflight_permit_required", true);
      const countriesWithOvfReq: CountryRow[] = (countriesData ?? []) as CountryRow[];

      // Batch-fetch all existing trips in the date range to avoid N+1
      const tripDates = [...new Set(detected.map((d) => d.trip_date))];
      const tripTails = [...new Set(detected.map((d) => d.tail_number))];
      const { data: allExisting } = await supa
        .from("intl_trips")
        .select("id, tail_number, trip_date, route_icaos, flight_ids, schedule_snapshot")
        .in("tail_number", tripTails)
        .in("trip_date", tripDates);
      const existingMap = new Map<string, { id: string; route_icaos: string[]; flight_ids: string[]; schedule_snapshot: unknown }[]>();
      for (const e of allExisting ?? []) {
        const key = `${e.tail_number}|${e.trip_date}`;
        if (!existingMap.has(key)) existingMap.set(key, []);
        existingMap.get(key)!.push(e);
      }

      // Build a lookup for schedule snapshots from flight data
      const flightMap = new Map<string, { dep: string; arr: string | null }>();
      for (const f of flights as Array<{ id: string; scheduled_departure: string; scheduled_arrival: string | null }>) {
        flightMap.set(f.id, { dep: f.scheduled_departure, arr: f.scheduled_arrival ?? null });
      }

      // Helper: build snapshot for a set of flight IDs
      function buildSnapshot(flightIds: string[]) {
        const snap: Record<string, { dep: string; arr: string | null }> = {};
        for (const fid of flightIds) {
          const times = flightMap.get(fid);
          if (times) snap[fid] = times;
        }
        return snap;
      }

      // Upsert trips — updates in parallel, inserts batched
      const updatePromises: PromiseLike<unknown>[] = [];
      const toInsert: DetectedTrip[] = [];

      for (const dt of detected) {
        const key = `${dt.tail_number}|${dt.trip_date}`;
        const candidates = existingMap.get(key) ?? [];
        const match = candidates.find(
          (e) => JSON.stringify(e.route_icaos) === JSON.stringify(dt.route_icaos)
        );

        if (match) {
          const needsFlightUpdate = JSON.stringify(match.flight_ids) !== JSON.stringify(dt.flight_ids);
          const needsSnapshot = !match.schedule_snapshot;

          if (needsFlightUpdate || needsSnapshot) {
            const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
            if (needsFlightUpdate) updates.flight_ids = dt.flight_ids;
            if (needsSnapshot) updates.schedule_snapshot = buildSnapshot(dt.flight_ids);
            updatePromises.push(
              supa.from("intl_trips").update(updates).eq("id", match.id)
            );
          }
        } else {
          toInsert.push(dt);
        }
      }

      // Run updates in parallel
      if (updatePromises.length > 0) await Promise.all(updatePromises);

      // Batch insert new trips
      for (const dt of toInsert) {
        const { data: newTrip, error: tripErr } = await supa
          .from("intl_trips")
          .insert({
            tail_number: dt.tail_number,
            route_icaos: dt.route_icaos,
            flight_ids: dt.flight_ids,
            trip_date: dt.trip_date,
            schedule_snapshot: buildSnapshot(dt.flight_ids),
          })
          .select("id")
          .single();

        if (!tripErr && newTrip) {
          const clearances = buildDefaultClearances(dt, countriesWithOvfReq).map((c) => ({
            ...c,
            trip_id: newTrip.id,
          }));
          if (clearances.length > 0) {
            await supa.from("intl_trip_clearances").insert(clearances);
          }
        }
      }
    }
  }

  // Fetch all trips with clearances
  const { data: trips, error } = await supa
    .from("intl_trips")
    .select("*, clearances:intl_trip_clearances(*)")
    .gte("trip_date", new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10))
    .order("trip_date", { ascending: true });

  if (error) {
    console.error("[intl/trips] list error:", error);
    return NextResponse.json({ error: "Failed to list trips" }, { status: 500 });
  }

  // Collect ALL flight IDs to batch-fetch jetinsight_url + schedule times
  const allFlightIds = new Set<string>();
  for (const t of trips ?? []) {
    for (const fid of t.flight_ids ?? []) allFlightIds.add(fid);
  }
  const jetinsightMap = new Map<string, string>();
  const flightTimesMap = new Map<string, { dep: string; arr: string | null }>();
  if (allFlightIds.size > 0) {
    const { data: flightRows } = await supa
      .from("flights")
      .select("id, jetinsight_url, scheduled_departure, scheduled_arrival")
      .in("id", [...allFlightIds]);
    for (const f of flightRows ?? []) {
      if (f.jetinsight_url) jetinsightMap.set(f.id, f.jetinsight_url);
      flightTimesMap.set(f.id, { dep: f.scheduled_departure, arr: f.scheduled_arrival ?? null });
    }
  }

  // Sort clearances, attach jetinsight_url, and build schedule_snapshot from flight times
  for (const t of trips ?? []) {
    if (t.clearances) {
      t.clearances.sort((a: { sort_order: number }, b: { sort_order: number }) => a.sort_order - b.sort_order);
    }
    t.jetinsight_url = jetinsightMap.get(t.flight_ids?.[0]) ?? null;
    // Build schedule_snapshot from live flight data
    const snap: Record<string, { dep: string; arr: string | null }> = {};
    for (const fid of t.flight_ids ?? []) {
      const times = flightTimesMap.get(fid);
      if (times) snap[fid] = times;
    }
    t.schedule_snapshot = Object.keys(snap).length > 0 ? snap : null;
  }

  return NextResponse.json({ trips: trips ?? [] });
}

// ---------------------------------------------------------------------------
// POST — manually create a trip
// ---------------------------------------------------------------------------

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;
  if (await isRateLimited(auth.userId, 20)) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  let input: Record<string, unknown>;
  try { input = await req.json(); } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const tail_number = input.tail_number as string;
  const route_icaos = input.route_icaos as string[];
  const trip_date = input.trip_date as string;

  if (!tail_number || !route_icaos || route_icaos.length < 3 || !trip_date) {
    return NextResponse.json(
      { error: "tail_number, route_icaos (min 3), and trip_date required" },
      { status: 400 },
    );
  }

  const supa = createServiceClient();
  const { data: newTrip, error: tripErr } = await supa
    .from("intl_trips")
    .insert({
      tail_number,
      route_icaos,
      flight_ids: (input.flight_ids as string[]) ?? [],
      trip_date,
      notes: (input.notes as string) ?? null,
    })
    .select("id")
    .single();

  if (tripErr) {
    console.error("[intl/trips] insert error:", tripErr);
    return NextResponse.json({ error: "Failed to create trip" }, { status: 500 });
  }

  // Create default clearances (with overflight detection)
  const { data: countriesData } = await supa
    .from("countries")
    .select("iso_code, name, overflight_permit_required");
  const detected: DetectedTrip = { tail_number, route_icaos, flight_ids: [], trip_date };
  const clearances = buildDefaultClearances(detected, (countriesData ?? []) as CountryRow[]).map((c) => ({
    ...c,
    trip_id: newTrip.id,
  }));
  if (clearances.length > 0) {
    await supa.from("intl_trip_clearances").insert(clearances);
  }

  // Re-fetch with clearances
  const { data: trip } = await supa
    .from("intl_trips")
    .select("*, clearances:intl_trip_clearances(*)")
    .eq("id", newTrip.id)
    .single();

  return NextResponse.json({ trip }, { status: 201 });
}
