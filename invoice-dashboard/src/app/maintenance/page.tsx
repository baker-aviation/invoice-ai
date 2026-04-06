export const dynamic = "force-dynamic";

import { Topbar } from "@/components/Topbar";
import { AutoRefresh } from "@/components/AutoRefresh";
import { fetchFlightsLite, fetchMxNotes, fetchMelItems, fetchAircraftTags } from "@/lib/opsApi";
import { buildFboHoursMap } from "@/lib/fboHours";
import VanPositioningClient from "./VanPositioningWrapper";

export default async function MaintenancePage() {
  const [flightData, mxNotes, melItems, aircraftTags] = await Promise.all([
    fetchFlightsLite({ lookahead_hours: 240, lookback_hours: 168 }).catch(() => ({
      ok: false,
      flights: [],
      count: 0,
    })),
    fetchMxNotes().catch(() => []),
    fetchMelItems().catch(() => []),
    fetchAircraftTags().catch(() => []),
  ]);

  // Build FBO map from flights data (populated by JetInsight scraper)
  const fboMap: Record<string, string> = {};
  for (const f of flightData.flights) {
    if (f.tail_number && f.arrival_icao && f.destination_fbo) {
      fboMap[`${f.tail_number}:${f.arrival_icao}`] = f.destination_fbo;
    }
  }

  // Build FBO hours lookup (matches fboMap entries against scraped hours data)
  const fboHoursMap = await buildFboHoursMap(fboMap);

  return (
    <>
      <Topbar title="AOG Van Action Plan" />
      <AutoRefresh intervalSeconds={240} />
      <div className="p-6 space-y-2">
        <p className="text-sm text-gray-500">
          5-day aircraft positioning from JetInsight · AOG vans · live tracking via Samsara · Priority: overnight service
        </p>
        <VanPositioningClient initialFlights={flightData.flights} mxNotes={mxNotes} melItems={melItems} aircraftTags={aircraftTags} fboMap={fboMap} fboHoursMap={fboHoursMap} />
      </div>
    </>
  );
}
