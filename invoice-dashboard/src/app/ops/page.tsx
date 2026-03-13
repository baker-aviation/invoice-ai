export const dynamic = "force-dynamic";

import { Topbar } from "@/components/Topbar";
import { AutoRefresh } from "@/components/AutoRefresh";
import { fetchFlights, fetchMxNotes, fetchSwimFlowControl } from "@/lib/opsApi";
import { fetchAdvertisedPrices } from "@/lib/invoiceApi";
import { createClient } from "@/lib/supabase/server";
import OpsTabs from "./OpsTabs";

export default async function OpsPage() {
  let error: string | null = null;
  // lookback 48h so "Today" filter never loses earlier flights as the UTC day progresses,
  // and duty tracking can see yesterday's legs for rolling-24hr calculations.
  const t0 = Date.now();
  const timings: Record<string, number> = {};
  const timed = <T,>(label: string, p: Promise<T>): Promise<T> =>
    p.then((r) => { timings[label] = Date.now() - t0; return r; });

  const [data, advertisedPrices, mxNotes, swimFlow, pprRows] = await Promise.all([
    timed("flights", fetchFlights({ lookahead_hours: 48, lookback_hours: 48 }).catch((e) => {
      error = String(e);
      return { ok: false, flights: [] as any[], count: 0, error: null as string | null };
    })),
    timed("fuel_prices", fetchAdvertisedPrices().catch(() => [])),
    timed("mx_notes", fetchMxNotes().catch(() => [])),
    timed("swim_flow", fetchSwimFlowControl().catch(() => [])),
    timed("ppr", createClient().then((s) => s.from("baker_ppr_airports").select("icao")).then((r) => r.data).catch(() => [])),
  ]);
  timings.total = Date.now() - t0;
  console.log(`[ops/page] timings:`, timings);
  const bakerPprAirports: string[] = (pprRows ?? []).map((r: { icao: string }) => r.icao);

  const displayError = error || (data.ok === false && (data as any).error ? (data as any).error : null);

  return (
    <>
      <Topbar title="Operations" />
      <AutoRefresh intervalSeconds={240} />
      {/* DEBUG: server-side query timings — remove after profiling */}
      <div className="mx-6 mt-2 text-[10px] font-mono text-gray-400">
        SSR: {Object.entries(timings).map(([k, v]) => `${k}=${v}ms`).join(" · ")}
      </div>
      {displayError && (
        <div className="mx-6 mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          <strong>API error:</strong> {displayError}
        </div>
      )}
      <OpsTabs flights={data.flights} bakerPprAirports={bakerPprAirports} advertisedPrices={advertisedPrices} mxNotes={mxNotes} swimFlow={swimFlow} />
    </>
  );
}
