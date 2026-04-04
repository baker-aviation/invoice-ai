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

  const { data: flightsRaw } = await supa
    .from("flights")
    .select("*")
    .gte("scheduled_departure", past)
    .lte("scheduled_departure", future)
    .order("scheduled_departure", { ascending: true });

  const flights = flightsRaw ?? [];

  // Check for a published schedule for this van today
  const today = todayEtDate();
  const { data: published } = await supa
    .from("van_published_schedules")
    .select("flight_ids, synthetic_flights, published_at")
    .eq("van_id", vanId)
    .eq("schedule_date", today)
    .maybeSingle();

  const publishedFlightIds = published?.flight_ids ?? null;

  // Backfill any published flights that fell outside the time window
  // (e.g. flights that departed yesterday evening but arrive overnight)
  if (publishedFlightIds && publishedFlightIds.length > 0) {
    const loadedIds = new Set(flights.map((f: any) => f.id));
    const missingIds = (publishedFlightIds as string[]).filter((id: string) => !loadedIds.has(id) && !id.startsWith("unsched_"));
    if (missingIds.length > 0) {
      const { data: extraFlights } = await supa
        .from("flights")
        .select("*")
        .in("id", missingIds);
      if (extraFlights) {
        flights.push(...extraFlights);
      }
    }
  }
  const publishedAtStr = published?.published_at ?? null;
  const syntheticFlights: { id: string; tail: string; airport: string | null }[] =
    (published?.synthetic_flights as any[]) ?? [];

  const mxNotes = await fetchMxNotes().catch(() => []);

  // Fetch draft overrides (flight reassignments, removals, airport overrides)
  const { data: draftRow } = await supa
    .from("van_draft_overrides")
    .select("overrides, removals, airport_overrides, unscheduled")
    .eq("date", today)
    .maybeSingle();
  const airportOverrides: [string, string][] = (draftRow?.airport_overrides as [string, string][]) ?? [];
  const flightOverrides: [string, number][] = (draftRow?.overrides as [string, number][]) ?? [];
  const removals: string[] = (draftRow?.removals as string[]) ?? [];
  const unscheduledOverrides: [string, number][] = (draftRow?.unscheduled as [string, number][]) ?? [];

  // Build FBO lookup from flights table (populated by JetInsight scraper)
  const { data: fboRows } = await supa
    .from("flights")
    .select("tail_number, arrival_icao, destination_fbo")
    .not("destination_fbo", "is", null)
    .gte("scheduled_departure", past)
    .lte("scheduled_departure", future);

  const fboMap: Record<string, string> = {};
  for (const row of fboRows ?? []) {
    if (row.tail_number && row.arrival_icao && row.destination_fbo) {
      fboMap[`${row.tail_number}:${row.arrival_icao}`] = row.destination_fbo;
    }
  }

  return (
    <VanDriverClient
      vanId={vanId}
      zone={zone}
      initialFlights={flights}
      publishedFlightIds={publishedFlightIds}
      publishedAt={publishedAtStr}
      syntheticFlights={syntheticFlights}
      mxNotes={mxNotes}
      fboMap={fboMap}
      airportOverrides={airportOverrides}
      flightOverrides={flightOverrides}
      removals={removals}
      unscheduledOverrides={unscheduledOverrides}
    />
  );
}
