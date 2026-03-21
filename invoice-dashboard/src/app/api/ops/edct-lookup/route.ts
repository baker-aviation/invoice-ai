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
  edct_time: string | null;           // ISO string
  filed_departure: string | null;     // ISO string
  control_element: string | null;
  cancelled: boolean;
  delay_minutes: number | null;
  raw_text: string;
  query: { callsign: string; dept: string; arr: string };
}

/** FAA expects 3-letter codes (no K prefix) for US airports */
function stripK(code: string): string {
  const u = code.toUpperCase();
  if (u.length === 4 && u.startsWith("K")) return u.slice(1);
  return u;
}

/** Parse FAA datetime "03/21/2026 16:40" → ISO string */
function parseFaaDateTime(s: string): string | null {
  const m = s.match(/(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})/);
  if (!m) return null;
  const [, mo, dd, yyyy, hh, mm] = m;
  return `${yyyy}-${mo}-${dd}T${hh}:${mm}:00Z`;
}

async function lookupSingleEdct(flight: FlightInput): Promise<FaaEdctResult> {
  const dept = stripK(flight.dept);
  const arr = stripK(flight.arr);

  const result: FaaEdctResult = {
    callsign: flight.callsign,
    tail: flight.tail,
    origin: flight.dept,
    destination: flight.arr,
    found: false,
    edct_time: null,
    filed_departure: null,
    control_element: null,
    cancelled: false,
    delay_minutes: null,
    raw_text: "",
    query: { callsign: flight.callsign, dept, arr },
  };

  try {
    const res = await fetch("https://www.fly.faa.gov/edct/showEDCT", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `callsign=${encodeURIComponent(flight.callsign)}&dept=${encodeURIComponent(dept)}&arr=${encodeURIComponent(arr)}`,
    });

    if (!res.ok) {
      result.raw_text = `HTTP ${res.status}`;
      return result;
    }

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

    // Check for "found X record(s)"
    if (!text.includes("record(s) matching")) {
      return result;
    }

    result.found = true;

    // FAA table format: EDCT | Filed Departure Time | Control Element | Flight Cancelled?
    // Values like: 03/21/2026 16:40 | 03/21/2026 16:00 | FCAJXW | No
    const datetimePattern = /(\d{2}\/\d{2}\/\d{4}\s+\d{2}:\d{2})/g;
    const dateTimes = [...text.matchAll(datetimePattern)].map((m) => m[1]);

    if (dateTimes.length >= 2) {
      result.edct_time = parseFaaDateTime(dateTimes[0]);
      result.filed_departure = parseFaaDateTime(dateTimes[1]);

      // Calculate delay
      if (result.edct_time && result.filed_departure) {
        const edctMs = new Date(result.edct_time).getTime();
        const filedMs = new Date(result.filed_departure).getTime();
        result.delay_minutes = Math.round((edctMs - filedMs) / 60000);
      }
    } else if (dateTimes.length === 1) {
      result.edct_time = parseFaaDateTime(dateTimes[0]);
    }

    // Extract control element (e.g. FCAJXW)
    const ctrlMatch = text.match(/(?:Control Element|FCAJXW|FCA\w+|GDP\w*|GS\w*|AFP\w*)\s*/i);
    // More robust: look for the text between the second datetime and "No"/"Yes"
    const afterTimes = text.split(dateTimes[dateTimes.length - 1] ?? "").pop() ?? "";
    const ctrlParts = afterTimes.trim().split(/\s+/);
    if (ctrlParts.length >= 1 && ctrlParts[0] && !["No", "Yes", "Notes:", "EDCT"].includes(ctrlParts[0])) {
      result.control_element = ctrlParts[0];
    }

    // Check cancelled
    result.cancelled = text.includes("Yes") && text.indexOf("Yes") > text.indexOf(dateTimes[dateTimes.length - 1] ?? "");

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

  // Get tail → callsign mapping from ics_sources
  const supa = createServiceClient();
  const { data: icsSources } = await supa
    .from("ics_sources")
    .select("label, callsign")
    .not("callsign", "is", null);

  const callsignMap = new Map<string, string>();
  for (const s of icsSources ?? []) {
    if (s.label && s.callsign) {
      callsignMap.set(s.label.toUpperCase(), s.callsign.toUpperCase());
    }
  }

  // Override callsigns with the real mapping
  for (const f of flights) {
    const mapped = callsignMap.get(f.tail.toUpperCase());
    if (mapped) f.callsign = mapped;
  }

  // Fire all lookups in parallel
  const results = await Promise.all(flights.map(lookupSingleEdct));

  const found = results.filter((r) => r.found);

  // Store any found EDCTs as ops_alerts (upsert by source_message_id to avoid duplicates)
  // Skip stale EDCTs (more than 2 hours in the past) and cancelled ones
  const now = Date.now();
  const twoHoursAgo = now - 2 * 3600_000;

  if (found.length > 0) {
    for (const edct of found) {
      if (edct.cancelled) continue;
      if (edct.edct_time && new Date(edct.edct_time).getTime() < twoHoursAgo) continue;

      const sourceId = `faa-edct-${edct.callsign}-${edct.origin}-${edct.destination}`;
      const delayStr = edct.delay_minutes != null ? `${edct.delay_minutes}min delay` : "";
      const ctrlStr = edct.control_element ? ` — ${edct.control_element}` : "";

      await supa.from("ops_alerts").upsert({
        source_message_id: sourceId,
        alert_type: "EDCT",
        severity: "warning",
        tail_number: edct.tail,
        departure_icao: edct.origin,
        arrival_icao: edct.destination,
        subject: `FAA EDCT: ${edct.callsign} ${edct.origin}→${edct.destination}`,
        body: `EDCT ${edct.edct_time ? new Date(edct.edct_time).toISOString().slice(11, 16) + "Z" : "?"} (${delayStr}${ctrlStr})`,
        edct_time: edct.edct_time,
        original_departure_time: edct.filed_departure,
        raw_data: { faa_edct: edct },
      }, { onConflict: "source_message_id" });
    }
  }

  // Count only current (non-stale, non-cancelled) as "found" for the UI
  const current = found.filter((r) =>
    !r.cancelled && (!r.edct_time || new Date(r.edct_time).getTime() >= twoHoursAgo)
  );

  return NextResponse.json({
    ok: true,
    checked: results.length,
    found: current.length,
    stale: found.length - current.length,
    results,
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
