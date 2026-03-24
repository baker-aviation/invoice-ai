export const dynamic = "force-dynamic";

import { Topbar } from "@/components/Topbar";
import { AutoRefresh } from "@/components/AutoRefresh";
import { fetchFlights, fetchMxNotes, fetchMelItems, fetchAircraftTags } from "@/lib/opsApi";
import { createServiceClient } from "@/lib/supabase/service";
import VanPositioningClient from "./VanPositioningWrapper";

export default async function MaintenancePage() {
  const supa = createServiceClient();
  const now = new Date();
  const past = new Date(now.getTime() - 7 * 86400000).toISOString();
  const future = new Date(now.getTime() + 7 * 86400000).toISOString();

  const [flightData, mxNotes, melItems, aircraftTags] = await Promise.all([
    fetchFlights({ lookahead_hours: 720, lookback_hours: 168 }).catch(() => ({
      ok: false,
      flights: [],
      count: 0,
    })),
    fetchMxNotes().catch(() => []),
    fetchMelItems().catch(() => []),
    fetchAircraftTags().catch(() => []),
  ]);

  const { data: fboRows } = await supa
    .from("trip_salespersons")
    .select("tail_number, destination_icao, destination_fbo")
    .not("destination_fbo", "is", null)
    .gte("scheduled_departure", past)
    .lte("scheduled_departure", future);

  const fboMap: Record<string, string> = {};
  for (const row of fboRows ?? []) {
    if (row.tail_number && row.destination_icao && row.destination_fbo) {
      fboMap[`${row.tail_number}:${row.destination_icao}`] = row.destination_fbo;
    }
  }

  return (
    <>
      <Topbar title="AOG Van Action Plan" />
      <AutoRefresh intervalSeconds={240} />
      <div className="p-6 space-y-2">
        <p className="text-sm text-gray-500">
          7-day aircraft positioning from JetInsight · AOG vans · live tracking via Samsara · Priority: overnight service
        </p>
        <VanPositioningClient initialFlights={flightData.flights} mxNotes={mxNotes} melItems={melItems} aircraftTags={aircraftTags} fboMap={fboMap} />
      </div>
    </>
  );
}
