export const dynamic = "force-dynamic";

import { Topbar } from "@/components/Topbar";
import { AutoRefresh } from "@/components/AutoRefresh";
import { fetchFlights, fetchMxNotes } from "@/lib/opsApi";
import VanPositioningClient from "./VanPositioningClient";

export default async function MaintenancePage() {
  const [flightData, mxNotes] = await Promise.all([
    fetchFlights({ lookahead_hours: 72, lookback_hours: 168 }).catch(() => ({
      ok: false,
      flights: [],
      count: 0,
    })),
    fetchMxNotes().catch(() => []),
  ]);

  return (
    <>
      <Topbar title="AOG Van Action Plan" />
      <AutoRefresh intervalSeconds={240} />
      <div className="p-6 space-y-2">
        <p className="text-sm text-gray-500">
          7-day aircraft positioning from JetInsight · AOG vans · live tracking via Samsara · Priority: overnight service
        </p>
        <VanPositioningClient initialFlights={flightData.flights} mxNotes={mxNotes} />
      </div>
    </>
  );
}
