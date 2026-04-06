export const dynamic = "force-dynamic";

import { Topbar } from "@/components/Topbar";
import { AutoRefresh } from "@/components/AutoRefresh";
import { fetchFlightsLite, fetchMxNotes, fetchSwimFlowControl } from "@/lib/opsApi";
import { fetchAdvertisedPrices } from "@/lib/invoiceApi";
import { createClient } from "@/lib/supabase/server";
import { loadFboHours, type FboHoursInfo } from "@/lib/fboHours";
import OpsTabs from "../OpsTabs";

// Fetch ops data on each request (no unstable_cache — payload exceeds
// Vercel's 2 MB cache-item limit when flights + alerts are large).
async function getOpsData() {
  const [data, advertisedPrices, mxNotes, swimFlow, pprRows, fboHoursDb] = await Promise.all([
    fetchFlightsLite({ lookahead_hours: 48, lookback_hours: 48 }).catch((e) => {
      console.error("[ops/page] fetchFlightsLite error:", e);
      return { ok: false, flights: [] as any[], count: 0, suppressedRunwayNotamIds: [] as string[], allRunwaysClosedAlerts: [] as any[], error: String(e) };
    }),
    fetchAdvertisedPrices({ recentWeeks: 4 }).catch(() => []),
    fetchMxNotes().catch(() => []),
    fetchSwimFlowControl().catch(() => []),
    createClient().then((s) => s.from("baker_ppr_airports").select("icao")).then((r) => r.data).catch(() => []),
    loadFboHours().catch(() => new Map()),
  ]);
  // Serialize FBO hours map for client: ICAO → { is24hr, openMinutes, closeMinutes, hours }
  // Key by both KXXX and XXX formats so OpsBoard can match either
  const fboHoursForClient: Record<string, { is24hr: boolean; openMinutes: number | null; closeMinutes: number | null; hours: string }> = {};
  for (const [faaCode, entries] of fboHoursDb as Map<string, FboHoursInfo[]>) {
    // Use the "most permissive" FBO at each airport — if any is 24hr, treat airport as 24hr
    const any24 = entries.some((e: FboHoursInfo) => e.is24hr);
    if (any24) {
      fboHoursForClient[faaCode] = { is24hr: true, openMinutes: null, closeMinutes: null, hours: "24 hours" };
      fboHoursForClient[`K${faaCode}`] = fboHoursForClient[faaCode];
    } else {
      // Use the FBO with the widest hours (latest close)
      const best = entries.reduce((a, b) => {
        const aSpan = a.closeMinutes != null && a.openMinutes != null
          ? (a.closeMinutes > a.openMinutes ? a.closeMinutes - a.openMinutes : 1440 - a.openMinutes + a.closeMinutes) : 0;
        const bSpan = b.closeMinutes != null && b.openMinutes != null
          ? (b.closeMinutes > b.openMinutes ? b.closeMinutes - b.openMinutes : 1440 - b.openMinutes + b.closeMinutes) : 0;
        return bSpan > aSpan ? b : a;
      });
      const entry = { is24hr: false, openMinutes: best.openMinutes, closeMinutes: best.closeMinutes, hours: best.hours };
      fboHoursForClient[faaCode] = entry;
      fboHoursForClient[`K${faaCode}`] = entry;
    }
  }
  return { data, advertisedPrices, mxNotes, swimFlow, pprRows, fboHoursForClient };
}

export default async function OpsPage({ params }: { params: Promise<{ tab?: string[] }> }) {
  const { tab: tabSegments } = await params;
  const initialTab = tabSegments?.[0] ?? null;
  let error: string | null = null;
  const { data, advertisedPrices, mxNotes, swimFlow, pprRows, fboHoursForClient } = await getOpsData().catch((e) => {
    error = String(e);
    return {
      data: { ok: false, flights: [] as any[], count: 0, suppressedRunwayNotamIds: [] as string[], allRunwaysClosedAlerts: [] as any[], error: null as string | null },
      advertisedPrices: [],
      mxNotes: [],
      swimFlow: [],
      pprRows: [],
      fboHoursForClient: {} as Record<string, { is24hr: boolean; openMinutes: number | null; closeMinutes: number | null; hours: string }>,
    };
  });
  const bakerPprAirports: string[] = (pprRows ?? []).map((r: { icao: string }) => r.icao);

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
      <OpsTabs flights={data.flights} bakerPprAirports={bakerPprAirports} advertisedPrices={advertisedPrices} mxNotes={mxNotes} swimFlow={swimFlow} initialTab={initialTab} fboHoursMap={fboHoursForClient} />
    </>
  );
}
