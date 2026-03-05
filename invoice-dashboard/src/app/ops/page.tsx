export const dynamic = "force-dynamic";

import { Topbar } from "@/components/Topbar";
import { AutoRefresh } from "@/components/AutoRefresh";
import { fetchFlights } from "@/lib/opsApi";
import { createClient } from "@/lib/supabase/server";
import OpsTabs from "./OpsTabs";

export default async function OpsPage() {
  // Get current user for per-user alert dismissals
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  const userId = user?.id;

  let error: string | null = null;
  const data = await fetchFlights({ lookahead_hours: 720, userId }).catch((e) => {
    error = String(e);
    return { ok: false, flights: [] as any[], count: 0, error: null as string | null };
  });

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
      <OpsTabs flights={data.flights} />
    </>
  );
}
