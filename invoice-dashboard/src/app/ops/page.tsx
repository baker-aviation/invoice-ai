export const dynamic = "force-dynamic";

import { Topbar } from "@/components/Topbar";
import { AutoRefresh } from "@/components/AutoRefresh";
import { fetchFlights } from "@/lib/opsApi";
import OpsBoard from "./OpsBoard";

export default async function OpsPage() {
  let error: string | null = null;
  const data = await fetchFlights({ lookahead_hours: 168 }).catch((e) => {
    error = String(e);
    return { ok: false, flights: [] as any[], count: 0 };
  });

  return (
    <>
      <Topbar title="Operations" />
      <AutoRefresh intervalSeconds={240} />
      {error && (
        <div className="mx-6 mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          <strong>API error:</strong> {error}
        </div>
      )}
      <OpsBoard initialFlights={data.flights} />
    </>
  );
}
