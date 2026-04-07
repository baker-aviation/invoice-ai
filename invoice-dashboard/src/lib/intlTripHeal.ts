import { SupabaseClient } from "@supabase/supabase-js";

type HealResult = {
  healed: number;
  updatedTrips: Array<{ tripId: string; oldFlightIds: string[]; newFlightIds: string[]; newTail?: string }>;
};

/**
 * Auto-heal orphaned flight_ids on intl_trips.
 *
 * When JetInsight swaps tails, flights get deleted and recreated with new UUIDs.
 * This finds trips whose flight_ids no longer exist in the flights table and
 * re-resolves them using jetinsight_trip_id.
 *
 * Can be called from:
 * - trips GET endpoint (heals all trips on page load)
 * - trip-bundle GET endpoint (heals a single trip on detail view)
 */
export async function healOrphanedFlightIds(
  supa: SupabaseClient,
  trips: Array<{
    id: string;
    flight_ids: string[];
    jetinsight_trip_id: string | null;
    tail_number: string;
    route_icaos: string[];
    schedule_snapshot?: Record<string, { dep: string; arr: string | null }> | null;
  }>,
): Promise<HealResult> {
  if (trips.length === 0) return { healed: 0, updatedTrips: [] };

  // Batch-check which flight_ids actually exist
  const allFids = [...new Set(trips.flatMap((t) => t.flight_ids))];
  if (allFids.length === 0) return { healed: 0, updatedTrips: [] };

  const { data: existingFlights } = await supa
    .from("flights")
    .select("id")
    .in("id", allFids);

  const existingIds = new Set((existingFlights ?? []).map((f) => f.id));

  // Find trips with orphaned flight_ids that have a JI trip ID for re-resolution
  const tripsToHeal = trips.filter((t) =>
    t.jetinsight_trip_id &&
    t.flight_ids.some((fid) => !existingIds.has(fid))
  );

  if (tripsToHeal.length === 0) return { healed: 0, updatedTrips: [] };

  // Batch-fetch replacement flights by jetinsight_trip_id
  const jiIds = [...new Set(tripsToHeal.map((t) => t.jetinsight_trip_id!))];
  const { data: replacements } = await supa
    .from("flights")
    .select("id, tail_number, jetinsight_trip_id, scheduled_departure, scheduled_arrival, departure_icao, arrival_icao, jetinsight_url")
    .in("jetinsight_trip_id", jiIds)
    .order("scheduled_departure");

  const byJiTrip = new Map<string, NonNullable<typeof replacements>>();
  for (const f of replacements ?? []) {
    if (!f.jetinsight_trip_id) continue;
    if (!byJiTrip.has(f.jetinsight_trip_id)) byJiTrip.set(f.jetinsight_trip_id, []);
    byJiTrip.get(f.jetinsight_trip_id)!.push(f);
  }

  const result: HealResult = { healed: 0, updatedTrips: [] };
  const updates: PromiseLike<unknown>[] = [];

  for (const t of tripsToHeal) {
    const newFlights = byJiTrip.get(t.jetinsight_trip_id!) ?? [];
    if (newFlights.length === 0) continue;

    const oldFlightIds = [...t.flight_ids];
    const newFlightIds = newFlights.map((f) => f.id);

    // Build new route from flight data
    const newRoute = newFlights.map((f) => f.departure_icao).filter(Boolean) as string[];
    const lastArr = newFlights[newFlights.length - 1]?.arrival_icao;
    if (lastArr) newRoute.push(lastArr);

    // Check if tail changed
    const newTail = newFlights[0]?.tail_number;

    // Update in-memory
    t.flight_ids = newFlightIds;
    if (newRoute.length >= 2) t.route_icaos = newRoute;
    if (newTail && newTail !== t.tail_number) t.tail_number = newTail;

    // Build snapshot
    const newSnap: Record<string, { dep: string; arr: string | null }> = {};
    for (const f of newFlights) {
      newSnap[f.id] = { dep: f.scheduled_departure, arr: f.scheduled_arrival ?? null };
    }
    if (Object.keys(newSnap).length > 0) t.schedule_snapshot = newSnap;

    // Persist
    const dbUpdates: Record<string, unknown> = {
      flight_ids: newFlightIds,
      updated_at: new Date().toISOString(),
    };
    if (newRoute.length >= 2) dbUpdates.route_icaos = newRoute;
    if (newTail && newTail !== t.tail_number) dbUpdates.tail_number = newTail;
    if (Object.keys(newSnap).length > 0) dbUpdates.schedule_snapshot = newSnap;

    updates.push(supa.from("intl_trips").update(dbUpdates).eq("id", t.id));

    result.healed++;
    result.updatedTrips.push({
      tripId: t.id,
      oldFlightIds,
      newFlightIds,
      newTail: newTail !== t.tail_number ? newTail ?? undefined : undefined,
    });
    console.log(`[intl/heal] Auto-healed trip ${t.id} (${t.jetinsight_trip_id}): ${oldFlightIds.length} → ${newFlightIds.length} flight(s)${newTail && newTail !== oldFlightIds[0] ? ` tail→${newTail}` : ""}`);
  }

  if (updates.length > 0) await Promise.all(updates);
  return result;
}
