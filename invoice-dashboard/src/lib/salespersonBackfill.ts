import { SupabaseClient } from "@supabase/supabase-js";

/**
 * Backfill missing salesperson data on flights from the trip_salespersons table.
 *
 * The JetInsight schedule sync populates flights via JSON but the salesperson
 * field is backfilled by a separate rate-limited scraper. When the scraper
 * hasn't caught up, flights.salesperson is null even though the data exists
 * in trip_salespersons. This function patches that gap in-memory.
 *
 * Mutates the flights array in place — sets .salesperson and optionally
 * .customer_name on flights that have a jetinsight_trip_id but no salesperson.
 */
export async function backfillSalesperson(
  supa: SupabaseClient,
  flights: Array<{
    jetinsight_trip_id?: string | null;
    departure_icao?: string | null;
    arrival_icao?: string | null;
    salesperson?: string | null;
    customer_name?: string | null;
    flight_type?: string | null;
  }>,
  /** Only backfill flights matching these types. Pass null to backfill all. */
  flightTypes: string[] | null = ["Revenue", "Owner", "Charter"],
): Promise<number> {
  const missing = flights.filter(
    (f) =>
      !f.salesperson &&
      f.jetinsight_trip_id &&
      (flightTypes === null || (f.flight_type && flightTypes.includes(f.flight_type))),
  );

  const tripIds = [...new Set(missing.map((f) => f.jetinsight_trip_id as string))];
  if (tripIds.length === 0) return 0;

  const { data: tripSP } = await supa
    .from("trip_salespersons")
    .select("trip_id, origin_icao, destination_icao, salesperson_name, customer")
    .in("trip_id", tripIds);

  if (!tripSP || tripSP.length === 0) return 0;

  // Build lookup: trip_id|dep|arr → salesperson info
  const lookup = new Map<string, { salesperson: string; customer: string }>();
  for (const sp of tripSP) {
    const key = `${sp.trip_id}|${sp.origin_icao}|${sp.destination_icao}`;
    lookup.set(key, { salesperson: sp.salesperson_name, customer: sp.customer ?? "" });
  }

  let filled = 0;
  for (const f of flights) {
    if (!f.salesperson && f.jetinsight_trip_id) {
      const key = `${f.jetinsight_trip_id}|${f.departure_icao}|${f.arrival_icao}`;
      const sp = lookup.get(key);
      if (sp) {
        f.salesperson = sp.salesperson;
        if (!f.customer_name) f.customer_name = sp.customer;
        filled++;
      }
    }
  }

  return filled;
}
