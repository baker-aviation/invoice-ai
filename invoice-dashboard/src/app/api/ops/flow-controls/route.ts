import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { getAirportInfo } from "@/lib/airportCoords";
import navFixSeed from "@/lib/navFixes.json";

export const dynamic = "force-dynamic";

/**
 * Returns active FAA flow control events (reroutes, CTOPs, AFPs)
 * with resolved waypoint coordinates for map rendering.
 */

export type FlowControlLine = {
  id: string;
  event_type: string;
  name: string;
  subject: string;
  status: string;
  severity: string;
  /** Origin airports/centers */
  origins: string[];
  /** Destination airports/centers */
  destinations: string[];
  /** Resolved waypoint coordinates [[lat, lon], ...] */
  waypoints: [number, number][];
  /** Waypoint names for tooltip */
  waypointNames: string[];
  /** Start/end times */
  effective_at: string | null;
  expires_at: string | null;
  /** TMI ID (e.g., RRDCC509) */
  tmiId: string | null;
  /** FCA name if applicable */
  fcaName: string | null;
};

export type FlowControlsResponse = {
  ok: boolean;
  lines: FlowControlLine[];
  /** Airport-level flow events (GDP, ground stops) */
  events: {
    id: string;
    event_type: string;
    airport_icao: string | null;
    subject: string;
    severity: string;
    effective_at: string | null;
    expires_at: string | null;
  }[];
};

// ── Waypoint resolution ──

const fixCache = new Map<string, [number, number]>(
  Object.entries(navFixSeed as unknown as Record<string, [number, number]>)
);

/** Resolve a waypoint/fix/navaid/airport to lat/lon */
function resolveWaypoint(name: string): [number, number] | null {
  // Check fix cache first
  const cached = fixCache.get(name);
  if (cached) return cached;

  // Check airport database (handles both IATA and ICAO)
  const airport = getAirportInfo(name) ?? getAirportInfo(`K${name}`);
  if (airport) {
    const coords: [number, number] = [airport.lat, airport.lon];
    fixCache.set(name, coords);
    return coords;
  }

  return null;
}

/** Fetch missing waypoints from aviationweather.gov and cache them */
async function resolveUnknownWaypoints(names: string[]): Promise<void> {
  const unknown = names.filter((n) => !fixCache.has(n) && !getAirportInfo(n) && !getAirportInfo(`K${n}`));
  if (unknown.length === 0) return;

  try {
    const ids = unknown.join(",");
    const res = await fetch(
      `https://aviationweather.gov/api/data/fix?ids=${ids}&format=json`,
      { cache: "no-store" },
    );
    if (!res.ok) return;
    const data = await res.json();
    for (const item of data) {
      if (item.id && item.lat != null && item.lon != null) {
        fixCache.set(item.id, [item.lat, item.lon]);
      }
    }
  } catch {
    // Non-critical — lines will just have gaps
  }
}

// ── XML parsing helpers ──

function extractAllValues(xml: string, tag: string): string[] {
  // Match both namespaced and non-namespaced tags
  const re = new RegExp(`<(?:\\w+:)?${tag}>([^<]+)</(?:\\w+:)?${tag}>`, "g");
  const values: string[] = [];
  let m;
  while ((m = re.exec(xml)) !== null) {
    values.push(m[1].trim());
  }
  return values;
}

function extractFirstValue(xml: string, tag: string): string | null {
  const re = new RegExp(`<(?:\\w+:)?${tag}>([^<]+)</(?:\\w+:)?${tag}>`);
  const m = xml.match(re);
  return m ? m[1].trim() : null;
}

function extractAirportsFromList(xml: string, listTag: string): string[] {
  const listRe = new RegExp(`<(?:\\w+:)?${listTag}>[\\s\\S]*?</(?:\\w+:)?${listTag}>`);
  const listMatch = xml.match(listRe);
  if (!listMatch) return [];
  const airports = extractAllValues(listMatch[0], "airport");
  const centers = extractAllValues(listMatch[0], "center");
  return [...airports, ...centers];
}

export async function GET() {
  try {
    const supa = createServiceClient();

    // Fetch active flow events
    const { data, error } = await supa
      .from("swim_flow_control")
      .select("id, event_type, airport_icao, status, severity, subject, body, effective_at, expires_at, raw_xml")
      .eq("status", "active")
      .order("created_at", { ascending: false })
      .limit(50);

    if (error || !data) {
      return NextResponse.json({ ok: false, lines: [], events: [] } satisfies FlowControlsResponse);
    }

    const lines: FlowControlLine[] = [];
    const events: FlowControlsResponse["events"] = [];

    // Collect all waypoints first for batch resolution
    const allWaypoints = new Set<string>();
    const reroutes = data.filter(
      (d) => d.event_type === "REROUTE" || d.event_type === "AFP" || d.event_type === "CTOP",
    );

    for (const row of reroutes) {
      const xml = row.raw_xml ?? "";
      const waypoints = extractAllValues(xml, "waypoint");
      for (const wp of waypoints) allWaypoints.add(wp);
    }

    // Resolve unknown waypoints in one batch
    await resolveUnknownWaypoints([...allWaypoints]);

    // Process reroutes into lines
    for (const row of reroutes) {
      const xml = row.raw_xml ?? "";

      // Extract reroute metadata
      const rerouteName = extractFirstValue(xml, "rerouteName") ?? row.subject;
      const tmiId = extractFirstValue(xml, "tmiId") ?? null;
      const fcaName = extractFirstValue(xml, "fcaName") ?? null;
      const tmiStatus = extractFirstValue(xml, "tmiStatus");

      // Skip deleted TMIs
      if (tmiStatus === "DELETED") continue;

      // Extract waypoints and resolve coordinates
      const waypointNames = extractAllValues(xml, "waypoint");
      const waypoints: [number, number][] = [];
      const resolvedNames: string[] = [];

      for (const wp of waypointNames) {
        const coords = resolveWaypoint(wp);
        if (coords) {
          waypoints.push(coords);
          resolvedNames.push(wp);
        }
      }

      // Need at least 2 points to draw a line
      if (waypoints.length < 2) continue;

      // Extract origin/destination lists
      const origins = extractAirportsFromList(xml, "originList");
      const destinations = extractAirportsFromList(xml, "destinList");

      lines.push({
        id: row.id,
        event_type: row.event_type,
        name: rerouteName,
        subject: row.subject,
        status: row.status,
        severity: row.severity,
        origins,
        destinations,
        waypoints,
        waypointNames: resolvedNames,
        effective_at: row.effective_at,
        expires_at: row.expires_at,
        tmiId,
        fcaName,
      });
    }

    // Collect airport-level events (GDP, ground stops)
    for (const row of data) {
      if (row.event_type === "GDP" || row.event_type === "GROUND_STOP" || row.event_type === "DEICING") {
        events.push({
          id: row.id,
          event_type: row.event_type,
          airport_icao: row.airport_icao,
          subject: row.subject,
          severity: row.severity,
          effective_at: row.effective_at,
          expires_at: row.expires_at,
        });
      }
    }

    return NextResponse.json(
      { ok: true, lines, events } satisfies FlowControlsResponse,
      { headers: { "Cache-Control": "public, max-age=120, stale-while-revalidate=180" } },
    );
  } catch (err) {
    console.error("[flow-controls] Error:", err);
    return NextResponse.json({ ok: false, lines: [], events: [] } satisfies FlowControlsResponse, { status: 500 });
  }
}
