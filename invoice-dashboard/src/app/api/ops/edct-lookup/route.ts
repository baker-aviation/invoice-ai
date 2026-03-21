import { NextRequest, NextResponse } from "next/server";
import { requireAuth, isAuthed, isRateLimited } from "@/lib/api-auth";
import { createServiceClient } from "@/lib/supabase/service";

export const dynamic = "force-dynamic";

/**
 * POST /api/ops/edct-lookup
 *
 * Batch-checks all flights for active EDCTs from FAA's fly.faa.gov/edct/ tool.
 * Fires all lookups in parallel, stores any results found in ops_alerts.
 *
 * Body: { flights: [{ callsign, tail, dept, arr }] }
 */

interface FlightInput {
  callsign: string;
  tail: string;
  dept: string;
  arr: string;
}

interface FaaEdctResult {
  callsign: string;
  tail: string;
  origin: string;
  destination: string;
  found: boolean;
  edct_time: string | null;
  original_departure: string | null;
  delay_minutes: number | null;
  program: string | null;
  raw_text: string;
}

async function lookupSingleEdct(flight: FlightInput): Promise<FaaEdctResult> {
  const result: FaaEdctResult = {
    callsign: flight.callsign,
    tail: flight.tail,
    origin: flight.dept,
    destination: flight.arr,
    found: false,
    edct_time: null,
    original_departure: null,
    delay_minutes: null,
    program: null,
    raw_text: "",
  };

  try {
    const res = await fetch("https://www.fly.faa.gov/edct/showEDCT", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `callsign=${encodeURIComponent(flight.callsign)}&dept=${encodeURIComponent(flight.dept)}&arr=${encodeURIComponent(flight.arr)}`,
    });

    if (!res.ok) return result;

    const html = await res.text();
    const text = html
      .replace(/<[^>]*>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    result.raw_text = text.slice(0, 2000);

    if (text.includes("No EDCT information is available")) {
      return result;
    }

    result.found = true;

    // Parse table data: look for Zulu time patterns
    // FAA result table columns: Call Sign | Origin | Dest | EDCT | Orig Dep | Delay(min) | Program
    const timePattern = /(\d{4}Z)\s+(\d{4}Z)\s+(\d+)\s+([\w\s-]+?)(?:\s+Notes|\s+EDCT\s+-)/;
    const tableMatch = text.match(timePattern);
    if (tableMatch) {
      result.original_departure = tableMatch[1];
      result.edct_time = tableMatch[2];
      result.delay_minutes = parseInt(tableMatch[3], 10);
      result.program = tableMatch[4].trim();
      return result;
    }

    // Alternative: look for sequential Zulu times
    const zuluTimes = text.match(/\b(\d{4}Z)\b/g);
    if (zuluTimes && zuluTimes.length >= 2) {
      result.original_departure = zuluTimes[0];
      result.edct_time = zuluTimes[1];
    } else if (zuluTimes?.length === 1) {
      result.edct_time = zuluTimes[0];
    }

    // Extract delay
    const delayMatch = text.match(/(\d+)\s*(?:min|minutes)/i);
    if (delayMatch) result.delay_minutes = parseInt(delayMatch[1], 10);

    // Extract program
    const progMatch = text.match(/(?:GDP|GS|AFP|APREQ|Ground Stop|Ground Delay)[:\s]*([\w\s-]*)/i);
    if (progMatch) result.program = progMatch[0].trim();

    return result;
  } catch {
    return result;
  }
}

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;
  if (await isRateLimited(auth.userId, 10)) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  const body = await req.json().catch(() => null);
  const flights: FlightInput[] = body?.flights;

  if (!flights?.length) {
    return NextResponse.json({ error: "flights array is required" }, { status: 400 });
  }

  // Fire all lookups in parallel
  const results = await Promise.all(flights.map(lookupSingleEdct));

  const found = results.filter((r) => r.found);

  // Store any found EDCTs as ops_alerts (upsert by source_message_id to avoid duplicates)
  if (found.length > 0) {
    const supa = createServiceClient();

    for (const edct of found) {
      const sourceId = `faa-edct-${edct.callsign}-${edct.origin}-${edct.destination}`;

      // Build edct_time as full ISO if we have it
      let edctTimeIso: string | null = null;
      if (edct.edct_time) {
        const now = new Date();
        const timeStr = edct.edct_time.replace("Z", "");
        const hh = timeStr.slice(0, 2);
        const mm = timeStr.slice(2, 4);
        const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(),
          parseInt(hh), parseInt(mm)));
        // If the time is way in the past, it might be tomorrow
        if (d.getTime() < now.getTime() - 12 * 3600_000) {
          d.setUTCDate(d.getUTCDate() + 1);
        }
        edctTimeIso = d.toISOString();
      }

      await supa.from("ops_alerts").upsert({
        source_message_id: sourceId,
        alert_type: "EDCT",
        severity: "warning",
        tail_number: edct.tail,
        departure_icao: edct.origin,
        arrival_icao: edct.destination,
        subject: `FAA EDCT: ${edct.callsign} ${edct.origin}→${edct.destination}`,
        body: edct.program
          ? `EDCT ${edct.edct_time} (${edct.delay_minutes ?? "?"}min delay) — ${edct.program}`
          : `EDCT ${edct.edct_time}`,
        edct_time: edctTimeIso,
        original_departure_time: edct.original_departure
          ? (() => {
              const now = new Date();
              const t = edct.original_departure!.replace("Z", "");
              const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(),
                parseInt(t.slice(0, 2)), parseInt(t.slice(2, 4))));
              return d.toISOString();
            })()
          : null,
        raw_data: { faa_edct: edct },
      }, { onConflict: "source_message_id" });
    }
  }

  return NextResponse.json({
    ok: true,
    checked: results.length,
    found: found.length,
    results: results.map(({ raw_text, ...r }) => r),
  });
}

// Keep GET for single lookups
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (!isAuthed(auth)) return auth.error;

  const { searchParams } = new URL(req.url);
  const callsign = searchParams.get("callsign");
  const dept = searchParams.get("dept");
  const arr = searchParams.get("arr");

  if (!callsign || !dept || !arr) {
    return NextResponse.json({ error: "callsign, dept, and arr are required" }, { status: 400 });
  }

  const result = await lookupSingleEdct({ callsign, tail: "", dept, arr });

  return NextResponse.json({
    ok: true,
    found: result.found,
    callsign,
    origin: dept,
    destination: arr,
    ...(result.found ? { edct: result } : { message: "No active EDCT found" }),
  });
}
