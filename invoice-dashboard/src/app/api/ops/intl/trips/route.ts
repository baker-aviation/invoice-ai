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
      .select("id, tail_number, departure_icao, arrival_icao, scheduled_departure")
      .gte("scheduled_departure", lookback)
      .lte("scheduled_departure", lookahead)
      .order("scheduled_departure");

    if (flights && flights.length > 0) {
      const detected = detectTrips(flights as MinFlight[]);

      // Fetch countries that require overflight permits (for auto-tagging)
      const { data: countriesData } = await supa
        .from("countries")
        .select("iso_code, name, overflight_permit_required");
      const countriesWithOvfReq: CountryRow[] = (countriesData ?? []) as CountryRow[];

      // Upsert new trips
      for (const dt of detected) {
        // Check if trip already exists
        const { data: existing } = await supa
          .from("intl_trips")
          .select("id, route_icaos, flight_ids")
          .eq("tail_number", dt.tail_number)
          .eq("trip_date", dt.trip_date)
          .limit(1);

        const match = (existing ?? []).find(
          (e: { route_icaos: string[] }) => JSON.stringify(e.route_icaos) === JSON.stringify(dt.route_icaos)
        );

        if (match) {
          // Update flight_ids if they changed
          if (JSON.stringify(match.flight_ids) !== JSON.stringify(dt.flight_ids)) {
            await supa
              .from("intl_trips")
              .update({ flight_ids: dt.flight_ids, updated_at: new Date().toISOString() })
              .eq("id", match.id);
          }
        } else {
          // Create new trip + clearances (with auto-detected overflight permits)
          const { data: newTrip, error: tripErr } = await supa
            .from("intl_trips")
            .insert({
              tail_number: dt.tail_number,
              route_icaos: dt.route_icaos,
              flight_ids: dt.flight_ids,
              trip_date: dt.trip_date,
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

  // Sort clearances by sort_order within each trip
  for (const t of trips ?? []) {
    if (t.clearances) {
      t.clearances.sort((a: { sort_order: number }, b: { sort_order: number }) => a.sort_order - b.sort_order);
    }
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
