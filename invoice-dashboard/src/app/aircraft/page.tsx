export const dynamic = "force-dynamic";

import { Topbar } from "@/components/Topbar";
import { createServiceClient } from "@/lib/supabase/service";
import AircraftListClient from "./AircraftListClient";

export default async function AircraftPage() {
  const supa = createServiceClient();

  const [trackerRes, sourcesRes, docsRes] = await Promise.all([
    supa
      .from("aircraft_tracker")
      .select("tail_number, aircraft_type, overall_status, kow_callsign, notes")
      .order("tail_number"),
    supa
      .from("ics_sources")
      .select("label, aircraft_type, enabled, callsign, last_sync_at, last_sync_ok")
      .eq("enabled", true)
      .order("label"),
    supa
      .from("jetinsight_documents")
      .select("entity_id")
      .eq("entity_type", "aircraft"),
  ]);

  // Build doc counts per tail
  const docCounts = new Map<string, number>();
  for (const d of docsRes.data ?? []) {
    docCounts.set(d.entity_id, (docCounts.get(d.entity_id) ?? 0) + 1);
  }

  // Merge tracker + ics_sources into a single list
  const tailSet = new Set<string>();
  const aircraft: Array<{
    tail_number: string;
    aircraft_type: string | null;
    overall_status: string | null;
    kow_callsign: string | null;
    notes: string | null;
    ics_enabled: boolean;
    last_sync_ok: boolean | null;
    doc_count: number;
  }> = [];

  // Start from tracker entries
  for (const t of trackerRes.data ?? []) {
    tailSet.add(t.tail_number);
    const src = sourcesRes.data?.find((s) => s.label === t.tail_number);
    aircraft.push({
      tail_number: t.tail_number,
      aircraft_type: t.aircraft_type,
      overall_status: t.overall_status,
      kow_callsign: t.kow_callsign,
      notes: t.notes,
      ics_enabled: src?.enabled ?? false,
      last_sync_ok: src?.last_sync_ok ?? null,
      doc_count: docCounts.get(t.tail_number) ?? 0,
    });
  }

  // Add any ICS sources not in tracker
  for (const s of sourcesRes.data ?? []) {
    if (!s.label?.startsWith("N")) continue;
    if (tailSet.has(s.label)) continue;
    aircraft.push({
      tail_number: s.label,
      aircraft_type: s.aircraft_type,
      overall_status: null,
      kow_callsign: s.callsign,
      notes: null,
      ics_enabled: true,
      last_sync_ok: s.last_sync_ok,
      doc_count: docCounts.get(s.label) ?? 0,
    });
  }

  // Sort by tail
  aircraft.sort((a, b) => a.tail_number.localeCompare(b.tail_number));

  return (
    <>
      <Topbar title="Aircraft" />
      <AircraftListClient aircraft={aircraft} />
    </>
  );
}
