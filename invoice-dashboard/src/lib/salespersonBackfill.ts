import { SupabaseClient } from "@supabase/supabase-js";

/**
 * Backfill missing flight data from the trip_salespersons table.
 *
 * The JetInsight JSON schedule sync populates flights but some fields arrive
 * late or not at all:
 *   - salesperson: backfilled by a separate rate-limited scraper
 *   - customer_name: populated by JSON but missing on ICS-only flights
 *   - origin_fbo / destination_fbo: populated by JSON but also in CSV uploads
 *
 * trip_salespersons (from CSV upload) has all of these. This function patches
 * any gaps in-memory by matching on jetinsight_trip_id + route.
 *
 * Mutates the flights array in place.
 */
export async function backfillSalesperson(
  supa: SupabaseClient,
  flights: Array<{
    jetinsight_trip_id?: string | null;
    departure_icao?: string | null;
    arrival_icao?: string | null;
    salesperson?: string | null;
    customer_name?: string | null;
    origin_fbo?: string | null;
    destination_fbo?: string | null;
    flight_type?: string | null;
  }>,
  /** Only backfill flights matching these types. Pass null to backfill all. */
  flightTypes: string[] | null = ["Revenue", "Owner", "Charter"],
): Promise<number> {
  // Find flights that have a trip ID and are missing any backfillable field
  const candidates = flights.filter(
    (f) =>
      f.jetinsight_trip_id &&
      (!f.salesperson || !f.customer_name || !f.origin_fbo || !f.destination_fbo) &&
      (flightTypes === null || (f.flight_type && flightTypes.includes(f.flight_type))),
  );

  const tripIds = [...new Set(candidates.map((f) => f.jetinsight_trip_id as string))];
  if (tripIds.length === 0) return 0;

  const { data: tripSP } = await supa
    .from("trip_salespersons")
    .select("trip_id, origin_icao, destination_icao, salesperson_name, customer, origin_fbo, destination_fbo")
    .in("trip_id", tripIds);

  if (!tripSP || tripSP.length === 0) return 0;

  // Build lookup: trip_id|dep|arr → enrichment data
  const lookup = new Map<string, {
    salesperson: string;
    customer: string;
    origin_fbo: string | null;
    destination_fbo: string | null;
  }>();
  for (const sp of tripSP) {
    const key = `${sp.trip_id}|${sp.origin_icao}|${sp.destination_icao}`;
    lookup.set(key, {
      salesperson: sp.salesperson_name,
      customer: sp.customer ?? "",
      origin_fbo: sp.origin_fbo ?? null,
      destination_fbo: sp.destination_fbo ?? null,
    });
  }

  let filled = 0;
  for (const f of flights) {
    if (!f.jetinsight_trip_id) continue;
    const key = `${f.jetinsight_trip_id}|${f.departure_icao}|${f.arrival_icao}`;
    const sp = lookup.get(key);
    if (!sp) continue;

    let changed = false;
    if (!f.salesperson && sp.salesperson) {
      f.salesperson = sp.salesperson;
      changed = true;
    }
    if (!f.customer_name && sp.customer) {
      f.customer_name = sp.customer;
      changed = true;
    }
    if (!f.origin_fbo && sp.origin_fbo) {
      f.origin_fbo = sp.origin_fbo;
      changed = true;
    }
    if (!f.destination_fbo && sp.destination_fbo) {
      f.destination_fbo = sp.destination_fbo;
      changed = true;
    }
    if (changed) filled++;
  }

  return filled;
}
