export const dynamic = "force-dynamic";

import { Topbar } from "@/components/Topbar";
import { AutoRefresh } from "@/components/AutoRefresh";
import { fetchFlights } from "@/lib/opsApi";
import OpsBoard from "./OpsBoard";

export default async function OpsPage() {
  let error: string | null = null;
  const data = await fetchFlights({ lookahead_hours: 720 }).catch((e) => {
    error = String(e);
    return { ok: false, flights: [] as any[], count: 0, error: null as string | null };
  });

  // Surface backend error (returned as JSON with ok:false) vs fetch error
  const displayError = error || (data.ok === false && (data as any).error ? (data as any).error : null);

  return (
    <>
      <Topbar title="Operations" />
      <AutoRefresh intervalSeconds={240} />
      {displayError && (
        <div className="mx-6 mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          <strong>API error:</strong> {displayError}
        </div>
      )}
      <OpsBoard initialFlights={data.flights} />
    </>
  );
}
