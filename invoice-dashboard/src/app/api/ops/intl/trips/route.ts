import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthed, isRateLimited, verifyCronSecret } from "@/lib/api-auth";
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
  jetinsight_url?: string | null;
};

type DetectedTrip = {
  tail_number: string;
  route_icaos: string[];
  flight_ids: string[];
  trip_date: string;
  jetinsight_trip_id: string | null;
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

        // Extract JI trip ID from first flight's jetinsight_url
        const jiUrl = f.jetinsight_url ?? tailFlights.slice(i, j).find((x) => x.jetinsight_url)?.jetinsight_url;
        const jiMatch = jiUrl?.match(/\/trips\/([A-Za-z0-9]+)/);
        const jetinsight_trip_id = jiMatch ? jiMatch[1] : null;

        trips.push({
          tail_number: tail,
          route_icaos: route,
          flight_ids: flightIds,
          trip_date: new Date(f.scheduled_departure).toISOString().slice(0, 10),
          jetinsight_trip_id,
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
  // Allow cron to trigger detection without user auth
  const isCron = verifyCronSecret(req);
  if (!isCron) {
    const auth = await requireAuth(req);
    if (!isAuthed(auth)) return auth.error;
  }

  const supa = createServiceClient();
  // Detection runs on cron or explicit request — never on normal page load
  const autoDetect = isCron || req.nextUrl.searchParams.get("auto_detect") === "true";

  if (autoDetect) {
    // Fetch flights for the next 30 days
    const now = new Date();
    const lookback = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
    const lookahead = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();

    const { data: flights } = await supa
      .from("flights")
      .select("id, tail_number, departure_icao, arrival_icao, scheduled_departure, scheduled_arrival, jetinsight_url")
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

      // Batch-fetch all existing trips (wider date window to catch date shifts + tail changes)
      const lookbackDate = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const { data: allExisting } = await supa
        .from("intl_trips")
        .select("id, tail_number, trip_date, route_icaos, flight_ids, jetinsight_trip_id")
        .gte("trip_date", lookbackDate);

      // Index existing trips by tail and by JI trip ID for matching
      const existingByTail = new Map<string, typeof allExisting>();
      const existingByJiId = new Map<string, NonNullable<typeof allExisting>[0]>();
      for (const e of allExisting ?? []) {
        if (!existingByTail.has(e.tail_number)) existingByTail.set(e.tail_number, []);
        existingByTail.get(e.tail_number)!.push(e);
        if (e.jetinsight_trip_id) existingByJiId.set(e.jetinsight_trip_id, e);
      }

      // Build a lookup for schedule snapshots from flight data
      const flightMap = new Map<string, { dep: string; arr: string | null }>();
      for (const f of flights as Array<{ id: string; scheduled_departure: string; scheduled_arrival: string | null }>) {
        flightMap.set(f.id, { dep: f.scheduled_departure, arr: f.scheduled_arrival ?? null });
      }

      // Batch-fetch ALL clearances for existing trips (avoid per-trip DB calls in loop)
      const existingTripIds = (allExisting ?? []).map((e) => e.id);
      const allClearancesMap = new Map<string, Array<{ id: string; clearance_type: string; airport_icao: string; status: string; file_gcs_key: string | null; sort_order: number; notes: string | null }>>();
      if (existingTripIds.length > 0) {
        const { data: allClearances } = await supa
          .from("intl_trip_clearances")
          .select("id, trip_id, clearance_type, airport_icao, status, file_gcs_key, sort_order, notes")
          .in("trip_id", existingTripIds);
        for (const c of allClearances ?? []) {
          if (!allClearancesMap.has(c.trip_id)) allClearancesMap.set(c.trip_id, []);
          allClearancesMap.get(c.trip_id)!.push(c);
        }
      }

      // Track which existing trip IDs are still matched (for orphan cleanup)
      const matchedExistingIds = new Set<string>();
      const detectedFlightIdSets = new Set<string>();

      // Upsert trips
      const updatePromises: PromiseLike<unknown>[] = [];
      const toInsert: DetectedTrip[] = [];
      const routeChangeAlerts: { flight_id: string; old_route: string[]; new_route: string[]; tail: string }[] = [];
      const tailChangeAlerts: { flight_id: string; old_tail: string; new_tail: string; route: string[] }[] = [];

      for (const dt of detected) {
        // Collect all flight IDs from this detected trip for dedup tracking
        for (const fid of dt.flight_ids) detectedFlightIdSets.add(fid);

        const candidates = existingByTail.get(dt.tail_number) ?? [];

        // 0. Try JI trip ID match first — the most stable identifier
        let match: NonNullable<typeof allExisting>[0] | undefined;
        let tailChanged = false;
        if (dt.jetinsight_trip_id) {
          const jiMatch = existingByJiId.get(dt.jetinsight_trip_id);
          if (jiMatch && !matchedExistingIds.has(jiMatch.id)) {
            match = jiMatch;
            tailChanged = jiMatch.tail_number !== dt.tail_number;
          }
        }

        // 1. Try exact match: same tail + date + route
        if (!match) {
          match = candidates.find(
            (e) => e.trip_date === dt.trip_date &&
                   JSON.stringify(e.route_icaos) === JSON.stringify(dt.route_icaos)
          );
        }

        // 2. Try flight_ids overlap on same tail: same flights, route or date changed
        if (!match) {
          const dtFlightSet = new Set(dt.flight_ids);
          match = candidates.find((e) => {
            if (!e.flight_ids?.length) return false;
            return e.flight_ids.some((fid: string) => dtFlightSet.has(fid));
          });
        }

        // 3. Try flight_ids overlap across ALL tails: aircraft swap (flights moved to different tail)
        if (!match) {
          const dtFlightSet = new Set(dt.flight_ids);
          for (const [, tailTrips] of existingByTail) {
            if (!tailTrips) continue;
            const crossMatch = tailTrips.find((e) => {
              if (matchedExistingIds.has(e.id)) return false;
              if (!e.flight_ids?.length) return false;
              return e.flight_ids.some((fid: string) => dtFlightSet.has(fid));
            });
            if (crossMatch) {
              match = crossMatch;
              tailChanged = true;
              break;
            }
          }
        }

        // 4. Try same tail + date (within ±1 day) with no other match — likely same trip rescheduled
        if (!match) {
          const dtDate = new Date(dt.trip_date + "T00:00:00Z").getTime();
          match = candidates.find((e) => {
            if (matchedExistingIds.has(e.id)) return false; // already claimed
            const eDate = new Date(e.trip_date + "T00:00:00Z").getTime();
            return Math.abs(eDate - dtDate) <= 24 * 60 * 60 * 1000;
          });
        }

        if (match) {
          matchedExistingIds.add(match.id);
          const routeChanged = JSON.stringify(match.route_icaos) !== JSON.stringify(dt.route_icaos);
          const dateChanged = match.trip_date !== dt.trip_date;
          const flightsChanged = JSON.stringify(match.flight_ids) !== JSON.stringify(dt.flight_ids);
          tailChanged = tailChanged || match.tail_number !== dt.tail_number;
          const jiIdChanged = dt.jetinsight_trip_id && match.jetinsight_trip_id !== dt.jetinsight_trip_id;

          if (routeChanged || dateChanged || flightsChanged || tailChanged || jiIdChanged) {
            const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
            if (routeChanged) updates.route_icaos = dt.route_icaos;
            if (dateChanged) updates.trip_date = dt.trip_date;
            if (flightsChanged) {
              updates.flight_ids = dt.flight_ids;
              // Rebuild snapshot baseline for the new flight set
              const newSnap: Record<string, { dep: string; arr: string | null }> = {};
              for (const fid of dt.flight_ids) {
                const times = flightMap.get(fid);
                if (times) newSnap[fid] = times;
              }
              if (Object.keys(newSnap).length > 0) updates.schedule_snapshot = newSnap;
            }
            if (tailChanged) updates.tail_number = dt.tail_number;
            if (jiIdChanged) updates.jetinsight_trip_id = dt.jetinsight_trip_id;

            updatePromises.push(
              supa.from("intl_trips").update(updates).eq("id", match.id)
            );

            // Check if trip has been "started" (any clearance beyond not_started)
            // Only fire change alerts if someone is actively working this trip
            const existingClearancesForTrip = allClearancesMap.get(match.id) ?? [];
            const tripStarted = existingClearancesForTrip.some(
              (c) => c.status !== "not_started"
            );

            if (tripStarted) {
              // If tail changed, fire a tail_change alert (permits may need resubmission)
              if (tailChanged) {
                tailChangeAlerts.push({
                  flight_id: dt.flight_ids[0],
                  old_tail: match.tail_number,
                  new_tail: dt.tail_number,
                  route: dt.route_icaos,
                });
              }
            }

            // If route changed, always rebuild clearances (but only alert if started)
            if (routeChanged) {
              if (tripStarted) {
                routeChangeAlerts.push({
                  flight_id: dt.flight_ids[0],
                  old_route: match.route_icaos,
                  new_route: dt.route_icaos,
                  tail: dt.tail_number,
                });
              }

              // Use pre-fetched clearances for this trip
              const existingClearances = allClearancesMap.get(match.id) ?? [];

              const newClearances = buildDefaultClearances(dt, countriesWithOvfReq);
              const keepIds = new Set<string>();

              // For each new clearance, try to find a matching existing one (same type + airport)
              for (const nc of newClearances) {
                const existing = (existingClearances ?? []).find(
                  (ec) => ec.clearance_type === nc.clearance_type && ec.airport_icao === nc.airport_icao
                );
                if (existing) {
                  keepIds.add(existing.id);
                }
              }

              // Delete clearances that are no longer on the route
              const toDelete = (existingClearances ?? []).filter((ec) => !keepIds.has(ec.id));
              if (toDelete.length > 0) {
                updatePromises.push(
                  supa.from("intl_trip_clearances")
                    .delete()
                    .in("id", toDelete.map((c) => c.id))
                );
              }

              // Insert clearances that are new (not matched to existing)
              const toAdd = newClearances.filter((nc) => {
                return !(existingClearances ?? []).some(
                  (ec) => ec.clearance_type === nc.clearance_type && ec.airport_icao === nc.airport_icao
                );
              });
              if (toAdd.length > 0) {
                updatePromises.push(
                  supa.from("intl_trip_clearances").insert(
                    toAdd.map((c) => ({ ...c, trip_id: match!.id }))
                  )
                );
              }
            }
          }
        } else {
          toInsert.push(dt);
        }
      }

      // Run updates in parallel
      if (updatePromises.length > 0) await Promise.all(updatePromises);

      // Create change alerts
      const changeAlerts: { flight_id: string; alert_type: string; severity: string; message: string; acknowledged: boolean }[] = [];
      for (const a of routeChangeAlerts) {
        changeAlerts.push({
          flight_id: a.flight_id,
          alert_type: "schedule_change",
          severity: "warning",
          message: `${a.tail} route changed: ${a.old_route.join("→")} ➜ ${a.new_route.join("→")}`,
          acknowledged: false,
        });
      }
      for (const a of tailChangeAlerts) {
        changeAlerts.push({
          flight_id: a.flight_id,
          alert_type: "tail_change",
          severity: "critical",
          message: `Aircraft changed from ${a.old_tail} to ${a.new_tail} on ${a.route.join("→")} — permits may need resubmission`,
          acknowledged: false,
        });
      }
      if (changeAlerts.length > 0) {
        const { error: alertErr } = await supa.from("intl_leg_alerts").insert(changeAlerts);
        if (alertErr) console.error("[intl/trips] change alert error:", alertErr);
      }

      // Batch insert truly new trips
      for (const dt of toInsert) {
        // Build initial schedule_snapshot so run-checks has a baseline
        const initSnap: Record<string, { dep: string; arr: string | null }> = {};
        for (const fid of dt.flight_ids) {
          const times = flightMap.get(fid);
          if (times) initSnap[fid] = times;
        }

        const { data: newTrip, error: tripErr } = await supa
          .from("intl_trips")
          .insert({
            tail_number: dt.tail_number,
            route_icaos: dt.route_icaos,
            flight_ids: dt.flight_ids,
            trip_date: dt.trip_date,
            schedule_snapshot: Object.keys(initSnap).length > 0 ? initSnap : null,
            jetinsight_trip_id: dt.jetinsight_trip_id,
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

      // Clean up orphaned trips: existing trips whose flights no longer
      // appear in any detected trip (schedule was cancelled/changed)
      const orphanCandidates = (allExisting ?? [])
        .filter((e) => !matchedExistingIds.has(e.id))
        .filter((e) => {
          // Only orphan if ALL its flight_ids are absent from detected trips
          if (!e.flight_ids?.length) return false;
          return e.flight_ids.every((fid: string) => !detectedFlightIdSets.has(fid));
        });

      if (orphanCandidates.length > 0) {
        // Check which orphans have been started (any clearance beyond not_started)
        const orphanIds = orphanCandidates.map((e) => e.id);

        const startedTripIds = new Set(
          orphanIds.filter((id) => {
            const cl = allClearancesMap.get(id) ?? [];
            return cl.some((c) => c.status !== "not_started");
          })
        );

        // Auto-delete unstarted orphans (no work to lose)
        const safeToDelete = orphanIds.filter((id) => !startedTripIds.has(id));
        if (safeToDelete.length > 0) {
          await supa.from("intl_trip_clearances").delete().in("trip_id", safeToDelete);
          await supa.from("intl_trips").delete().in("id", safeToDelete);
          console.log(`[intl/trips] Deleted ${safeToDelete.length} orphaned unstarted trip(s)`);
        }

        // Log started orphans — don't delete, someone was working on them
        const startedOrphans = orphanIds.filter((id) => startedTripIds.has(id));
        if (startedOrphans.length > 0) {
          console.log(`[intl/trips] ${startedOrphans.length} orphaned STARTED trip(s) kept:`, startedOrphans);
        }
      }
    }
  }

  // Fetch all trips with clearances
  const { data: trips, error } = await supa
    .from("intl_trips")
    .select("*, clearances:intl_trip_clearances(*)")
    .gte("trip_date", new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10))
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
  const snapshotBackfills: PromiseLike<unknown>[] = [];
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
    const computedSnap = Object.keys(snap).length > 0 ? snap : null;

    // Backfill: seed snapshot in DB if missing so run-checks has a baseline
    if (!t.schedule_snapshot && computedSnap) {
      snapshotBackfills.push(
        supa.from("intl_trips").update({ schedule_snapshot: computedSnap }).eq("id", t.id).then()
      );
    }

    t.schedule_snapshot = computedSnap;
  }
  if (snapshotBackfills.length > 0) await Promise.all(snapshotBackfills);

  // Fetch passenger + salesperson data from trip_salespersons (CSV upload)
  const tripTails = [...new Set((trips ?? []).map((t) => t.tail_number).filter(Boolean))];
  const salespersonMap = new Map<string, string>();
  const csvPaxMap = new Map<string, string>();
  if (tripTails.length > 0) {
    const { data: paxRows } = await supa
      .from("trip_salespersons")
      .select("trip_id, tail_number, origin_icao, destination_icao, passengers, salesperson_name")
      .in("tail_number", tripTails);

    for (const p of paxRows ?? []) {
      const key = `${p.tail_number}|${p.origin_icao}|${p.destination_icao}`;
      if (p.passengers) csvPaxMap.set(key, p.passengers);
      if (p.salesperson_name && !salespersonMap.has(p.tail_number)) {
        salespersonMap.set(p.tail_number, p.salesperson_name);
      }
    }
  }

  // Fetch passenger data from JetInsight scraper (auto-synced)
  const jiPaxMap = new Map<string, string[]>(); // ji_trip_id → passenger names
  const jiTripIds = (trips ?? []).map((t) => t.jetinsight_trip_id).filter(Boolean) as string[];
  if (jiTripIds.length > 0) {
    const { data: jiPaxRows } = await supa
      .from("jetinsight_trip_passengers")
      .select("jetinsight_trip_id, passenger_name")
      .in("jetinsight_trip_id", jiTripIds);

    for (const p of jiPaxRows ?? []) {
      if (!jiPaxMap.has(p.jetinsight_trip_id)) jiPaxMap.set(p.jetinsight_trip_id, []);
      jiPaxMap.get(p.jetinsight_trip_id)!.push(p.passenger_name);
    }
  }

  // Also fetch flight_type to identify positioning legs
  const flightTypeMap = new Map<string, string>();
  if (allFlightIds.size > 0) {
    const { data: ftRows } = await supa
      .from("flights")
      .select("id, flight_type")
      .in("id", [...allFlightIds]);
    for (const f of ftRows ?? []) {
      if (f.flight_type) flightTypeMap.set(f.id, f.flight_type);
    }
  }

  // Attach passengers + salesperson + positioning info to each trip
  for (const t of trips ?? []) {
    if (salespersonMap.has(t.tail_number)) t.salesperson = salespersonMap.get(t.tail_number)!;

    // Check if trip has any revenue legs (non-positioning)
    const hasRevenueLeg = (t.flight_ids ?? []).some((fid: string) => {
      const ft = flightTypeMap.get(fid);
      return !ft || !/(positioning|repo|ferry|maintenance)/i.test(ft);
    });

    // Get passengers from JI scraper first, fall back to CSV
    const jiPax = t.jetinsight_trip_id ? jiPaxMap.get(t.jetinsight_trip_id) : null;

    const route = t.route_icaos ?? [];
    const legPax: Array<{ dep: string; arr: string; passengers: string }> = [];

    if (jiPax && jiPax.length > 0) {
      // JI passengers are per-trip, not per-leg — show on first revenue leg
      legPax.push({ dep: route[0] ?? "", arr: route[route.length - 1] ?? "", passengers: jiPax.join(", ") });
    } else {
      // Fall back to CSV per-leg data
      for (let i = 0; i < route.length - 1; i++) {
        const key = `${t.tail_number}|${route[i]}|${route[i + 1]}`;
        const pax = csvPaxMap.get(key);
        if (pax) legPax.push({ dep: route[i], arr: route[i + 1], passengers: pax });
      }
    }

    if (legPax.length > 0) t.leg_passengers = legPax;
    // Flag if this is an all-positioning trip (no pax expected)
    t.is_positioning = !hasRevenueLeg;
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
  const detected: DetectedTrip = { tail_number, route_icaos, flight_ids: [], trip_date, jetinsight_trip_id: null };
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
