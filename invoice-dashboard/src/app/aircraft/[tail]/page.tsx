export const dynamic = "force-dynamic";

import { Topbar } from "@/components/Topbar";
import { createServiceClient } from "@/lib/supabase/service";
import AircraftDetailClient from "./AircraftDetailClient";

export default async function AircraftDetailPage({
  params,
}: {
  params: Promise<{ tail: string }>;
}) {
  const { tail } = await params;
  const supa = createServiceClient();

  const [trackerRes, melRes, flightsRes, tagsRes] = await Promise.all([
    supa
      .from("aircraft_tracker")
      .select("*")
      .eq("tail_number", tail)
      .maybeSingle(),
    supa
      .from("mel_items")
      .select("*")
      .eq("tail_number", tail)
      .eq("status", "open")
      .order("deferred_date", { ascending: false }),
    supa
      .from("flights")
      .select("id, tail_number, departure_icao, arrival_icao, scheduled_departure, scheduled_arrival, flight_type, pic, sic, pax_count")
      .eq("tail_number", tail)
      .order("scheduled_departure", { ascending: false })
      .limit(50),
    supa
      .from("aircraft_tags")
      .select("*")
      .eq("tail_number", tail)
      .order("created_at", { ascending: false }),
  ]);

  return (
    <>
      <Topbar title={`Aircraft — ${tail}`} />
      <AircraftDetailClient
        tail={tail}
        tracker={trackerRes.data}
        melItems={melRes.data ?? []}
        flights={flightsRes.data ?? []}
        tags={tagsRes.data ?? []}
      />
    </>
  );
}
