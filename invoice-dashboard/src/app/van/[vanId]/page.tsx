import { createServiceClient } from "@/lib/supabase/service";
import { FIXED_VAN_ZONES } from "@/lib/maintenanceData";
import { fetchMxNotes } from "@/lib/opsApi";
import { notFound } from "next/navigation";
import VanDriverClient from "./VanDriverClient";

export const dynamic = "force-dynamic";

/** Today's date in ET (YYYY-MM-DD). */
function todayEtDate(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

export default async function VanPage({ params }: { params: Promise<{ vanId: string }> }) {
  const { vanId: vanIdStr } = await params;
  const vanId = parseInt(vanIdStr, 10);

  // Validate vanId
  const zone = FIXED_VAN_ZONES.find((z) => z.vanId === vanId);
  if (!zone) return notFound();

  // Fetch flights from Supabase (same query as ops page)
  const supa = createServiceClient();
  const now = new Date();
  const past = new Date(now.getTime() - 12 * 60 * 60 * 1000).toISOString();
  const future = new Date(now.getTime() + 36 * 60 * 60 * 1000).toISOString();

  const { data: flights } = await supa
    .from("flights")
    .select("*")
    .gte("scheduled_departure", past)
    .lte("scheduled_departure", future)
    .order("scheduled_departure", { ascending: true });

  // Check for a published schedule for this van today
  const today = todayEtDate();
  const { data: published } = await supa
    .from("van_published_schedules")
    .select("flight_ids, synthetic_flights, published_at")
    .eq("van_id", vanId)
    .eq("schedule_date", today)
    .maybeSingle();

  const publishedFlightIds = published?.flight_ids ?? null;
  const publishedAtStr = published?.published_at ?? null;
  const syntheticFlights: { id: string; tail: string; airport: string | null }[] =
    (published?.synthetic_flights as any[]) ?? [];

  const mxNotes = await fetchMxNotes().catch(() => []);

  // Fetch airport overrides from draft overrides (e.g. N201HR → VNY)
  const { data: draftRow } = await supa
    .from("van_draft_overrides")
    .select("airport_overrides")
    .eq("date", today)
    .maybeSingle();
  const airportOverrides: [string, string][] = (draftRow?.airport_overrides as [string, string][]) ?? [];

  // Build FBO lookup from trip_salespersons (tail:dest_icao → fbo name)
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
    <VanDriverClient
      vanId={vanId}
      zone={zone}
      initialFlights={flights ?? []}
      publishedFlightIds={publishedFlightIds}
      publishedAt={publishedAtStr}
      syntheticFlights={syntheticFlights}
      mxNotes={mxNotes}
      fboMap={fboMap}
      airportOverrides={airportOverrides}
    />
  );
}
