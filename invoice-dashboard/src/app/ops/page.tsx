export const dynamic = "force-dynamic";

import { Topbar } from "@/components/Topbar";
import { AutoRefresh } from "@/components/AutoRefresh";
import { fetchFlights } from "@/lib/opsApi";
import OpsBoard from "./OpsBoard";

export default async function OpsPage() {
  const data = await fetchFlights({ lookahead_hours: 168 }).catch(() => ({
    ok: false,
    flights: [],
    count: 0,
  }));

  return (
    <>
      <Topbar title="Operations" />
      <AutoRefresh intervalSeconds={240} />
      <OpsBoard initialFlights={data.flights} />
    </>
  );
}
