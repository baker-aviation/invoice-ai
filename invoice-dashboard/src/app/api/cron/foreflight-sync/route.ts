import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const FF_BASE = "https://public-api.foreflight.com/public/api";

function apiKey(): string {
  const key = process.env.FOREFLIGHT_API_KEY;
  if (!key) throw new Error("FOREFLIGHT_API_KEY not set");
  return key;
}

/**
 * GET /api/cron/foreflight-sync
 *
 * Polls ForeFlight /Flights/modified for recent changes and stores them
 * in foreflight_webhook_events. Runs every 2-5 minutes via cron.
 *
 * Uses the most recent event's received_at as the sinceDate to avoid
 * re-processing. Falls back to 10 minutes ago if no events exist.
 */
export async function GET(req: NextRequest) {
  // Cron routes are already exempted by middleware — no extra auth needed

  const supa = createServiceClient();

  // Get the last sync time from most recent event
  const { data: lastEvent } = await supa
    .from("foreflight_webhook_events")
    .select("received_at")
    .order("received_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  // Default to 10 minutes ago if no events yet
  const sinceDate = lastEvent?.received_at
    ? new Date(lastEvent.received_at).toISOString()
    : new Date(Date.now() - 10 * 60_000).toISOString();

  console.log(`[ff-sync] Polling modified flights since ${sinceDate}`);

  let modified: Array<Record<string, unknown>>;
  try {
    const res = await fetch(
      `${FF_BASE}/Flights/modified?sinceDate=${encodeURIComponent(sinceDate)}`,
      { headers: { "x-api-key": apiKey() } },
    );
    if (!res.ok) {
      const text = await res.text();
      return NextResponse.json({ error: `ForeFlight ${res.status}: ${text.slice(0, 200)}` }, { status: 502 });
    }
    const data = await res.json();
    modified = Array.isArray(data) ? data : data.flights ?? [];
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }

  if (modified.length === 0) {
    return NextResponse.json({ message: "No changes", since: sinceDate });
  }

  console.log(`[ff-sync] Found ${modified.length} modified flights`);

  // Deduplicate — skip flights we already have an event for with the same timeUpdated
  const flightIds = modified.map(f => f.flightId as string).filter(Boolean);
  const { data: existing } = await supa
    .from("foreflight_webhook_events")
    .select("flight_id, received_at")
    .in("flight_id", flightIds)
    .order("received_at", { ascending: false });

  const existingMap = new Map<string, string>();
  for (const e of existing ?? []) {
    if (!existingMap.has(e.flight_id)) {
      existingMap.set(e.flight_id, e.received_at);
    }
  }

  let inserted = 0;
  let skipped = 0;

  for (const flight of modified) {
    const flightId = flight.flightId as string;
    if (!flightId) continue;

    const timeUpdated = flight.timeUpdated as string;
    const lastSeen = existingMap.get(flightId);

    // Skip if we already have this flight and it hasn't been updated since
    if (lastSeen && timeUpdated && new Date(timeUpdated) <= new Date(lastSeen)) {
      skipped++;
      continue;
    }

    // Determine change type from context
    let changeType = "Flight";
    const filingInfo = flight.filingInfo as Record<string, unknown> | undefined;
    const atcMessages = (filingInfo?.atcMessages ?? []) as unknown[];
    if (atcMessages.length > 0) changeType = "Filing";

    // Build changed fields from what we can infer
    const changedFields: string[] = [];
    if (flight.crew && (flight.crew as unknown[]).length > 0) changedFields.push("Crew");
    if (flight.filingStatus === "Filed") changedFields.push("Filing");
    if (flight.released) changedFields.push("Released");

    const { error } = await supa.from("foreflight_webhook_events").insert({
      flight_id: flightId,
      change_type: changeType,
      changed_fields: changedFields,
      flight_data: flight,
    });

    if (error) {
      console.error(`[ff-sync] Insert error for ${flightId}:`, error.message);
    } else {
      inserted++;
    }
  }

  console.log(`[ff-sync] Done: ${inserted} inserted, ${skipped} skipped (unchanged)`);

  return NextResponse.json({
    since: sinceDate,
    found: modified.length,
    inserted,
    skipped,
  });
}
